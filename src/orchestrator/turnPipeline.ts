import { StoryLocks } from './locks.ts';
import type { ContextBuilder, NpcReplyForWeave, ResolutionForWeave } from './contextBuilder.ts';
import { Adjudicator } from '../agents/adjudicator.ts';
import { clampChance, outcomeFromRoll, OUTCOME_GUIDANCE } from './resolution.ts';
import type { ActionResolution } from './resolution.ts';
import { searchFacts, renderRetrieval } from '../memory/retrieval.ts';
import { renderObjectView } from '../memory/model.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { SnapshotStore } from '../db/stores/snapshotStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import { Storyteller } from '../agents/storyteller.ts';
import { ContextPlanner } from '../agents/contextPlanner.ts';
import type { ContextPlan } from '../agents/contextPlanner.ts';
import { NpcAgent } from '../agents/npcAgent.ts';
import type { NpcReply } from '../agents/npcAgent.ts';
import { estimateTokens } from '../util/tokens.ts';
import { logger } from '../util/logger.ts';
import { parseDirectives } from './directives.ts';
import type { Directive } from './directives.ts';
import { breakScene } from './scenes.ts';
import { resolveNpc, npcEnter, npcExit } from './npc.ts';
import type { NpcServiceDeps } from './npc.ts';
import type { Story, Turn } from '../domain.ts';

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
  memory: MemoryStore;
  summaries: SummaryStore;
  snapshots: SnapshotStore;
  registry: LlmRegistry;
  contexts: ContextBuilder;
  events: EventBus;
  /** Dice source for adjudicated actions — injectable for deterministic tests. */
  rng?: () => number;
}

export interface RewindResult {
  turnId: string;
  playerInput: string;
  /** false = no snapshot existed (pre-feature turn); only the turn+messages were dropped. */
  restored: boolean;
}

interface ConsultOutcome {
  name: string;
  objectId?: string;
  reply?: NpcReply;
  error?: string;
}

export class TurnPipeline {
  private readonly deps: PipelineDeps;
  private readonly locks = new StoryLocks();
  private readonly aborters = new Map<string, AbortController>();

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  private npcDeps(): NpcServiceDeps {
    return { stories: this.deps.stories, agents: this.deps.agents, memory: this.deps.memory, jobs: this.deps.jobs, registry: this.deps.registry, events: this.deps.events };
  }

  /** Cancel the in-flight turn for a story, if any. */
  cancel(storyId: string): void {
    this.aborters.get(storyId)?.abort(new Error('cancelled by user'));
  }

  /** Manual scene break (from the UI "new scene" control). */
  newScene(storyId: string, opts: { title?: string } = {}): void {
    breakScene({ stories: this.deps.stories, jobs: this.deps.jobs, events: this.deps.events }, storyId, opts);
  }

  /**
   * Feature 1: delete the latest exchange and hand the player their prompt
   * back for editing. Halts any in-flight generation for the story first, then
   * (under the story lock, so the halt has settled) restores the pre-turn
   * snapshot — summaries, memory, scenes, sessions, transcript — and deletes
   * the turn. Throws when the story has no turns.
   */
  async rewind(storyId: string): Promise<RewindResult> {
    this.cancel(storyId); // halt any ongoing response; its turn becomes the one we delete
    return this.locks.withStory(storyId, async () => {
      const { stories, agents, snapshots, events } = this.deps;
      if (!stories.getStory(storyId)) throw new Error(`story '${storyId}' not found`);
      const last = stories.lastTurn(storyId);
      if (!last) throw new Error('nothing to rewind — the story has no turns yet');

      const restored = snapshots.restore(storyId, last.id);
      if (!restored) {
        // Pre-snapshot turn (older story): degrade to dropping the turn and its
        // transcript messages; summaries/memory keep whatever the scribes wrote,
        // and still-queued scribes no-op on the missing turn.
        stories.deleteTurn(last.id);
        agents.deleteMessagesForTurn(last.id);
      }
      events.emit({ t: 'story.rewound', storyId, turnId: last.id, playerInput: last.playerInput });
      return { turnId: last.id, playerInput: last.playerInput, restored };
    });
  }

