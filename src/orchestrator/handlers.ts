import type { Db } from '../db/db.ts';
import type { Job } from '../db/stores/jobStore.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { NpcProfileStore } from '../db/stores/npcProfileStore.ts';
import type { SuggestionStore } from '../db/stores/suggestionStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import { ScribeStory } from '../agents/scribeStory.ts';
import { NpcAgent } from '../agents/npcAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { estimateTokens } from '../util/tokens.ts';
import { truncateToTokens } from './contextBuilder.ts';
import type { JobHandler } from './postTurn.ts';

export interface HandlerDeps {
  db: Db;
  stories: StoryStore;
  summaries: SummaryStore;
  agents: AgentStore;
  threadLog: ThreadLog;
  memory: MemoryStore;
  npcProfiles: NpcProfileStore;
  suggestions: SuggestionStore;
  jobs: JobStore;
  registry: LlmRegistry;
  events: EventBus;
}

function scribeStoryAgent(deps: HandlerDeps, storyId: string): ScribeStory {
  const profileName = deps.stories.getStory(storyId)?.settings.roles.scribe_story ?? deps.registry.getForRole('scribe_story').name;
  const bound = deps.registry.getProfile(profileName);
  const session = deps.agents.ensureSession(storyId, 'scribe_story', profileName);
  return new ScribeStory({ session, bound, threadLog: deps.threadLog, storyId });
}

// How far the story digest may lag behind play before a mid-scene checkpoint
// fold is forced. Without this, a scene that never closes would leave the
// digest empty and the story's beginning would survive only in the (small)
// scene summary — the "story derails after ~10 turns" failure mode.
export const DIGEST_CHECKPOINT_EVERY = 8;

/**
 * scribe_story handler. Two modes:
 *  - 'scene' (default, per turn): rewrite the current scene summary to cover the
 *    turn(s) since it was last updated.
 *  - 'digest': fold a scene's summary into the story digest — on scene close,
 *    and as a mid-scene checkpoint when the digest lags too far behind play.
 */
export function createScribeStoryHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const story = deps.stories.getStory(storyId);
    if (!story) return; // story deleted — nothing to do
    const budgets = story.settings.budgets;
    const mode = (job.payload.mode as string) ?? 'scene';
    const agent = scribeStoryAgent(deps, storyId);

    if (mode === 'digest') {
      const sceneId = job.payload.sceneId as string;
      const checkpoint = !!job.payload.checkpoint;
      const sceneSummary = deps.summaries.getSceneSummary(sceneId);
      if (!sceneSummary?.content.trim()) return; // nothing to fold
      const prevDigest = deps.summaries.getStoryDigest(storyId);
      // Stale checkpoint (a later fold already covered this) — skip.
      if (checkpoint && prevDigest && prevDigest.coversToTurnIndex >= sceneSummary.coversToTurnIndex) return;
      const { storyDigest, fadedOut } = await agent.foldDigest({
        previousDigest: prevDigest?.content ?? '',
        closedSceneSummary: sceneSummary.content,
        checkpoint,
        maxTokens: budgets.digestTokens,
      });
      if (!deps.stories.getStory(storyId)) return; // story deleted while summarizing
      deps.summaries.upsertStoryDigest(storyId, storyDigest, sceneSummary.coversToTurnIndex);
      deps.events.emit({ t: 'summary.updated', storyId, scope: 'story' });
      // Feature 3: whatever faded out of the digest gets archived into memory.
      if (fadedOut.length) deps.jobs.enqueue('archive_faded', { storyId, payload: { items: fadedOut } });
      return;
    }

    // mode === 'scene'
    const turnId = job.payload.turnId as string;
    const turn = deps.stories.getTurn(turnId);
    if (!turn || !turn.sceneId) return;
    const prev = deps.summaries.getSceneSummary(turn.sceneId);
    const from = prev ? prev.coversToTurnIndex + 1 : 0;
    if (turn.index < from) return; // already covered (out-of-order re-run)

    const newTurns = deps.stories
      .listTurns(storyId, { fromIndex: from, limit: 1000 })
      .filter((t) => t.sceneId === turn.sceneId && t.index <= turn.index && t.status === 'complete');
    if (newTurns.length === 0) return;

    const { sceneSummary, fadedOut } = await agent.summarizeScene(
      {
        previousSummary: prev?.content ?? '',
        newTurns: newTurns.map((t) => ({ playerInput: t.playerInput, narration: t.narration })),
        maxTokens: budgets.sceneSummaryTokens,
      },
      { turnId },
    );
    if (!deps.stories.getTurn(turnId)) return; // turn rewound while summarizing — discard
    deps.summaries.upsertSceneSummary(storyId, turn.sceneId, sceneSummary, turn.index);
    deps.events.emit({ t: 'summary.updated', storyId, scope: 'scene' });
    // Feature 3: details that faded out of the scene summary get archived into memory.
    if (fadedOut.length) deps.jobs.enqueue('archive_faded', { storyId, payload: { items: fadedOut } });

    // Mid-scene digest checkpoint: when the digest has fallen too far behind
    // play, fold the (still-open) scene's summary in so the story-level memory
    // stays current even in a scene that never breaks.
    const digest = deps.summaries.getStoryDigest(storyId);
    if (turn.index - (digest?.coversToTurnIndex ?? -1) >= DIGEST_CHECKPOINT_EVERY) {
      deps.jobs.enqueue('scribe_story', { storyId, payload: { mode: 'digest', sceneId: turn.sceneId, checkpoint: true } });
    }
  };
}

