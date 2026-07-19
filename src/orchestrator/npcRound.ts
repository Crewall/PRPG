import type { StoryStore } from '../db/stores/storyStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { NpcProfileStore, NpcProfile } from '../db/stores/npcProfileStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { ContextBuilder, NpcRoundForWeave } from './contextBuilder.ts';
import { NpcAgent } from '../agents/npcAgent.ts';
import type { MemoryObject } from '../memory/model.ts';
import type { Story, Turn } from '../domain.ts';
import { logger } from '../util/logger.ts';

// NPC Story Mode (docs/09): the proactive NPC round. Every present NPC the
// mechanical gate lets through gets its personalized excerpt + the player's
// input, in parallel, BEFORE the storyteller writes — the replies are woven
// in a single storyteller pass.

export interface NpcRoundDeps {
  stories: StoryStore;
  agents: AgentStore;
  memory: MemoryStore;
  npcProfiles: NpcProfileStore;
  threadLog: ThreadLog;
  jobs: JobStore;
  registry: LlmRegistry;
  contexts: ContextBuilder;
}

// One present NPC's round result. `weave` is what the storyteller sees;
// `notes` (when the NPC acted and returned any) is persisted after the turn.
export interface NpcRoundOutcome {
  objectId: string;
  weave: NpcRoundForWeave;
  notes?: string;
}

/** Does `text` mention this character (name, alias, or a distinctive name word)? */
export function mentionsNpc(text: string, obj: Pick<MemoryObject, 'name' | 'aliases'>): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  const needles = new Set<string>();
  for (const raw of [obj.name, ...obj.aliases]) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    needles.add(n);
    // Multiword names also match by their distinctive words ("Guard Captain
    // Held" → "held") — a false positive only costs one NPC call, and a miss
    // self-heals next round via the narration mention.
    for (const word of n.split(/\s+/)) if (word.length >= 3) needles.add(word);
  }
  for (const needle of needles) {
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${esc}\\b`, 'i').test(hay)) return true;
  }
  return false;
}

/**
 * The mechanical skip gate: invoke an NPC only when the round plausibly
 * touches them — otherwise their call is skipped and the storyteller just
 * sees them as present-but-idle. Zero LLM cost to decide.
 */
export function shouldInvokeNpc(input: {
  obj: Pick<MemoryObject, 'name' | 'aliases'>;
  profile: NpcProfile | undefined;
  playerInput: string;
  lastNarration: string;
  turnIndex: number;
}): boolean {
  const { obj, profile, playerInput, lastNarration, turnIndex } = input;
  // No mind yet → they must act (and establish themselves).
  if (!profile || !profile.personality.trim()) return true;
  // Just (re-)entered — nothing witnessed last turn → act, and refresh notes.
  if (profile.lastPresentTurnIdx < turnIndex - 1) return true;
  // The player is talking to/about them.
  if (mentionsNpc(playerInput, obj)) return true;
  // The narrator put them in play last turn.
  if (mentionsNpc(lastNarration, obj)) return true;
  // They spoke or acted last round — a conversation/action is in flight.
  if (profile.lastActedTurnIdx >= turnIndex - 1) return true;
  return false;
}

/**
 * Run the round for every present NPC (gate-filtered, capped, parallel).
 * Never throws for an individual NPC: a failed call degrades to an
 * "unavailable" entry, a skipped NPC to a present-but-idle one.
 */
export async function runNpcRound(
  deps: NpcRoundDeps,
  story: Story,
  turn: Turn,
  playerInput: string,
  signal: AbortSignal,
): Promise<NpcRoundOutcome[]> {
  const scene = story.currentSceneId ? deps.stories.getScene(story.currentSceneId) : undefined;
  if (!scene?.activeNpcIds.length) return [];
  const s = story.settings.npcStories;

  const lastNarration =
    deps.stories
      .recentTurns(story.id, 3)
      .filter((t) => t.status === 'complete' && t.index < turn.index)
      .at(-1)?.narration ?? '';

  const present = scene.activeNpcIds
    .filter((oid) => oid !== story.settings.playerObjectId)
    .map((oid) => deps.memory.getObject(oid))
    .filter((o): o is MemoryObject => !!o);

  const outcomes: NpcRoundOutcome[] = [];
  const invoked: { obj: MemoryObject; profile: NpcProfile | undefined }[] = [];
  for (const obj of present) {
    const profile = deps.npcProfiles.get(obj.id);
    // A present NPC with no profile row needs a mind: create the row now (so
    // this enqueue never repeats) and let the seed job fill it async.
    if (!profile) {
      deps.npcProfiles.upsert(story.id, obj.id, {});
      deps.jobs.enqueue('npc_seed', { storyId: story.id, payload: { objectId: obj.id } });
    }
    if (invoked.length < s.maxNpcsPerRound && shouldInvokeNpc({ obj, profile, playerInput, lastNarration, turnIndex: turn.index })) {
      invoked.push({ obj, profile });
    } else {
      outcomes.push({ objectId: obj.id, weave: { name: obj.name, skipped: true } });
    }
  }

  const profileName = story.settings.roles.npc ?? deps.registry.getForRole('npc').name;
  const results = await Promise.all(
    invoked.map(async ({ obj, profile }): Promise<NpcRoundOutcome> => {
      try {
        const bound = deps.registry.getProfile(profileName);
        const session = deps.agents.ensureSession(story.id, 'npc', profileName, obj.id);
        if (session.state !== 'active') deps.agents.setState(session.id, 'active');
        const ctx = deps.contexts.forNpcRound(story, obj.id, {
          personality: profile?.personality ?? '',
          notes: profile?.notes ?? '',
          lastPresentTurnIdx: profile?.lastPresentTurnIdx ?? -1,
          playerInput,
          turnIndex: turn.index,
        });
        const reply = await new NpcAgent({ session, bound, threadLog: deps.threadLog, storyId: story.id }).respondRound(ctx, {
          turnId: turn.id,
          signal,
        });
        deps.agents.appendMessage(session.id, { role: 'assistant', content: JSON.stringify(reply), turnId: turn.id });
        return {
          objectId: obj.id,
          notes: reply.notes.trim() || undefined,
          weave: {
            name: obj.name,
            dialogue: reply.dialogue || undefined,
            intent: reply.intent || undefined,
            innerState: reply.innerState || undefined,
          },
        };
      } catch (err) {
        if (signal.aborted) throw err; // a user cancel must still cancel the turn
        logger.warn('npc round call failed', { storyId: story.id, npc: obj.name, err: (err as Error).message });
        return { objectId: obj.id, weave: { name: obj.name, error: (err as Error).message } };
      }
    }),
  );
  return [...results, ...outcomes];
}
