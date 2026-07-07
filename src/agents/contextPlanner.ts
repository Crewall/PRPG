import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';
import { FactTier } from '../memory/model.ts';

// The plan the storyteller's context is assembled from in summary-driven mode
// (feature 4): a cheap AI pass that reads summary + prompt and decides which
// memories the storyteller needs this turn, and how deep the tiers should go.
export const ContextPlan = z.object({
  // Short search phrases for lexical memory retrieval (topics, not sentences).
  queries: z.array(z.string()).max(8).default([]),
  // Names of objects (characters/items/locations…) whose full memory views matter now.
  focusObjects: z.array(z.string()).max(8).default([]),
  // How deep to retrieve: 'major' = only the conspicuous facts; 'mid' adds the
  // focused knowledge; 'minor' pulls the nuances too (weighty decisions/topics).
  depth: FactTier.default('mid'),
});
export type ContextPlan = z.infer<typeof ContextPlan>;

export interface ContextPlanInput {
  digest: string;
  sceneSummary: string;
  presentCharacters: string[];
  playerInput: string;
}

/**
 * context_planner (feature 4). Cheap/fast model, one small JSON call on the
 * player path (only in summary-driven context mode, and only when
 * settings.context.plannerEnabled). Failures degrade to plain lexical retrieval.
 */
export class ContextPlanner extends Agent {
  async plan(input: ContextPlanInput, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<ContextPlan> {
    const system = renderPrompt('context-planner', {});
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content:
            `## Story digest\n${input.digest || '(none yet)'}\n\n` +
            `## Current scene\n${input.sceneSummary || '(scene just opened)'}\n\n` +
            `## Characters on scene\n${input.presentCharacters.length ? input.presentCharacters.join(', ') : '(none tracked)'}\n\n` +
            `## The player's new input\n${input.playerInput || '(the player opens the story)'}`,
        },
      ],
    };
    return this.invokeJson(ctx, ContextPlan, opts);
  }
}
