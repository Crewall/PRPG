import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { estimateTokens } from '../util/tokens.ts';
import { formatGameClock } from '../util/gameClock.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import { searchFacts, renderRetrieval } from '../memory/retrieval.ts';
import { renderObjectView } from '../memory/model.ts';
import type { ContextPlan } from '../agents/contextPlanner.ts';
import type { Story } from '../domain.ts';

// Placeholder marker used when the player submits an empty turn (auto-open).
export const BEGIN_MARKER = '(Begin the story from the premise. BRIEFLY set the opening scene — a few short paragraphs at most — and end by inviting the player to act.)';

// Storyteller reply-length instruction per verbosity step (settings.verbosity).
// Exported as the built-in default; a per-installation override can be set in
// Settings → Storyteller style and is applied via ContextBuilderDeps.verbosityOverride.
export const VERBOSITY_STYLE: Record<number, string> = {
  1: 'Keep each reply TERSE: one short paragraph (2–4 sentences).',
  2: 'Keep each reply brief: 1–2 short paragraphs.',
  3: 'Keep each reply focused: 1–4 short paragraphs.',
  4: 'Write rich replies: 3–5 paragraphs with sensory detail.',
  5: 'Write expansive replies: 5+ paragraphs of lavish sensory and atmospheric detail.',
};

/** Truncate text to an approximate token budget (chars/4 heuristic). */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  return text.slice(0, maxTokens * 4).trimEnd() + ' …';
}

export interface StorytellerContextExtras {
  /** Extra system-prompt sections injected by later layers (scene state, retrieved memory). */
  sections?: { heading: string; body: string; budgetTokens: number }[];
  /** Retrieval plan from the context_planner (summary-driven mode, feature 4). */
  plan?: ContextPlan;
  /** NPC Story Mode: the round's proactive NPC replies (docs/09). */
  npcRound?: NpcRoundForWeave[];
}

// NPC Story Mode: one present NPC's contribution to the round, phrased for the
// storyteller. Exactly one of {acted, skipped, error} shapes applies:
// dialogue/intent/innerState when the NPC was invoked; skipped=true when the
// mechanical gate found nothing new for them; error when the call failed.
export interface NpcRoundForWeave {
  name: string;
  dialogue?: string;
  intent?: string;
  innerState?: string;
  skipped?: boolean;
  error?: string;
}

// NPC Story Mode: everything forNpcRound needs beyond the stores — the NPC's
// narrative profile and the turn being played. The runner (npcRound.ts)
// fetches the profile so the builder stays store-agnostic about profiles.
export interface NpcRoundContextInput {
  personality: string;
  notes: string;
  lastPresentTurnIdx: number;
  playerInput: string;
  /** Index of the turn being generated (witnessed turns are strictly before it). */
  turnIndex: number;
}

export interface NpcConsultContext {
  situation: string;
  playerInput: string;
  moment: string; // the storyteller's unfolding narration this turn
  wasDormant: boolean;
}

export interface NpcReplyForWeave {
  name: string;
  dialogue: string;
  action?: string;
  error?: string;
}

// A resolved (or failed-to-resolve) adjudicated action, phrased for the weave
// pass. Qualitative only — chance/roll numbers never reach the storyteller.
export interface ResolutionForWeave {
  actor: string;
  action: string;
  guidance: string; // outcome band guidance (OUTCOME_GUIDANCE) or an error note
  complication?: string;
}

function resolutionLines(resolutions: ResolutionForWeave[]): string {
  return resolutions
    .map((r) => `- ${r.actor}'s attempt to ${r.action}: ${r.guidance}${r.complication ? ` (complication if needed: ${r.complication})` : ''}`)
    .join('\n');
}

export interface ContextBuilder {
  forStoryteller(story: Story, playerInput: string, extras?: StorytellerContextExtras): BuiltContext;
  /** Persona + NPC-scoped recap + situation for one consult (isolation boundary). */
  forNpc(story: Story, npcObjectId: string, consult: NpcConsultContext): BuiltContext;
  /** NPC Story Mode: narrative profile + mechanically personalized excerpt for one proactive round (docs/09). */
  forNpcRound(story: Story, npcObjectId: string, input: NpcRoundContextInput): BuiltContext;
  /** Extend a storyteller context with NPC replies (and any resolved actions) for a full REWRITE pass. */
  withNpcReplies(base: BuiltContext, draft: string, replies: NpcReplyForWeave[], resolutions?: ResolutionForWeave[]): BuiltContext;
  /** Extend a storyteller context with consult replies / resolved actions for a CONTINUATION pass (prior text already streamed to the player). */
  withContinuation(base: BuiltContext, draft: string, events: { replies?: NpcReplyForWeave[]; resolutions?: ResolutionForWeave[] }): BuiltContext;
}

