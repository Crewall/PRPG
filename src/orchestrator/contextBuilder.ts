import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { estimateTokens } from '../util/tokens.ts';
import type { StoryStore } from '../db/stores/storyStore.ts';
import type { Story } from '../domain.ts';

// Placeholder marker used when the player submits an empty turn (auto-open).
export const BEGIN_MARKER = '(Begin the story from the premise. Set the opening scene and invite the player to act.)';

export interface ContextBuilder {
  forStoryteller(story: Story, playerInput: string): BuiltContext;
}

/**
 * Layer-1 context builder: system prompt (persona + premise) + full raw history
 * + player input. Deliberately naive — 06-orchestration.md replaces this with a
 * budgeted digest+scene+lastK builder in Layer 2. We still assert the assembled
 * prompt leaves output headroom, so oversized stories fail loudly rather than
 * being silently truncated by the provider.
 */
export function createContextBuilder(stories: StoryStore): ContextBuilder {
  return {
    forStoryteller(story: Story, playerInput: string): BuiltContext {
      const premiseBlock = story.settings.premise.trim()
        ? `\n\n## Premise\n${story.settings.premise.trim()}`
        : '';
      const system =
        renderPrompt('storyteller', {
          genre: story.settings.genre,
          tone: story.settings.tone,
        }) + premiseBlock;

      const history = stories.listTurns(story.id, { limit: 1000 });
      const messages: ChatMessage[] = [];
      for (const t of history) {
        // Each past turn is one user (player) message + one assistant (narration).
        messages.push({ role: 'user', content: t.playerInput || BEGIN_MARKER });
        if (t.narration) messages.push({ role: 'assistant', content: t.narration });
      }
      messages.push({ role: 'user', content: playerInput.trim() || BEGIN_MARKER });

      // Headroom assertion (see 06-orchestration.md token-budgeting note).
      // We can't know the exact profile here, so use a generous default window.
      const promptTokens = estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
      // 200k window default; leave 8k for output. Layer 2 makes this exact & bounded.
      if (promptTokens > 200_000 - 8_000) {
        throw new Error(
          `storyteller prompt (~${promptTokens} tokens) exceeds context budget; Layer 2 compression needed for stories this long`,
        );
      }

      return { system, messages };
    },
  };
}
