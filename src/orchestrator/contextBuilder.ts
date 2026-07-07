import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { estimateTokens } from '../util/tokens.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import { searchFacts, renderRetrieval } from '../memory/retrieval.ts';
import { renderObjectView } from '../memory/model.ts';
import type { ContextPlan } from '../agents/contextPlanner.ts';
import type { Story } from '../domain.ts';

// Placeholder marker used when the player submits an empty turn (auto-open).
export const BEGIN_MARKER = '(Begin the story from the premise. Set the opening scene and invite the player to act.)';

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
  /** Extend a storyteller context with NPC replies (and any resolved actions) for a full REWRITE pass. */
  withNpcReplies(base: BuiltContext, draft: string, replies: NpcReplyForWeave[], resolutions?: ResolutionForWeave[]): BuiltContext;
  /** Extend a storyteller context with resolved actions for a CONTINUATION pass (the lead-in already streamed to the player). */
  withResolutions(base: BuiltContext, draft: string, resolutions: ResolutionForWeave[]): BuiltContext;
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
}

/**
 * Context builder v2 (Layer 2): budgeted digest + current scene summary +
 * last-K raw turns + player input — replacing Layer 1's full-history dump. This
 * is what keeps the storyteller prompt size flat as the story grows. Layer 3c
 * injects ambient scene views and a retrieved-memory block via `extras.sections`.
 */
export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder {
  const { stories, summaries, memory } = deps;

  return {
    forStoryteller(story: Story, playerInput: string, extras?: StorytellerContextExtras): BuiltContext {
      const b = story.settings.budgets;
      // Feature 4: summary-driven mode replaces the last-K raw turns with
      // summary + prompt + scene characters + goals + planner-guided retrieval.
      const summaryDriven = story.settings.context.summaryDriven;
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

- List in "factors" every circumstance you know that helps or hinders. An impartial referee weighs them (with the character's recorded abilities and state) and fate decides; you will then be told the outcome to narrate. Never mention dice, chances or the referee in the story.`
        : '';
      const parts: string[] = [
        renderPrompt('storyteller', { genre: story.settings.genre, tone: story.settings.tone, adjudication }),
      ];
      if (story.settings.premise.trim()) {
        parts.push(`## Premise\n${story.settings.premise.trim()}`);
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

      // --- Present major characters the storyteller MAY consult (Layer 4). ---
      if (presentNpcs.length) {
        const list = presentNpcs.map((n) => `- ${n.name}`).join('\n');
        parts.push(
          `## Present major characters — you may consult them\nThese characters are voiced by their own minds and hold their own private knowledge. When one of them should speak or act in a way that depends on what THEY know (not what you know), delegate to them with a \`consult_npc\` directive instead of voicing them yourself:\n${list}`,
        );
      }

      // --- Current goals (summary-driven mode): what everyone is after right now. ---
      if (summaryDriven) {
        const goals = memory.factsByCategory(story.id, ['goals', 'goal']).slice(0, 20);
        if (goals.length) {
          const lines = goals.map((g) => `- ${g.objectName}: ${g.fact.content}`);
          parts.push(`## Current goals\n${truncateToTokens(lines.join('\n'), 300)}`);
        }
      }

      // --- Focus objects requested by the context planner: full scoped views. ---
      if (summaryDriven && plan?.focusObjects?.length) {
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
      // In summary-driven mode the planner widens the query and sets tier depth. ---
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

    withNpcReplies(base: BuiltContext, draft: string, replies: NpcReplyForWeave[], resolutions?: ResolutionForWeave[]): BuiltContext {
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
      if (resolutions?.length) {
        sections.push(`Fate has decided the uncertain attempts — narrate these outcomes exactly as given (never mention dice or chances):\n${resolutionLines(resolutions)}`);
      }
      const messages: ChatMessage[] = [
        ...base.messages,
        { role: 'assistant', content: draft },
        {
          role: 'user',
          content:
            `${sections.join('\n\n')}\n\n` +
            `Now write the FINAL narration the player will read, weaving all of this in naturally and in your own narrative voice. Do not quote these instructions. Only include a \`\`\`directives block if you are declaring scene changes.`,
        },
      ];
      return { system: base.system, messages };
    },

    withResolutions(base: BuiltContext, draft: string, resolutions: ResolutionForWeave[]): BuiltContext {
      const messages: ChatMessage[] = [
        ...base.messages,
        { role: 'assistant', content: draft },
        {
          role: 'user',
          content:
            `Fate has decided the uncertain attempts — narrate these outcomes exactly as given (never mention dice, chances or these instructions):\n${resolutionLines(resolutions)}\n\n` +
            `CONTINUE the narration from exactly where your last reply stopped. Do NOT repeat or rewrite what you already wrote — write only the continuation describing how the attempt plays out and where it leaves the player. Only include a \`\`\`directives block if you are declaring scene changes.`,
        },
      ];
      return { system: base.system, messages };
    },
  };
}
