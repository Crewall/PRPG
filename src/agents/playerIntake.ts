import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';
import { MemoryDelta } from './scribeMemory.ts';

// The Character Interviewer (player dossier). A short Q&A — at most 3 rounds —
// on its own agent thread, ending in a MemoryDelta that creates the player's
// character object with a full sheet (persona, looks, belongings, skills,
// state, goals), everything knownBy the player.
export const IntakeReply = z.object({
  done: z.boolean(),
  nextQuestion: z.string().default(''), // when !done
  playerName: z.string().default(''), // when done: the PC's name (a newObject)
  delta: MemoryDelta.optional(), // when done
});
export type IntakeReply = z.infer<typeof IntakeReply>;

export interface IntakeStepInput {
  premise: string;
  digest: string;
  exchanges: { question: string; answer: string }[];
  mustFinish: boolean; // round cap reached — no more questions allowed
}

export class PlayerIntake extends Agent {
  async step(input: IntakeStepInput, opts: { signal?: AbortSignal } = {}): Promise<IntakeReply> {
    const system = renderPrompt('player-intake', {});
    const soFar = input.exchanges.length
      ? input.exchanges.map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer}`).join('\n\n')
      : '(no questions asked yet — open the interview)';
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content:
            `## Story premise\n${input.premise || '(none)'}\n\n` +
            `## Story so far\n${input.digest || '(the story has not started yet)'}\n\n` +
            `## Interview so far\n${soFar}\n\n` +
            (input.mustFinish
              ? 'The question limit is reached: you MUST finish now (done: true) with the best dossier you can build from the answers so far.'
              : 'Ask the next question, or finish if you have enough.'),
        },
      ],
    };
    // The interviewer's terminal reply is a full character dossier (a large
    // MemoryDelta), which is exactly the payload that overruns the default cap
    // and truncates. Triple the memory budget for the questionnaire so the
    // dossier finishes in one piece; callJson still escalates further if needed.
    const maxTokens = (this.bound.profile.maxTokens ?? 2048) * 3;
    return this.invokeJson(ctx, IntakeReply, { ...opts, maxTokens });
  }
}