  async run(storyId: string, playerInput: string, out: TurnEmitter): Promise<Turn | undefined> {
    return this.locks.withStory(storyId, () => this.runLocked(storyId, playerInput, out));
  }

  private async runLocked(storyId: string, playerInput: string, out: TurnEmitter): Promise<Turn | undefined> {
    const { stories, agents, threadLog, jobs, registry, contexts } = this.deps;

    // Step 0 — preflight.
    const story = stories.getStory(storyId);
    if (!story) return void out.error('', `story '${storyId}' not found`), undefined;
    if (story.status !== 'active') return void out.error('', `story '${storyId}' is not active`), undefined;

    // Step 1 — backup (feature 1a): capture everything mutable BEFORE this turn
    // writes anything, so a rewind can restore the exact pre-message state.
    const turn = stories.appendTurn({ storyId, playerInput, status: 'streaming' });
    this.deps.snapshots.capture(storyId, turn.id, turn.index);
    out.accepted(turn.id);

    const aborter = new AbortController();
    this.aborters.set(storyId, aborter);
    const t0 = Date.now();
    // Which agent/model is at work — so a failure can say WHO failed and how.
    let stage = 'setup';

    try {
      // Step 2 — context build. In summary-driven mode a cheap planner pass
      // decides which memories (and how deep) the storyteller needs (feature 4).
      let plan: ContextPlan | undefined;
      if (story.settings.context.summaryDriven && story.settings.context.plannerEnabled) {
        stage = 'context planner';
        out.status('gathering memories…');
        plan = await this.planContext(story, playerInput, turn.id, aborter.signal);
      }
      stage = 'context build';
      const ctx = contexts.forStoryteller(story, playerInput, plan ? { plan } : undefined);

      const profileName = story.settings.roles.storyteller ?? registry.getForRole('storyteller').name;
      const bound = registry.getProfile(profileName);
      stage = `storyteller (${bound.profile.model})`;
      const session = agents.ensureSession(storyId, 'storyteller', profileName);
      const storyteller = new Storyteller({ session, bound, threadLog, storyId });

      // Are there present major NPCs the storyteller might consult? If so, we buffer
      // pass-1 (it may be a draft that gets re-woven) rather than streaming it live.
      const scene = story.currentSceneId ? stories.getScene(story.currentSceneId) : undefined;
      const canConsult = (scene?.activeNpcIds.length ?? 0) > 0;

      // A delta gate that never leaks the ```directives fence to the player.
      const gate = this.makeGate(out);

      // Step 3 — storyteller pass 1.
      out.status('the storyteller is writing…');
      const draft1 = await storyteller.narrate(ctx, canConsult ? undefined : gate.onDelta, { turnId: turn.id, signal: aborter.signal });
      let parsed = parseDirectives(draft1);
      let finalNarration = parsed.narration;
      let finalDirectives = parsed.directives;
      let storytellerCalls = 1;

      // Step 4 — NPC consults + adjudicated actions, Step 5 — re-weave.
      const consults = canConsult ? parsed.directives.filter((d): d is Extract<Directive, { type: 'consult_npc' }> => d.type === 'consult_npc') : [];
      const resolveDirectives = story.settings.adjudicator.enabled
        ? parsed.directives.filter((d): d is Extract<Directive, { type: 'resolve_action' }> => d.type === 'resolve_action')
        : [];

      // Adjudication: gather circumstances, judge, roll hidden dice (parallel).
      let resolutions: ActionResolution[] = [];
      let weaveResolutions: ResolutionForWeave[] = [];
      if (resolveDirectives.length) {
        stage = 'adjudicator';
        out.status('fate weighs the attempt…');
        const results = await Promise.all(resolveDirectives.map((d) => this.resolveAction(story, turn.id, d, aborter.signal)));
        resolutions = results.map((r) => r.resolution).filter((r): r is ActionResolution => !!r);
        weaveResolutions = results.map((r) => r.weave);
      }

      if (consults.length || (canConsult && weaveResolutions.length)) {
        // Buffered REWRITE path: pass 1 was never shown, so the weave replaces it.
        let weave: NpcReplyForWeave[] = [];
        if (consults.length) {
          stage = 'npc consults';
          out.status('the characters are thinking…');
          const outcomes = await Promise.all(consults.map((c) => this.consultNpc(story, turn.id, c, playerInput, parsed.narration, aborter.signal)));
          weave = outcomes.map((o) => ({ name: o.name, dialogue: o.reply?.dialogue ?? '', action: o.reply?.action, error: o.error }));
        }
        const ctx2 = contexts.withNpcReplies(ctx, draft1, weave, weaveResolutions);

        stage = `storyteller weave (${bound.profile.model})`;
        out.status('the storyteller is weaving the reply…');
        gate.reset();
        const draft2 = await storyteller.narrate(ctx2, gate.onDelta, { turnId: turn.id, signal: aborter.signal });
        storytellerCalls = 2;
        parsed = parseDirectives(draft2);
        finalNarration = parsed.narration;
        finalDirectives = parsed.directives;
      } else if (weaveResolutions.length) {
        // Streamed CONTINUATION path: the lead-in already streamed live, so the
        // storyteller continues from it with the decided outcome appended.
        const ctx2 = contexts.withResolutions(ctx, draft1, weaveResolutions);
        stage = `storyteller weave (${bound.profile.model})`;
        out.status('the storyteller narrates the outcome…');
        out.delta('\n\n');
        const gate2 = this.makeGate(out);
        const draft2 = await storyteller.narrate(ctx2, gate2.onDelta, { turnId: turn.id, signal: aborter.signal });
        storytellerCalls = 2;
        const parsed2 = parseDirectives(draft2);
        finalNarration = `${parsed.narration}\n\n${parsed2.narration}`;
        finalDirectives = [...parsed.directives.filter((d) => d.type !== 'resolve_action'), ...parsed2.directives];
      } else if (canConsult) {
        // Buffered pass-1 with no consult → replay the narration so the player sees it stream.
        gate.replay(finalNarration);
      }

      // Step 7 — emit.
      const promptTokens = estimateTokens(ctx.system) + ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
      stories.updateTurn(turn.id, {
        narration: finalNarration,
        status: 'complete',
        meta: {
          durationMs: Date.now() - t0,
          promptTokensEst: promptTokens,
          outputTokensEst: estimateTokens(finalNarration),
          model: bound.profile.model,
          storytellerCalls,
          consults: consults.length,
          // Hidden dice: numbers live here (and the debug UI), never in the story.
          ...(resolutions.length ? { rolls: resolutions.map((r) => ({ actor: r.actor, action: r.action, chance: r.chance, roll: r.roll, outcome: r.outcome })) } : {}),
        },
      });
      agents.appendMessage(session.id, { role: 'user', content: playerInput || '(begin)', turnId: turn.id });
      agents.appendMessage(session.id, { role: 'assistant', content: finalNarration, turnId: turn.id });

      const finalTurn = stories.getTurn(turn.id)!;
      out.final(finalTurn);

      // Step 8 — scene effects: scene_break / npc_enter / npc_exit.
      this.applySceneDirectives(storyId, finalDirectives);

      // Step 9 — post-turn async scribes.
      jobs.enqueue('scribe_story', { storyId, turnId: turn.id, payload: { mode: 'scene', turnId: turn.id } });
      jobs.enqueue('scribe_memory', { storyId, turnId: turn.id, payload: { turnId: turn.id } });

      return finalTurn;
    } catch (err) {
      const cancelled = aborter.signal.aborted;
      const message = cancelled ? (err instanceof Error ? err.message : String(err)) : `${stage}: ${err instanceof Error ? err.message : String(err)}`;
      stories.updateTurn(turn.id, { status: cancelled ? 'rejected' : 'error', meta: { error: message } });
      logger.warn('turn failed', { storyId, turnId: turn.id, cancelled, message });
      if (cancelled) out.rejected(turn.id, 'cancelled');
      else out.error(turn.id, message);
      return stories.getTurn(turn.id);
    } finally {
      this.aborters.delete(storyId);
    }
  }