function weaveSections(replies: NpcReplyForWeave[], resolutions: ResolutionForWeave[]): string[] {
  const sections: string[] = [];
  if (replies.length) {
    const lines = replies.map((r) => {
      if (r.error) return `- ${r.name} is unavailable (${r.error}); voice them briefly yourself, consistent with their known character.`;
      const bits = [r.dialogue ? `says: "${r.dialogue}"` : 'says nothing'];
      if (r.action) bits.push(`(${r.action})`);
      return `- ${r.name} ${bits.join(' ')}`;
    });
    sections.push(`The characters you consulted responded:\n${lines.join('\n')}`);
  }
  if (resolutions.length) {
    sections.push(
      `Fate has decided the uncertain attempts — narrate these outcomes exactly as given (never mention dice or chances). The dice are the sole authority here, above your own preferences: if fate says a ruthless or morally dark attempt succeeds, it SUCCEEDS, fully and effectively — do not soften it, add last-second reversals, or punish it with consequences fate did not list. Equally, a noble attempt that fails, fails. Subverting a rolled outcome breaks the game:\n${resolutionLines(resolutions)}`,
    );
  }
  return sections;
}

/**
 * NPC Story Mode: render the round's NPC contributions as a storyteller
 * system-prompt section. Undefined when there is nothing to say at all.
 */
export function npcRoundSection(round: NpcRoundForWeave[]): string | undefined {
  if (!round.length) return undefined;
  const lines: string[] = [];
  const quiet: string[] = [];
  for (const r of round) {
    if (r.skipped) {
      quiet.push(r.name);
      continue;
    }
    if (r.error) {
      lines.push(`- ${r.name} is unavailable (${r.error}); voice them briefly yourself, consistent with their known character.`);
      continue;
    }
    if (!r.dialogue && !r.intent && !r.innerState) {
      quiet.push(r.name);
      continue;
    }
    const bits = [r.dialogue ? `says: "${r.dialogue}"` : 'says nothing'];
    if (r.intent) bits.push(`— intends: ${r.intent}`);
    if (r.innerState) bits.push(`(inwardly: ${r.innerState})`);
    lines.push(`- ${r.name} ${bits.join(' ')}`);
  }
  const parts: string[] = [
    `Each present character has already spoken or acted through their own mind this round. Quote or faithfully paraphrase their words. Their intents are ATTEMPTS, not outcomes — you decide what actually happens (or request adjudication for uncertain, consequential attempts). "Inwardly" entries are private subtext: let them color the character's manner, never state or quote them. Do not use consult_npc directives — the characters have already answered; omit anyone with nothing worth showing.`,
  ];
  if (lines.length) parts.push(lines.join('\n'));
  if (quiet.length) parts.push(`Also present, not engaging this round (voice them briefly yourself only if the moment demands it): ${quiet.join(', ')}.`);
  return parts.join('\n');
}

/** Render an object view with per-fact ids so an NPC can cite them in revealsFactIds. */
function renderPersonaKnowledge(view: { name: string; summary: string; facts: { id: string; category: string; subcategory?: string; content: string }[] }): string {
  const lines: string[] = [];
  if (view.summary) lines.push(view.summary);
  if (view.facts.length === 0) lines.push('(You have no particular knowledge beyond what is obvious.)');
  for (const f of view.facts) {
    lines.push(`- (${f.id}) [${f.category}${f.subcategory ? '/' + f.subcategory : ''}] ${f.content}`);
  }
  return lines.join('\n');
}

export interface ContextBuilderDeps {
  stories: StoryStore;
  summaries: SummaryStore;
  memory: MemoryStore;
  /** Optional editable verbosity strings (keyed "1".."5"); falls back to VERBOSITY_STYLE. */
  verbosityOverride?: () => Record<string, string>;
}

