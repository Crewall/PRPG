import type { Db } from '../db/db.ts';
import type { Job } from '../db/stores/jobStore.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { SuggestionStore } from '../db/stores/suggestionStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import { ScribeStory } from '../agents/scribeStory.ts';
import type { JobHandler } from './postTurn.ts';

export interface HandlerDeps {
  db: Db;
  stories: StoryStore;
  summaries: SummaryStore;
  agents: AgentStore;
  threadLog: ThreadLog;
  memory: MemoryStore;
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