  /**
   * Run the context_planner (feature 4). Never throws: any failure (no model
   * bound, bad JSON, abort) degrades to plain lexical retrieval off the input.
   */
  private async planContext(story: Story, playerInput: string, turnId: string, signal: AbortSignal): Promise<ContextPlan | undefined> {
    const { registry, agents, threadLog, stories, summaries, memory } = this.deps;
    try {
      let bound;
      const override = story.settings.roles.context_planner;
      if (override) bound = registry.getProfile(override);
      else {
        try {
          bound = registry.getForRole('context_planner');
        } catch {
          bound = registry.getForRole('scribe_memory'); // configs from before the role existed
        }
      }
      const session = agents.ensureSession(story.id, 'context_planner', bound.name);
      const planner = new ContextPlanner({ session, bound, threadLog, storyId: story.id });

      const scene = story.currentSceneId ? stories.getScene(story.currentSceneId) : undefined;
      const presentCharacters = (scene?.activeNpcIds ?? [])
        .map((npcId) => memory.getObject(npcId)?.name)
        .filter((n): n is string => !!n);
      return await planner.plan(
        {
          digest: summaries.getStoryDigest(story.id)?.content ?? '',
          sceneSummary: story.currentSceneId ? summaries.getSceneSummary(story.currentSceneId)?.content ?? '' : '',
          presentCharacters,
          playerInput,
        },
        { turnId, signal },
      );
    } catch (err) {
      if (signal.aborted) throw err; // a user cancel must still cancel the turn
      logger.warn('context planner failed — falling back to lexical retrieval', { storyId: story.id, err: (err as Error).message });
      return undefined;
    }
  }

