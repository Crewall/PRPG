import type { StoryStore } from '../db/stores/storyStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import type { MemoryObject } from '../memory/model.ts';

export interface NpcServiceDeps {
  stories: StoryStore;
  agents: AgentStore;
  memory: MemoryStore;
  jobs: JobStore;
  registry: LlmRegistry;
  events: EventBus;
}

function npcProfile(deps: NpcServiceDeps, storyId: string): string {
  const story = deps.stories.getStory(storyId);
  return story?.settings.roles.npc ?? deps.registry.getForRole('npc').name;
}

/** Resolve an NPC memory object by name/alias (alias-aware, exact/normalized). */
export function resolveNpc(deps: NpcServiceDeps, storyId: string, name: string): MemoryObject | undefined {
  return deps.memory.findByName(storyId, name);
}

/**
 * Promote a character to a "major" NPC: ensure an active NPC session exists and
 * add it to the current scene's present cast. Idempotent.
 */
export function promoteNpc(deps: NpcServiceDeps, storyId: string, objectId: string): boolean {
  const obj = deps.memory.getObject(objectId);
  if (!obj || obj.storyId !== storyId) return false;
  const isNew = !deps.agents.listSessions(storyId).some((s) => s.role === 'npc' && s.npcObjectId === objectId);
  const session = deps.agents.ensureSession(storyId, 'npc', npcProfile(deps, storyId), objectId);
  if (session.state !== 'active') deps.agents.setState(session.id, 'active');
  const story = deps.stories.getStory(storyId);
  if (story?.currentSceneId) deps.stories.addActiveNpc(story.currentSceneId, objectId);
  // First elevation → build the character dossier (persona, looks, belongings,
  // skills, state, goals) as memory facts on the object. Async, off the player
  // path; the per-turn memory scribe keeps it updated afterwards.
  if (isNew) deps.jobs.enqueue('npc_dossier', { storyId, payload: { objectId } });
  deps.events.emit({ t: 'scene.changed', storyId, sceneId: story?.currentSceneId ?? '' });
  return true;
}

/** Demote an NPC back to storyteller-voiced: dormant its session, remove from scene. */
export function demoteNpc(deps: NpcServiceDeps, storyId: string, objectId: string): boolean {
  const story = deps.stories.getStory(storyId);
  const session = deps.agents.listSessions(storyId).find((s) => s.role === 'npc' && s.npcObjectId === objectId);
  if (session) deps.agents.setState(session.id, 'dormant');
  if (story?.currentSceneId) deps.stories.removeActiveNpc(story.currentSceneId, objectId);
  deps.events.emit({ t: 'scene.changed', storyId, sceneId: story?.currentSceneId ?? '' });
  return true;
}

/** npc_enter directive: resolve by name and promote (no-op if unknown — retried next turn). */
export function npcEnter(deps: NpcServiceDeps, storyId: string, name: string): boolean {
  const obj = resolveNpc(deps, storyId, name);
  if (!obj) return false;
  return promoteNpc(deps, storyId, obj.id);
}

/** npc_exit directive: resolve by name and demote. */
export function npcExit(deps: NpcServiceDeps, storyId: string, name: string): boolean {
  const obj = resolveNpc(deps, storyId, name);
  if (!obj) return false;
  return demoteNpc(deps, storyId, obj.id);
}

/** Is this character currently a present major NPC (has an active session)? */
export function isActiveNpc(deps: NpcServiceDeps, storyId: string, objectId: string): boolean {
  return deps.agents.listSessions(storyId).some((s) => s.role === 'npc' && s.npcObjectId === objectId && s.state === 'active');
}
