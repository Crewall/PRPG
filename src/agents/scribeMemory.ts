import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { renderPrompt } from './prompts.ts';
import { ObjectType, DetailLevel, FactTier } from '../memory/model.ts';

// MemoryDelta (doc 04). The scribe proposes changes; the orchestrator applies
// them with trust-but-verify post-processing (tempIds, alias merge, clamps).
// Cleanup pass replies (memory_maintenance job).
export const UnifyReply = z.object({
  merges: z
    .array(
      z.object({
        keepId: z.string(),
        mergeId: z.string(),
        certainty: z.enum(['certain', 'likely']).default('likely'),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});
export type UnifyReply = z.infer<typeof UnifyReply>;

export const ConsolidateReply = z.object({
  removeFactIds: z.array(z.string()).default([]),
  rewrites: z
    .array(
      z.object({
        factId: z.string(),
        content: z.string(),
        category: z.string().optional(),
        subcategory: z.string().optional(),
        tier: FactTier.optional(),
      }),
    )
    .default([]),
  summary: z.string().optional(),
});
export type ConsolidateReply = z.infer<typeof ConsolidateReply>;

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
        tier: FactTier.default('mid'),
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
  roster?: string; // compact list of ALL objects (id/type/name/aliases) — for entity resolution
}

// Dossier output: the fact delta PLUS a prose portrait — the storyteller's
// description of the character preserved nearly verbatim, because atomizing a
// rich portrait into facts is inherently lossy (the facts carry the
// disclosure machinery; the portrait carries the texture).
export const DossierReply = MemoryDelta.extend({
  portrait: z.string().default(''),
});
export type DossierReply = z.infer<typeof DossierReply>;

export interface DossierInput {
  name: string;
  objectId: string;
  currentSheet: string; // rendered storyteller-scope view of the character
  currentPortrait: string; // existing prose portrait, if any
  premise: string;
  digest: string;
  sceneSummary: string;
  recentStory: string; // VERBATIM recent turns — the primary source to parse
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
            `## All known objects (check here BEFORE creating a new object — an entity may appear under a new name)\n${input.roster || '(none yet)'}\n\n` +
            `## Current memory (for entities that may be mentioned)\n${input.snapshot || '(empty — no objects yet)'}\n\n` +
            `## Present characters (ids you may list in knownBy)\n${input.presentNpcIds.length ? input.presentNpcIds.join(', ') : '(none tracked yet)'}\n\n` +
            `## The turn to extract from\nPlayer: ${input.playerInput || '(scene opens)'}\nNarration: ${input.narration}`,
        },
      ],
    };
    return this.invokeJson(ctx, MemoryDelta, opts);
  }

  /**
   * Character dossier — at NPC elevation and on the manual "rebuild from
   * story" action. A single-character focused pass: it PARSES the verbatim
   * story text first (nothing competes with this character for fact slots),
   * then fills the gaps. Dedupe downstream drops anything already recorded.
   */
  async dossier(input: DossierInput, opts: { turnId?: string } = {}): Promise<DossierReply> {
    const system = renderPrompt('npc-dossier', { name: input.name, objectId: input.objectId });
    const ctx: BuiltContext = {
      system,
      messages: [
        {
          role: 'user',
          content:
            `## What is already recorded about ${input.name} (do NOT repeat these)\n${input.currentSheet || '(nothing yet)'}\n\n` +
            `## Their current portrait (rewrite it to cover everything the story now shows)\n${input.currentPortrait || '(none yet)'}\n\n` +
            `## Story premise\n${input.premise || '(none)'}\n\n` +
            `## Story so far (summary)\n${input.digest || '(the story just began)'}\n\n` +
            `## Current scene (summary)\n${input.sceneSummary || '(scene just opened)'}\n\n` +
            `## The most recent story text (VERBATIM — your primary source)\n${input.recentStory || '(none)'}`,
        },
      ],
    };
    return this.invokeJson(ctx, DossierReply, opts);
  }

  /** Cleanup pass 1: spot duplicate entities in the full object roster. */
  async unify(input: { roster: string }, opts: { turnId?: string } = {}): Promise<UnifyReply> {
    const ctx: BuiltContext = {
      system: renderPrompt('scribe-memory-unify', {}),
      messages: [{ role: 'user', content: `## Object roster\n${input.roster}` }],
    };
    return this.invokeJson(ctx, UnifyReply, opts);
  }

  /** Cleanup pass 2: dedupe/unify one object's facts and refresh its summary. */
  async consolidate(input: { objectBlock: string }, opts: { turnId?: string } = {}): Promise<ConsolidateReply> {
    const ctx: BuiltContext = {
      system: renderPrompt('scribe-memory-consolidate', {}),
      messages: [{ role: 'user', content: input.objectBlock }],
    };
    return this.invokeJson(ctx, ConsolidateReply, opts);
  }
}