  /**
   * Adjudicate one uncertain attempt (feature: the resolution AI). The ENGINE
   * gathers the circumstances mechanically — the actor's recorded sheet,
   * retrieval over the action text, the location — so the storyteller doesn't
   * have to remember everything. The adjudicator judges a success chance; a
   * hidden d100 decides. Never throws (except on user cancel): a failed
   * adjudication degrades to "storyteller resolves narratively".
   */
  private async resolveAction(
    story: Story,
    turnId: string,
    directive: Extract<Directive, { type: 'resolve_action' }>,
    signal: AbortSignal,
  ): Promise<{ resolution?: ActionResolution; weave: ResolutionForWeave }> {
    const { memory, registry, agents, threadLog, stories } = this.deps;
    try {
      let bound;
      const override = story.settings.roles.adjudicator;
      if (override) bound = registry.getProfile(override);
      else {
        try {
          bound = registry.getForRole('adjudicator');
        } catch {
          bound = registry.getForRole('scribe_memory'); // configs from before the role existed
        }
      }
      const session = agents.ensureSession(story.id, 'adjudicator', bound.name);
      const adjudicator = new Adjudicator({ session, bound, threadLog, storyId: story.id });

      const factors = directive.factors ?? [];
      const actorObj = memory.findByName(story.id, directive.actor);
      const actorView = actorObj ? memory.getObjectView(actorObj.id, { kind: 'storyteller' }, { maxTokens: 400 }) : undefined;
      const retrieval = searchFacts(memory, story.id, { kind: 'storyteller' }, `${directive.action} ${factors.join(' ')}`, { maxTokens: 400 });
      const scene = story.currentSceneId ? stories.getScene(story.currentSceneId) : undefined;
      const location = scene?.locationObjectId ? memory.getObjectView(scene.locationObjectId, { kind: 'storyteller' }, { maxTokens: 200 }) : undefined;

      const reply = await adjudicator.judge(
        {
          actor: directive.actor,
          action: directive.action,
          factors,
          actorSheet: actorView ? renderObjectView(actorView) : '',
          circumstances: renderRetrieval(retrieval),
          sceneState: location ? renderObjectView(location) : '',
        },
        { turnId, signal },
      );

      const chance = clampChance(reply.successChance);
      const roll = 1 + Math.floor((this.deps.rng ?? Math.random)() * 100);
      const outcome = outcomeFromRoll(chance, roll);
      logger.info('action adjudicated', { storyId: story.id, turnId, actor: directive.actor, action: directive.action, chance, roll, outcome });
      return {
        resolution: { actor: directive.actor, action: directive.action, chance, roll, outcome, assessment: reply.assessment, complication: reply.complication, keyFactors: reply.keyFactors },
        weave: { actor: directive.actor, action: directive.action, guidance: OUTCOME_GUIDANCE[outcome], complication: reply.complication || undefined },
      };
    } catch (err) {
      if (signal.aborted) throw err; // a user cancel must still cancel the turn
      logger.warn('adjudication failed — storyteller resolves narratively', { storyId: story.id, actor: directive.actor, err: (err as Error).message });
      return {
        weave: { actor: directive.actor, action: directive.action, guidance: 'the referee is unavailable — decide this outcome yourself, fairly, without guaranteeing success' },
      };
    }
  }

