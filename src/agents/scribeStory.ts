import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';

export const SceneSummaryReply = z.object({ sceneSummary: z.string() });
export const StoryDigestReply = z.object({ storyDigest: z.string() });

/**
 * scribe_story (Layer 2). Cheap/fast model. Two jobs:
 *  - rolling scene summary after each turn (incremental rewrite),
 *  - story-digest fold on scene close.
 * Runs off the player path via the job worker; failures lag, never break play.
 */
export class ScribeStory extends Agent {
  /** Rewrite the current scene's summary to cover through the newest turn. */
  async summarizeScene(
    input: { previousSummary: string; newTurns: { playerInput: string; narration: string }[]; maxTokens: number },
    opts: { turnId?: string } = {},
  ): Promise<string> {
    const system = renderPrompt('scribe-story-scene', { maxTokens: String(input.maxTokens) });
    const turnsText = input.newTurns
      .map((t, i) => `Turn ${i + 1}:\nPlayer: ${t.playerInput || '(scene opens)'}\nNarration: ${t.narration}`)
      .join('\n\n');
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content: `Previous scene summary:\n${input.previousSummary || '(none yet — this is the start of the scene)'}\n\nNew turn(s) to fold in:\n${turnsText}`,
        },
      ],
    };
    const reply = await this.invokeJson(ctx, SceneSummaryReply, opts);
    return reply.sceneSummary.trim();
  }

  /** Fold a finalized scene summary into the story-level digest. */
  async foldDigest(
    input: { previousDigest: string; closedSceneSummary: string; maxTokens: number },
    opts: { turnId?: string } = {},
  ): Promise<string> {
    const system = renderPrompt('scribe-story-digest', { maxTokens: String(input.maxTokens) });
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content: `Current story digest:\n${input.previousDigest || '(empty — this is the first scene)'}\n\nFinalized summary of the scene that just closed:\n${input.closedSceneSummary}`,
        },
      ],
    };
    const reply = await this.invokeJson(ctx, StoryDigestReply, opts);
    return reply.storyDigest.trim();
  }
}
