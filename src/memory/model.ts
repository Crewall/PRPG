import { z } from 'zod';

// Memory model (docs 03 & 05): objects carry atomic, categorized facts; each fact
// has a detail level that governs disclosure. Zod schemas double as API/LLM
// validators.

export const ObjectType = z.enum(['character', 'item', 'location', 'faction', 'event', 'lore']);
export type ObjectType = z.infer<typeof ObjectType>;

export const DetailLevel = z.enum(['visible', 'known', 'secret', 'hidden']);
export type DetailLevel = z.infer<typeof DetailLevel>;

// Importance tier — orthogonal to detailLevel (who MAY see it): how prominent
// the fact is among what a scope does see.
// - major: conspicuous — the most important, defining features.
// - mid: comes to mind when thinking about / looking at the object with focus.
// - minor: nuances that only appear under close inspection or in edge situations.
export const FactTier = z.enum(['major', 'mid', 'minor']);
export type FactTier = z.infer<typeof FactTier>;

const TIER_RANK: Record<FactTier, number> = { major: 0, mid: 1, minor: 2 };

/** Sort key: major first. */
export function tierRank(tier: FactTier): number {
  return TIER_RANK[tier] ?? 1;
}

/** True if `tier` is at or above the given depth (major ⊂ mid ⊂ minor). */
export function tierWithin(tier: FactTier, depth: FactTier): boolean {
  return tierRank(tier) <= tierRank(depth);
}

export const ObjectStatus = z.enum(['active', 'dormant', 'destroyed', 'dead']);
export type ObjectStatus = z.infer<typeof ObjectStatus>;

// The knowledge scope a view is built for — the isolation boundary (doc 03/05).
export type KnowledgeScope =
  | { kind: 'storyteller' } // sees everything incl. hidden
  | { kind: 'player' } // visible + facts linked to player
  | { kind: 'npc'; npcObjectId: string } // visible + facts linked to this NPC (distortions applied)
  | { kind: 'perception' }; // visible only

export interface MemoryObject {
  id: string;
  storyId: string;
  type: ObjectType;
  name: string;
  aliases: string[];
  summary: string;
  salience: number;
  status: ObjectStatus;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryFact {
  id: string;
  objectId: string;
  category: string;
  subcategory: string | null;
  detailLevel: DetailLevel;
  tier: FactTier;
  content: string;
  sourceTurnId: string | null;
  supersedesId: string | null;
  superseded: boolean;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface Knower {
  type: 'player' | 'npc';
  npcObjectId?: string;
}

export interface KnowledgeLink {
  id: string;
  factId: string;
  knowerType: 'player' | 'npc';
  knowerNpcObjectId: string | null;
  learnedTurnId: string | null;
  distortion: string | null;
}

// A scoped, detail-level-filtered, distortion-substituted view of an object.
export interface ObjectView {
  id: string;
  type: ObjectType;
  name: string;
  aliases: string[];
  summary: string;
  facts: { id: string; category: string; subcategory?: string; content: string; detailLevel: DetailLevel; tier: FactTier }[];
}

export const NewMemoryObject = z.object({
  storyId: z.string(),
  type: ObjectType,
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  summary: z.string().default(''),
  salience: z.number().min(0).max(1).default(0.5),
  status: ObjectStatus.default('active'),
});
export type NewMemoryObject = z.infer<typeof NewMemoryObject>;

export const NewFact = z.object({
  objectId: z.string(),
  category: z.string().min(1),
  subcategory: z.string().optional(),
  detailLevel: DetailLevel,
  tier: FactTier.optional(), // store defaults to 'mid'
  content: z.string().min(1),
  sourceTurnId: z.string().optional(),
  supersedesId: z.string().optional(),
  confidence: z.number().min(0).max(1).default(1),
});
export type NewFact = z.infer<typeof NewFact>;

/** Render an ObjectView as compact text for an agent prompt. */
export function renderObjectView(view: ObjectView): string {
  const lines = [`### ${view.name}${view.aliases.length ? ` (aka ${view.aliases.join(', ')})` : ''} — ${view.type}`];
  if (view.summary) lines.push(view.summary);
  for (const f of view.facts) {
    lines.push(`- [${f.category}${f.subcategory ? '/' + f.subcategory : ''} · ${f.tier}] ${f.content}`);
  }
  return lines.join('\n');
}
