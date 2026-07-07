import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';

// The Adjudicator: an impartial referee, separate from the storyteller. Given
// one attempted action and the relevant circumstances (gathered mechanically by
// the engine from memory, not remembered by the storyteller), it estimates a
// realistic success chance and names the stakes. The ENGINE then rolls the
// dice — the model judges difficulty, it never decides the outcome.
export const AdjudicationReply = z.object({
  assessment: z.string().default(''), // brief reasoning, for the logs
  successChance: z.number().min(0).max(100),
  keyFactors: z.array(z.string()).default([]),
  // What a partial success costs / how a failure plausibly plays out.
  complication: z.string().default(''),
});
export type AdjudicationReply = z.infer<typeof AdjudicationReply>;

export interface AdjudicationInput {
  actor: string;
  action: string;
  factors: string[]; // circumstances the storyteller flagged
  actorSheet: string; // rendered memory view of the actor (abilities, state, inventory…)
  circumstances: string; // engine-retrieved relevant facts (environment, objects…)
  sceneState: string;
}

export class Adjudicator extends Agent {
  async judge(input: AdjudicationInput, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<AdjudicationReply> {
    const system = renderPrompt('adjudicator', {});
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content:
            `## The attempt\n${input.actor} attempts to: ${input.action}\n\n` +
            `## Circumstances flagged by the narrator\n${input.factors.length ? input.factors.map((f) => `- ${f}`).join('\n') : '(none)'}\n\n` +
            `## What is known about ${input.actor}\n${input.actorSheet || '(no recorded sheet — assume a capable but ordinary person)'}\n\n` +
            `## Relevant recorded facts\n${input.circumstances || '(none retrieved)'}\n\n` +
            `## Scene\n${input.sceneState || '(no scene details)'}`,
        },
      ],
    };
    return this.invokeJson(ctx, AdjudicationReply, opts);
  }
}
