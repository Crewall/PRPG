import { StoryLocks } from './locks.ts';
import type { ContextBuilder } from './contextBuilder.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import { Storyteller } from '../agents/storyteller.ts';
import { estimateTokens } from '../util/tokens.ts';
import { logger } from '../util/logger.ts';
import { parseDirectives } from './directives.ts';
import type { Directive } from './directives.ts';
import { breakScene } from './scenes.ts';
import type { Turn } from '../domain.ts';

// What the pipeline emits as a turn progresses. The WS layer implements this to
// forward events to the client; tests implement it to collect events.
export interface TurnEmitter {
  accepted(turnId: string): void;
  status(text: string): void;
  delta(text: string): void;
  final(turn: Turn): void;
  rejected(turnId: string, reason: string): void;
  error(turnId: string, message: string): void;
}

export interface PipelineDeps {
  stories: StoryStore;
  agents: AgentStore;
  threadLog: ThreadLog;
  jobs: JobStore;
  registry: LlmRegistry;
  contexts: ContextBuilder;
  events: EventBus;
}

export class TurnPipeline {
  private readonly deps: PipelineDeps;
  private readonly locks = new StoryLocks();
  private readonly aborters = new Map<string, AbortController>();

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  /** Cancel the in-flight turn for a story, if any. */
  cancel(storyId: string): void {
    this.aborters.get(storyId)?.abort(new Error('cancelled by user'));
  }

  /** Manual scene break (from the UI "new scene" control). */
  newScene(storyId: string, opts: { title?: string } = {}): void {
    breakScene({ stories: this.deps.stories, jobs: this.deps.jobs, events: this.deps.events }, storyId, opts);
  }

  private applySceneDirectives(storyId: string, directives: Directive[]): void {
    for (const d of directives) {
      if (d.type === 'scene_break') {
        breakScene({ stories: this.deps.stories, jobs: this.deps.jobs, events: this.deps.events }, storyId, {
          title: d.title,
          carryNpcs: d.carryNpcs,
        });
      }
      // consult_npc / npc_enter / npc_exit / roll — handled in Layer 4+.
    }
  }

  /**
   * Run one turn. Layer-1 pipeline = steps 0 (preflight) → 2 (context build) →
   * 3 (storyteller stream) → 7 (emit). Scribes / NPCs / overseer arrive in later
   * layers; hooks are marked below.
   */
  async run(storyId: string, playerInput: string, out: TurnEmitter): Promise<Turn | undefined> {
    return this.locks.withStory(storyId, () => this.runLocked(storyId, playerInput, out));
  }

  private async runLocked(storyId: string, playerInput: string, out: TurnEmitter): Promise<Turn | undefined> {
    const { stories, agents, threadLog, jobs, registry, contexts } = this.deps;

    // Step 0 — preflight.
    const story = stories.getStory(storyId);
    if (!story) {
      out.error('', `story '${storyId}' not found`);
      return undefined;
    }
    if (story.status !== 'active') {
      out.error('', `story '${storyId}' is not active`);
      return undefined;
    }

    const turn = stories.appendTurn({ storyId, playerInput, status: 'streaming' });
    out.accepted(turn.id);

    const aborter = new AbortController();
    this.aborters.set(storyId, aborter);
    const t0 = Date.now();

    try {
      // Step 2 — context build.
      const ctx = contexts.forStoryteller(story, playerInput);

      // Storyteller session + agent.
      const profileName = story.settings.roles.storyteller ?? registry.getForRole('storyteller').name;
      const bound = registry.getProfile(profileName);
      const session = agents.ensureSession(storyId, 'storyteller', profileName);
      const storyteller = new Storyteller({ session, bound, threadLog, storyId });

      // Step 3 — storyteller stream.
      out.status('storyteller is writing…');
      let streamed = '';
      const draft = await storyteller.narrate(
        ctx,
        (delta) => {
          streamed += delta;
          out.delta(delta);
        },
        { turnId: turn.id, signal: aborter.signal },
      );

      // Parse the (optional) fenced directive block; only narration is displayed.
      const { narration, directives } = parseDirectives(draft);

      // Step 7 — emit.
      const promptTokens = estimateTokens(ctx.system) + ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
      const outTokens = estimateTokens(narration);
      stories.updateTurn(turn.id, {
        narration,
        status: 'complete',
        meta: {
          durationMs: Date.now() - t0,
          promptTokensEst: promptTokens,
          outputTokensEst: outTokens,
          model: bound.profile.model,
          directives: directives.length,
        },
      });

      // Persist into the storyteller's own session history (session-local record).
      agents.appendMessage(session.id, { role: 'user', content: playerInput || '(begin)', turnId: turn.id });
      agents.appendMessage(session.id, { role: 'assistant', content: narration, turnId: turn.id });

      const finalTurn = stories.getTurn(turn.id)!;
      out.final(finalTurn);

      // Step 8 — scene effects (Layer 2: scene_break only; NPC directives = Layer 4).
      this.applySceneDirectives(storyId, directives);

      // Step 9 — post-turn async scribes (run off the player path via the worker).
      jobs.enqueue('scribe_story', { storyId, turnId: turn.id, payload: { mode: 'scene', turnId: turn.id } });
      jobs.enqueue('scribe_memory', { storyId, turnId: turn.id, payload: { turnId: turn.id } });

      return finalTurn;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = aborter.signal.aborted;
      stories.updateTurn(turn.id, { status: cancelled ? 'rejected' : 'error', meta: { error: message } });
      logger.warn('turn failed', { storyId, turnId: turn.id, cancelled, message });
      if (cancelled) out.rejected(turn.id, 'cancelled');
      else out.error(turn.id, message);
      return stories.getTurn(turn.id);
    } finally {
      this.aborters.delete(storyId);
    }
  }
}