/**
 * The verbatim recent story text for character-building passes (npc_seed,
 * npc_dossier): as many completed turns as fit `maxTokens`, newest kept when
 * over budget, presented chronologically. Summaries lag and can be thin —
 * this is what "parse the story first" reads.
 */
export function renderRecentStory(stories: StoryStore, storyId: string, maxTokens = 3000): string {
  const blocks: string[] = [];
  let used = 0;
  for (const t of stories.recentTurns(storyId, 30).filter((x) => x.status === 'complete').reverse()) {
    const block = `Player: ${t.playerInput || '(scene opens)'}\nNarration: ${t.narration}`;
    used += estimateTokens(block);
    if (blocks.length && used > maxTokens) break;
    blocks.push(block);
  }
  return blocks.reverse().join('\n\n');
}

/**
 * npc_seed handler (NPC Story Mode, docs/09): give a profile-less NPC a mind.
 * Two paths:
 *  - conversion (no LLM): the object already has memory facts (story switched
 *    modes mid-way) → render the NPC-scoped view into personality + notes,
 *  - generation: one cheap JSON call inventing a personality + opening notes
 *    consistent with the digest/scene/introduction.
 * Only ever fills EMPTY fields — player edits and racing duplicates are never
 * overwritten.
 */
export function createNpcSeedHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const objectId = job.payload.objectId as string;
    const story = deps.stories.getStory(storyId);
    const obj = deps.memory.getObject(objectId);
    if (!story || !obj) return;
    // force=true (the manual "rebuild from story" action) refreshes an
    // existing mind deliberately; the default path never clobbers one.
    const force = !!job.payload.force;
    const existing = deps.npcProfiles.get(objectId);
    if (!force && existing?.personality.trim()) return; // already has a mind — never clobber

    // Conversion path: fold an existing fact sheet into the narrative profile.
    const view = deps.memory.getObjectView(objectId, { kind: 'npc', npcObjectId: objectId });
    if (view?.facts.length) {
      const PERSONALITY_CATS = new Set(['personality', 'voice', 'appearance']);
      const personaLines: string[] = [];
      const noteLines: string[] = [];
      for (const f of view.facts) {
        (PERSONALITY_CATS.has(f.category) ? personaLines : noteLines).push(`- ${f.content}`);
      }
      for (const k of deps.memory.npcKnowledge(storyId, objectId).filter((k) => k.objectId !== objectId)) {
        noteLines.push(`- ${k.objectName}: ${k.content}`);
      }
      if (personaLines.length || noteLines.length) {
        const personaMax = story.settings.npcStories.personalityMaxTokens;
        deps.npcProfiles.upsert(storyId, objectId, {
          personality: truncateToTokens(personaLines.join('\n') || (view.summary ? `- ${view.summary}` : ''), personaMax),
          ...(!force && existing?.notes.trim() ? {} : { notes: noteLines.join('\n') }),
        });
        deps.events.emit({ t: 'npc.profile.updated', storyId, objectIds: [objectId] });
        return;
      }
    }

    // Generation path: invent the mind from the story so far. The seeder
    // PARSES the raw story text first (summaries lag and can be thin early
    // on — and in NPC Story Mode there are no memory facts to lean on): as
    // many recent completed turns as fit the budget, newest kept, presented
    // chronologically.
    const profileName = story.settings.roles.npc ?? deps.registry.getForRole('npc').name;
    const bound = deps.registry.getProfile(profileName);
    const session = deps.agents.ensureSession(storyId, 'npc', profileName, objectId);
    const agent = new NpcAgent({ session, bound, threadLog: deps.threadLog, storyId });
    const system = renderPrompt('npc-story-seed', {
      name: obj.name,
      premise: story.settings.premise || '(none given)',
      digest: deps.summaries.getStoryDigest(storyId)?.content || '(the story is just beginning)',
      sceneSummary: (story.currentSceneId ? deps.summaries.getSceneSummary(story.currentSceneId)?.content : '') || '(no scene summary yet)',
      recentStory: renderRecentStory(deps.stories, storyId) || '(no story text yet)',
    });
    const seed = await agent.seed(
      { system, messages: [{ role: 'user', content: `Create the mind for ${obj.name}. Reply as JSON.` }] },
      { maxTokens: story.settings.npcStories.personalityTokens },
    );
    if (!deps.memory.getObject(objectId)) return; // deleted/rewound while generating
    const current = deps.npcProfiles.get(objectId);
    if (!force && current?.personality.trim()) return; // seeded/edited meanwhile — keep theirs
    deps.npcProfiles.upsert(storyId, objectId, {
      personality: truncateToTokens(seed.personality, story.settings.npcStories.personalityMaxTokens),
      ...(!force && current?.notes.trim() ? {} : { notes: seed.notes }),
    });
    deps.events.emit({ t: 'npc.profile.updated', storyId, objectIds: [objectId] });
  };
}
