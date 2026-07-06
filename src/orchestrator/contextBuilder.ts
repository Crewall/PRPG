import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { estimateTokens } from '../util/tokens.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { SummaryStore } from '../db/stores/summaryStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import { searchFacts, renderRetrieval } from '../memory/retrieval.ts';
import { renderObjectView } from '../memory/model.ts';
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
}

export interface ContextBuilder {
  forStoryteller(story: Story, playerInput: string, extras?: StorytellerContextExtras): BuiltContext;
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

      // --- System prompt: persona + premise + compressed history + injected sections ---
      const parts: string[] = [
        renderPrompt('storyteller', { genre: story.settings.genre, tone: story.settings.tone }),
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
      if (scene) {
        const ambient: string[] = [];
        if (scene.locationObjectId) {
          const loc = memory.getObjectView(scene.locationObjectId, { kind: 'storyteller' }, { maxTokens: 300 });
          if (loc) ambient.push(renderObjectView(loc));
        }
        for (const npcId of scene.activeNpcIds) {
          const npc = memory.getObjectView(npcId, { kind: 'storyteller' }, { maxTokens: 120, categories: ['appearance', 'personality', 'state'] });
          if (npc) ambient.push(`${npc.name}: ${npc.summary || npc.facts.map((f) => f.content).join('; ')}`);
        }
        if (ambient.length) parts.push(`## Scene state\n${truncateToTokens(ambient.join('\n\n'), 400)}`);
      }

      // --- Retrieved memory: storyteller sees everything, incl. hidden facts. ---
      const retrieval = searchFacts(memory, story.id, { kind: 'storyteller' }, playerInput, { maxTokens: b.retrievedMemoryTokens });
      const retrievedText = renderRetrieval(retrieval);
      if (retrievedText.trim()) {
        parts.push(`## Relevant memory (you know all of this — including secrets and hidden truths — use it to stay consistent and foreshadow)\n${retrievedText}`);
      }

      for (const section of extras?.sections ?? []) {
        if (section.body.trim()) parts.push(`## ${section.heading}\n${truncateToTokens(section.body.trim(), section.budgetTokens)}`);
      }

      const system = parts.join('\n\n');

      // --- Messages: last K raw turns verbatim + the new player input ---
      const k = b.recentTurns;
      const recent = stories.recentTurns(story.id, k);
      const messages: ChatMessage[] = [];
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
  };
}
