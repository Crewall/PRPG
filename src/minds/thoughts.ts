import { z } from 'zod';
import { clampWords, normalizeTag } from './text.ts';
import { estimateTokens } from '../util/tokens.ts';
import { formatGameClock } from '../util/gameClock.ts';

// Self-written thoughts (docs/11 §5): preparing writes and choosing recalls.
// Pure — the thought store does the I/O.

export const MAX_TAGS = 6;
export const MAX_THOUGHT_WORDS = 40;
export const MAX_REMEMBER_PER_REPLY = 3;
export const MAX_FORGET_PER_REPLY = 5;

export const RememberOp = z.object({
  text: z.string(),
  tags: z.array(z.string()).default([]),
  pin: z.boolean().default(false),
});
export type RememberOp = z.infer<typeof RememberOp>;

export interface Thought {
  id: string;
  storyId: string;
  owner: string;
  seq: number;
  text: string;
  tags: string[];
  pinned: boolean;
  status: 'active' | 'revoked';
  source: 'self' | 'seed' | 'compactor' | 'user';
  createdTurnId: string | null;
  /** In-story time it was written (game-clock minutes); null for older thoughts. */
  createdClockMin: number | null;
  revokedTurnId: string | null;
  lastRecalledTurnId: string | null;
  recallCount: number;
  createdAt: number;
}

/** The short id a model sees: t12. */
export const thoughtHandle = (t: Pick<Thought, 'seq'>) => `t${t.seq}`;

/** Parse "t12" / "12" / 12 → 12. */
export function parseThoughtHandle(h: unknown): number | undefined {
  const m = String(h).trim().match(/^t?(\d+)$/i);
  return m ? Number(m[1]) : undefined;
}

export interface PreparedThought {
  text: string;
  tags: string[];
  pinned: boolean;
  notes: string[];
}

/**
 * Normalize a remember op: text ≤ 40 words, tags normalized and capped, `#x`
 * tags checked against the roster (unknown → plain tag), untagged → pinned.
 * Returns undefined when nothing usable is left.
 */
export function prepareRemember(op: RememberOp, rosterHandles: Set<string>): PreparedThought | undefined {
  const notes: string[] = [];
  const clamped = clampWords(op.text.replace(/\s+/g, ' '), MAX_THOUGHT_WORDS);
  if (!clamped.text) return undefined;
  if (clamped.clamped) notes.push(`shortened to ${MAX_THOUGHT_WORDS} words`);
  const tags: string[] = [];
  for (const raw of op.tags) {
    let tag = normalizeTag(raw);
    if (!tag) continue;
    if (tag.startsWith('#') && !rosterHandles.has(tag.slice(1))) {
      notes.push(`no one/nothing is called ${tag}; kept as the tag '${tag.slice(1)}'`);
      tag = tag.slice(1);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    notes.push(`only the first ${MAX_TAGS} tags were kept`);
    tags.length = MAX_TAGS;
  }
  return { text: clamped.text, tags, pinned: op.pin || tags.length === 0, notes };
}

/** "t12 · Day 2, 19:40 [ledger, #marta] Marta keeps the ledger under the counter." (the time when known) */
export function renderThought(t: Pick<Thought, 'seq' | 'tags' | 'text'> & { createdClockMin?: number | null }): string {
  const when = t.createdClockMin != null ? ` · ${formatGameClock(t.createdClockMin)}` : '';
  return `${thoughtHandle(t)}${when}${t.tags.length ? ` [${t.tags.join(', ')}]` : ''} ${t.text}`;
}

/**
 * Which tagged thoughts come back this round (docs/11 §5.4): active, unpinned,
 * sharing at least one tag with the active set, not shown since the last
 * compaction. Score = 2 × matching tags + recency; take the best within budget.
 */
export function selectRecall(thoughts: Thought[], activeTags: Set<string>, alreadyShown: Set<string>, budgetTokens: number): Thought[] {
  const candidates = thoughts.filter((t) => t.status === 'active' && !t.pinned && !alreadyShown.has(t.id) && t.tags.some((g) => activeTags.has(g)));
  if (!candidates.length) return [];
  const maxSeq = Math.max(...candidates.map((t) => t.seq));
  const scored = candidates
    .map((t) => ({ t, score: 2 * t.tags.filter((g) => activeTags.has(g)).length + t.seq / (maxSeq + 1) }))
    .sort((a, b) => b.score - a.score || b.t.seq - a.t.seq);
  const out: Thought[] = [];
  let used = 0;
  for (const { t } of scored) {
    const cost = estimateTokens(renderThought(t)) + 2;
    if (used + cost > budgetTokens) continue;
    used += cost;
    out.push(t);
  }
  return out;
}

/**
 * Tags of the owner that appear in a text as a word or phrase (docs/11 §5.4,
 * last bullet): "the ledger is gone" evokes 'ledger'; 'old-mill' matches "old mill".
 */
export function tagsMentioned(text: string, vocabulary: Iterable<string>): string[] {
  const hay = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, ' ')} `;
  const out: string[] = [];
  for (const tag of vocabulary) {
    const needle = tag.replace(/^#/, '').replace(/[-_]+/g, ' ');
    if (needle && hay.includes(` ${needle} `)) out.push(tag);
  }
  return out;
}