/**
 * Context builder v2 (Layer 2): budgeted digest + current scene summary +
 * last-K raw turns + player input — replacing Layer 1's full-history dump. This
 * is what keeps the storyteller prompt size flat as the story grows. Layer 3c
 * injects ambient scene views and a retrieved-memory block via `extras.sections`.
 */
export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const { stories, summaries, memory } = deps;
  const verbosityFor = (step: number): string => {
    const override = deps.verbosityOverride?.() ?? {};
    return override[String(step)]?.trim() || VERBOSITY_STYLE[step] || VERBOSITY_STYLE[3];
  };

  return {
    forStoryteller(story: Story, playerInput: string, extras?: StorytellerContextExtras): BuiltContext {
      const b = story.settings.budgets;
      // Feature 4: summary-driven mode replaces the last-K raw turns with
      // summary + prompt + scene characters + goals + planner-guided retrieval.
      const summaryDriven = story.settings.context.summaryDriven;
      // NPC Story Mode (docs/09): memory-derived blocks are replaced by the
      // proactive NPC round; NPCs speak for themselves before this pass.
      const npcStoriesOn = story.settings.npcStories.enabled;
      const plan = extras?.plan;

      // --- System prompt: persona + premise + compressed history + injected sections ---
      const adjudication = story.settings.adjudicator.enabled
        ? `## Player intent & uncertain outcomes (adjudication)
- Treat the player's input (and every NPC's stated action) as INTENT — an attempt, never a guaranteed outcome. "I kill the guard" means "I try to".
- Trivial, safe or purely social actions: narrate them yourself as usual.
- When an attempt is UNCERTAIN and CONSEQUENTIAL (could fail, and failure matters), do NOT decide the outcome. Write a short lead-in (1–2 sentences setting up the attempt, stopping just before the outcome), then request adjudication:

\`\`\`directives
{ "directives": [
  { "type": "resolve_action", "actor": "Kael", "action": "climb the rain-slick courtyard wall", "factors": ["has climbing gear", "carrying a heavy pack", "guards may hear"] }
] }
\`\`\`

- List in "factors" every circumstance you know that helps or hinders — PRACTICAL circumstances only (skill, gear, environment, opposition, time). Never list moral qualms, guilt or the ethics of the act as factors; the referee judges feasibility, not virtue. An impartial referee weighs them (with the character's recorded abilities and state) and fate decides; you will then be told the outcome to narrate. Never mention dice, chances or the referee in the story.
- Morally dark attempts get the same treatment as any other: if a theft, deception or act of violence is uncertain and consequential, request adjudication rather than deciding yourself that it fails or "feels wrong". This is fiction; steering every shady attempt toward a comfortable outcome breaks the player's agency.`
        : '';
      const parts: string[] = [
        renderPrompt('storyteller', {
          genre: story.settings.genre,
          tone: story.settings.tone,
          adjudication,
          verbosity: verbosityFor(story.settings.verbosity),
        }),
      ];
      if (story.settings.premise.trim()) {
        parts.push(`## Premise\n${story.settings.premise.trim()}`);
      }

      // The hidden in-game clock. The storyteller keeps it honest via the
      // advance_time directive; the player never sees it stated outright.
      parts.push(
        `## In-game clock (hidden from the player)\nIt is ${formatGameClock(story.clockMin)}. Keep the fiction consistent with this time of day. When your reply spans more than a few minutes of story time (travel, rest, waiting, a long conversation), declare it with an advance_time directive; small exchanges advance a few minutes automatically. Never state the clock verbatim unless the fiction would reveal it.`,
      );

      // The player's own character (from the intake interview), storyteller scope.
      if (story.settings.playerObjectId) {
        const pc = memory.getObjectView(story.settings.playerObjectId, { kind: 'storyteller' }, { maxTokens: 300 });
        if (pc) parts.push(`## The player's character\n${renderObjectView(pc)}`);
      }

      const digest = summaries.getStoryDigest(story.id);
      if (digest?.content.trim()) {
        parts.push(`## Story so far (digest)\n${truncateToTokens(digest.content.trim(), b.digestTokens)}`);
      }

      const sceneSummary = story.currentSceneId ? summaries.getSceneSummary(story.currentSceneId) : undefined;
      if (sceneSummary?.content.trim()) {
        parts.push(`## Current scene\n${truncateToTokens(sceneSummary.content.trim(), b.sceneSummaryTokens)}`);
      }

      // --- Ambient scene views: location + present NPCs (storyteller scope). ---
      const scene = story.currentSceneId ? stories.getScene(story.currentSceneId) : undefined;
      const presentNpcs: { id: string; name: string; oneLiner: string }[] = [];
      if (scene) {
        const ambient: string[] = [];
        if (scene.locationObjectId) {
          const loc = memory.getObjectView(scene.locationObjectId, { kind: 'storyteller' }, { maxTokens: 300 });
          if (loc) ambient.push(renderObjectView(loc));
        }
        for (const npcId of scene.activeNpcIds) {
          const npc = memory.getObjectView(npcId, { kind: 'storyteller' }, { maxTokens: 120, categories: ['appearance', 'personality', 'state'] });
          if (npc) {
            const oneLiner = npc.summary || npc.facts.map((f) => f.content).join('; ');
            ambient.push(`${npc.name}: ${oneLiner}`);
            presentNpcs.push({ id: npc.id, name: npc.name, oneLiner });
          }
        }
        if (ambient.length) parts.push(`## Scene state\n${truncateToTokens(ambient.join('\n\n'), 400)}`);
      }

      // --- NPC Story Mode: the round's proactive NPC contributions. ---
      if (npcStoriesOn) {
        const section = npcRoundSection(extras?.npcRound ?? []);
        if (section) parts.push(`## The characters act this round\n${section}`);
      }

      // --- Present major characters the storyteller MAY consult (Layer 4). ---
      if (presentNpcs.length && !npcStoriesOn) {
        const list = presentNpcs.map((n) => `- ${n.name}`).join('\n');
        parts.push(
          `## Present major characters — you may consult them\nThese characters are voiced by their own minds and hold their own private knowledge. When one of them should speak or act in a way that depends on what THEY know (not what you know), delegate to them with a \`consult_npc\` directive instead of voicing them yourself:\n${list}`,
        );
      }

      // --- Current goals (summary-driven mode): what everyone is after right now. ---
      if (summaryDriven && !npcStoriesOn) {
        const goals = memory.factsByCategory(story.id, ['goals', 'goal']).slice(0, 20);
        if (goals.length) {
          const lines = goals.map((g) => `- ${g.objectName}: ${g.fact.content}`);
          parts.push(`## Current goals\n${truncateToTokens(lines.join('\n'), 300)}`);
        }
      }

      // --- Focus objects requested by the context planner: full scoped views. ---
      if (summaryDriven && !npcStoriesOn && plan?.focusObjects?.length) {
        const seen = new Set<string>();
        const blocks: string[] = [];
        for (const name of plan.focusObjects) {
          const obj = memory.findByName(story.id, name);
          if (!obj || seen.has(obj.id)) continue;
          seen.add(obj.id);
          const view = memory.getObjectView(obj.id, { kind: 'storyteller' }, { maxTokens: 300, maxTier: plan.depth });
          if (view && (view.facts.length || view.summary)) blocks.push(renderObjectView(view));
        }
        if (blocks.length) parts.push(`## In focus this turn\n${truncateToTokens(blocks.join('\n\n'), b.retrievedMemoryTokens)}`);
      }

      // --- Retrieved memory: storyteller sees everything, incl. hidden facts.
      // In summary-driven mode the planner widens the query and sets tier depth.
      // NPC Story Mode: skipped — the fact store is not maintained there. ---
      if (!npcStoriesOn) {
        const queryText = summaryDriven && plan?.queries?.length ? [playerInput, ...plan.queries].join('\n') : playerInput;
        const retrieval = searchFacts(memory, story.id, { kind: 'storyteller' }, queryText, {
          maxTokens: b.retrievedMemoryTokens,
          maxTier: summaryDriven ? plan?.depth : undefined,
          // Salience off → rank purely by match + recency (+ tier).
          scoreWeights: story.settings.salience.enabled ? undefined : { bm25: 1.0, salience: 0, recency: 0.4 },
        });
        const retrievedText = renderRetrieval(retrieval);
        if (retrievedText.trim()) {
          parts.push(`## Relevant memory (you know all of this — including secrets and hidden truths — use it to stay consistent and foreshadow)\n${retrievedText}`);
        }
      }

      for (const section of extras?.sections ?? []) {
        if (section.body.trim()) parts.push(`## ${section.heading}\n${truncateToTokens(section.body.trim(), section.budgetTokens)}`);
      }

      const system = parts.join('\n\n');

      // --- Messages. Full mode: last K raw turns verbatim + the new player
      // input. Summary-driven mode: only the latest completed exchange (the
      // beat the player is replying to — the rolling scene summary lags one
      // scribe job behind) + the new player input.
      // Only completed exchanges: the pipeline has already appended the current
      // (streaming) turn, which must not appear as history — the fresh input is
      // pushed below — and rejected/errored turns never got a reply.
      const messages: ChatMessage[] = [];
      const completed = stories.recentTurns(story.id, b.recentTurns + 2).filter((t) => t.status === 'complete');
      const recent = summaryDriven ? completed.slice(-1) : completed.slice(-b.recentTurns);
      for (const t of recent) {
        messages.push({ role: 'user', content: t.playerInput || BEGIN_MARKER });
        if (t.narration) messages.push({ role: 'assistant', content: t.narration });
      }
      messages.push({ role: 'user', content: playerInput.trim() || BEGIN_MARKER });

      // Headroom assertion — with compression this should always hold; if it
      // fails, budgets are misconfigured for the model's window.
      const promptTokens = estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
      const window = 200_000; // conservative; per-profile window enforced in pipeline meta
      if (promptTokens > window - 8_000) {
        throw new Error(`storyteller prompt (~${promptTokens} tokens) exceeds budget even after compression — check story.settings.budgets`);
      }

      return { system, messages };
    },

    forNpc(story: Story, npcObjectId: string, consult: NpcConsultContext): BuiltContext {
      // Persona built ONLY from this NPC's own scoped view + what THIS NPC knows
      // about the world (knowledge links) — the isolation boundary. Another NPC's
      // persona or private knowledge can never enter here.
      const view = memory.getObjectView(npcObjectId, { kind: 'npc', npcObjectId }, { maxTokens: story.settings.budgets.retrievedMemoryTokens });
      const name = view?.name ?? 'the character';

      let knowledge = view ? renderPersonaKnowledge(view) : '(You know only what is obvious about yourself.)';
      const worldKnown = memory.npcKnowledge(story.id, npcObjectId).filter((k) => k.objectId !== npcObjectId);
      if (worldKnown.length) {
        const lines = worldKnown.map((k) => `- (${k.fact.id}) ${k.objectName}: ${k.content}`);
        knowledge += `\n\n### What you know about people and things around you\n${lines.join('\n')}`;
      }

      const system = renderPrompt('npc', { name, knowledge });

      // NPC-scoped recap: the story's events (as plausibly known) + the current
      // scene as this character has perceived it.
      const sceneSummary = story.currentSceneId ? summaries.getSceneSummary(story.currentSceneId) : undefined;
      const digest = summaries.getStoryDigest(story.id);
      const recapParts: string[] = [];
      if (consult.wasDormant) recapParts.push('Time has passed since you were last present.');
      if (digest?.content.trim()) {
        recapParts.push(`The story's events so far, as you would plausibly know them: ${truncateToTokens(digest.content.trim(), consult.wasDormant ? 300 : 200)}`);
      }
      if (sceneSummary?.content.trim()) recapParts.push(`The scene so far, as you have witnessed it: ${truncateToTokens(sceneSummary.content.trim(), 300)}`);

      const messages: ChatMessage[] = [];
      if (recapParts.length) messages.push({ role: 'user', content: recapParts.join('\n\n') });
      messages.push({
        role: 'user',
        content:
          `The unfolding moment: ${consult.moment || '(the scene continues)'}\n\n` +
          `The player just said or did: ${consult.playerInput || '(nothing in particular)'}\n\n` +
          `You are asked to respond to this: ${consult.situation}\n\n` +
          `Reply in character as ${name}, as JSON.`,
      });
      return { system, messages };
    },

    forNpcRound(story: Story, npcObjectId: string, input: NpcRoundContextInput): BuiltContext {
      // NPC Story Mode isolation boundary: the mind is personality + notes +
      // a mechanically personalized excerpt of the main story. No other NPC's
      // profile, notes, or unwitnessed events can enter here.
      const s = story.settings.npcStories;
      const name = memory.getObject(npcObjectId)?.name ?? 'the character';
      const system = renderPrompt('npc-story', {
        name,
        personality:
          input.personality.trim() ||
          '(No established personality yet — improvise one plausible for this story, and stay consistent with it from now on.)',
        notes: input.notes.trim() || '(You have no particular notes yet beyond the recap below.)',
        // Words ≈ tokens × 0.75 (chars/4 heuristic) — the prompt speaks in words.
        notesBudget: String(Math.round(s.notesTokens * 0.75)),
      });

      // Witnessed turns: completed turns whose presence stamp includes this NPC.
      // Turns from before presence stamping (no meta field) are skipped — the
      // digest/scene recap covers them.
      const witnessed = stories
        .recentTurns(story.id, 50)
        .filter((t) => t.status === 'complete' && t.index < input.turnIndex)
        .filter((t) => (t.meta.presentNpcIds as string[] | undefined)?.includes(npcObjectId))
        .slice(-s.presentTurns);
      const witnessedThisScene = witnessed.some((t) => t.sceneId === story.currentSceneId);

      const recapParts: string[] = [];
      const digest = summaries.getStoryDigest(story.id);
      if (digest?.content.trim()) {
        recapParts.push(`The story's events so far, as you would plausibly know them: ${truncateToTokens(digest.content.trim(), 250)}`);
      }
      const sceneSummary = story.currentSceneId ? summaries.getSceneSummary(story.currentSceneId) : undefined;
      if (witnessedThisScene && sceneSummary?.content.trim()) {
        recapParts.push(`The scene so far, as you have witnessed it: ${truncateToTokens(sceneSummary.content.trim(), 300)}`);
      }
      const gap = input.lastPresentTurnIdx >= 0 ? input.turnIndex - 1 - input.lastPresentTurnIdx : 0;
      if (gap > 0) {
        recapParts.push(`You were elsewhere for the last ${gap === 1 ? 'exchange' : `${gap} exchanges`} — you did not witness what happened in the meantime.`);
      }

      const messages: ChatMessage[] = [];
      if (recapParts.length) messages.push({ role: 'user', content: recapParts.join('\n\n') });
      if (witnessed.length) {
        const lines = witnessed.map(
          (t) => `Player: ${truncateToTokens(t.playerInput || '(the scene opens)', 100)}\nWhat happened: ${truncateToTokens(t.narration, 150)}`,
        );
        messages.push({ role: 'user', content: `Recent moments you witnessed:\n\n${lines.join('\n\n')}` });
      }
      messages.push({
        role: 'user',
        content:
          `The player now says or does: ${input.playerInput.trim() || '(nothing in particular — the moment simply continues)'}\n\n` +
          `React as ${name}: what do you say aloud (if anything), and what do you do or intend to do? Then return your updated private notes. Reply as JSON.`,
      });
      return { system, messages };
    },

    withNpcReplies(base: BuiltContext, draft: string, replies: NpcReplyForWeave[], resolutions?: ResolutionForWeave[]): BuiltContext {
      const sections = weaveSections(replies, resolutions ?? []);
      const messages: ChatMessage[] = [
        ...base.messages,
        { role: 'assistant', content: draft },
        {
          role: 'user',
          content:
            `${sections.join('\n\n')}\n\n` +
            `Now write the FINAL narration the player will read, weaving all of this in naturally and in your own narrative voice. Vary your wording and structure — do not mirror the rhythm or reuse the imagery of your previous replies. Do not quote these instructions. You may emit a \`\`\`directives block if the situation now demands one (a consult, an adjudication, a scene change).`,
        },
      ];
      return { system: base.system, messages };
    },

    withContinuation(base: BuiltContext, draft: string, events: { replies?: NpcReplyForWeave[]; resolutions?: ResolutionForWeave[] }): BuiltContext {
      const sections = weaveSections(events.replies ?? [], events.resolutions ?? []);
      const messages: ChatMessage[] = [
        ...base.messages,
        { role: 'assistant', content: draft },
        {
          role: 'user',
          content:
            `${sections.join('\n\n')}\n\n` +
            `CONTINUE the narration from exactly where your last reply stopped. Do NOT repeat or rewrite what you already wrote — write only the continuation, in fresh language, describing how this plays out and where it leaves the player. You may emit a \`\`\`directives block if the situation now demands one (a consult, an adjudication, a scene change).`,
        },
      ];
      return { system: base.system, messages };
    },
  };
}
