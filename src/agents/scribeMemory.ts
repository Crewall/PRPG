import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';
import { ObjectType, DetailLevel } from '../memory/model.ts';

// MemoryDelta (doc 04). The scribe proposes changes; the orchestrator applies
// them with trust-but-verify post-processing (tempIds, alias merge, clamps).
export const MemoryDelta = z.object({
  newObjects: z
    .array(
      z.object({
        tempId: z.string(),
        type: ObjectType,
        name: z.string(),
        aliases: z.array(z.string()).default([]),
        summary: z.string().default(''),
      }),
    )
    .default([]),
  newFacts: z
    .array(
      z.object({
        objectId: z.string(), // real id or a tempId from newObjects
        category: z.string(),
        subcategory: z.string().optional(),
        detailLevel: DetailLevel,
        content: z.string(),
        confidence: z.number().min(0).max(1).default(0.8),
        knownBy: z.array(z.string()).default([]), // 'player' | npc object ids present & perceiving
        supersedesFactId: z.string().optional(),
      }),
    )
    .default([]),
  salienceUpdates: z.array(z.object({ objectId: z.string(), salience: z.number().min(0).max(1) })).default([]),
  mergeSuggestions: z.array(z.object({ keepId: z.string(), mergeId: z.string(), reason: z.string() })).default([]),
});
export type MemoryDelta = z.infer<typeof MemoryDelta>;

export interface ScribeMemoryInput {
  playerInput: string;
  narration: string;
  presentNpcIds: string[];
  snapshot: string; // rendered current memory for mentioned entities
}

/**
 * scribe_memory (Layer 3b). Cheap/fast model, async post-turn. Extracts a
 * MemoryDelta from a completed turn against the current memory snapshot so it
 * updates rather than duplicates.
 */
export class ScribeMemory extends Agent {
  async extract(input: ScribeMemoryInput, opts: { turnId?: string } = {}): Promise<MemoryDelta> {
    const system = renderPrompt('scribe-memory', {});
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content:
            `## Current memory (for entities that may be mentioned)\n${input.snapshot || '(empty — no objects yet)'}\n\n` +
            `## Present characters (ids you may list in knownBy)\n${input.presentNpcIds.length ? input.presentNpcIds.join(', ') : '(none tracked yet)'}\n\n` +
            `## The turn to extract from\nPlayer: ${input.playerInput || '(scene opens)'}\nNarration: ${input.narration}`,
        },
      ],
    };
    return this.invokeJson(ctx, MemoryDelta, opts);
  }
}