  /** Consult one NPC. Never throws — a failed consult degrades to an error note. */
  private async consultNpc(
    story: Story,
    turnId: string,
    directive: Extract<Directive, { type: 'consult_npc' }>,
    playerInput: string,
    moment: string,
    signal: AbortSignal,
  ): Promise<ConsultOutcome> {
    const { agents, threadLog, registry, contexts } = this.deps;
    const obj = resolveNpc(this.npcDeps(), story.id, directive.npcName);
    if (!obj) return { name: directive.npcName, error: 'unknown-npc' };

    try {
      const profileName = story.settings.roles.npc ?? registry.getForRole('npc').name;
      const bound = registry.getProfile(profileName);
      const sessionBefore = agents.listSessions(story.id).find((s) => s.role === 'npc' && s.npcObjectId === obj.id);
      const wasDormant = sessionBefore?.state === 'dormant';
      const session = agents.ensureSession(story.id, 'npc', profileName, obj.id);
      if (session.state !== 'active') agents.setState(session.id, 'active');

      const ctx = contexts.forNpc(story, obj.id, {
        situation: directive.situation ?? 'respond to the player',
        playerInput,
        moment,
        wasDormant,
      });

      const reply = await new NpcAgent({ session, bound, threadLog, storyId: story.id }).respond(ctx, { turnId, signal });
      this.applyReveals(obj.id, reply, turnId);
      agents.appendMessage(session.id, { role: 'assistant', content: JSON.stringify(reply), turnId });
      return { name: obj.name, objectId: obj.id, reply };
    } catch (err) {
      logger.warn('npc consult failed', { story: story.id, npc: obj.name, err: (err as Error).message });
      return { name: obj.name, objectId: obj.id, error: (err as Error).message };
    }
  }

  /** revealsFactIds → grant the player knowledge of those facts. */
  private applyReveals(npcObjectId: string, reply: NpcReply, turnId: string): void {
    for (const factId of reply.revealsFactIds ?? []) {
      const fact = this.deps.memory.getFact(factId);
      if (fact) this.deps.memory.linkKnowledge(factId, { type: 'player' }, { learnedTurnId: turnId });
    }
  }

  private applySceneDirectives(storyId: string, directives: Directive[]): void {
    for (const d of directives) {
      if (d.type === 'scene_break') {
        breakScene({ stories: this.deps.stories, jobs: this.deps.jobs, events: this.deps.events }, storyId, { title: d.title, carryNpcs: this.resolveNames(storyId, d.carryNpcs) });
      } else if (d.type === 'npc_enter') {
        npcEnter(this.npcDeps(), storyId, d.name);
      } else if (d.type === 'npc_exit') {
        npcExit(this.npcDeps(), storyId, d.name);
      }
      // roll — post-MVP.
    }
  }

  private resolveNames(storyId: string, names?: string[]): string[] {
    if (!names) return [];
    return names.map((n) => resolveNpc(this.npcDeps(), storyId, n)?.id).filter((x): x is string => !!x);
  }

  /** A delta forwarder that suppresses everything from the first ``` fence onward. */
  private makeGate(out: TurnEmitter) {
    let acc = '';
    let sent = 0;
    return {
      onDelta: (chunk: string) => {
        acc += chunk;
        const display = acc.split('```')[0];
        if (display.length > sent) {
          out.delta(display.slice(sent));
          sent = display.length;
        }
      },
      reset: () => {
        acc = '';
        sent = 0;
      },
      replay: (text: string) => {
        for (let i = 0; i < text.length; i += 24) out.delta(text.slice(i, i + 24));
      },
    };
  }
}
