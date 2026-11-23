import { z } from 'zod';
import { clampWords, normalizeTag } from './text.ts';
import { estimateTokens } from '../util/tokens.ts';
import { formatGameClock } from '../util/gameClock.ts';

// Self-written thoughts (docs/11 §5): preparing writes, fading and choosing
// recalls. Pure — the thought store does the I/O.

export const MAX_TAGS = 6;
export const MAX_THOUGHT_WORDS = 40;
export const MAX_REMEMBER_PER_REPLY = 3;
export const MAX_REVISE_PER_REPLY = 3;
export const MAX_FORGET_PER_REPLY = 5;
/** Active agenda items per character (docs/11 §5.6). */
export const MAX_AGENDA = 3;
/** From this importance a thought never fades (docs/11 §5.7). */
export const NEVER_FADES = 8;
/** From this importance a thought is always on its owner's mind, like a pinned one. */
export const ALWAYS_ON = 9;
/** Opinions and feelings from this current importance are shown to the narrator (docs/11 §5.9). */
export const NARRATOR_SEES = 7;

export const THOUGHT_KINDS = ['agenda', 'opinion', 'feeling', 'note'] as const;
export const ThoughtKind = z.enum(THOUGHT_KINDS);
export type ThoughtKind = z.infer<typeof ThoughtKind>;

/** "7", 7.4, "high" (ignored) → an importance 1–10, or the default. */
export function clampImportance(x: unknown, fallback = 5): number {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : fallback;
}

/** A kind as a model may write it ("Goal", "plan", "opinions") → one of the four, else 'note'. */
export function normalizeKind(x: unknown): ThoughtKind {
  const k = String(x ?? '').trim().toLowerCase();
  if (/^(agenda|goal|goals|plan|plans|aim|intent)$/.test(k)) return 'agenda';
  if (/^(opinion|opinions|impression|view|judgement|judgment)$/.test(k)) return 'opinion';
  if (/^(feeling|feelings|emotion)$/.test(k)) return 'feeling';
  return 'note';
}

export const RememberOp = z.object({
  text: z.string(),
  tags: z.array(z.string()).default([]),
  pin: z.boolean().default(false),
  kind: z.unknown().optional(),
  about: z.string().optional(),
  importance: z.unknown().optional(),
});
/** As written by a model, the seeder or the API: only the text is required. */
export type RememberOp = z.input<typeof RememberOp>;

export const ReviseOp = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  text: z.string().optional(),
  importance: z.unknown().optional(),
  kind: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
});
export type ReviseOp = z.infer<typeof ReviseOp>;

export type ThoughtStatus = 'active' | 'revoked' | 'revised' | 'faded';

export interface Thought {
  id: string;
  storyId: string;
  owner: string;
  seq: number;
  text: string;
  tags: string[];
  pinned: boolean;
  status: ThoughtStatus;
  source: 'self' | 'seed' | 'compactor' | 'user';
  kind: ThoughtKind;
  /** 1–10 as written; the current importance fades (docs/11 §5.7). */
  importance: number;
  /** The object id it is about (opinions, feelings), or null. */
  about: string | null;
  createdTurnId: string | null;
  /** In-story time it was written (game-clock minutes); null for older thoughts. */
  createdClockMin: number | null;
  /** In-story time it was written, revised or last came up. */
  renewedClockMin: number | null;
  /** The thought this one replaced. */
  revises: string | null;
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

// ---- Importance and fading (docs/11 §5.7) ----

/** Does this thought fade at all? Agenda items, pinned thoughts and importance 8–10 don't. */
export function fades(t: Pick<Thought, 'kind' | 'pinned' | 'importance' | 'owner'>): boolean {
  return t.kind !== 'agenda' && !t.pinned && t.importance < NEVER_FADES && t.owner !== 'narrator';
}

/** Importance now: one point lost per `fadeHours` in-story hours since it was renewed. */
export function currentImportance(t: Pick<Thought, 'kind' | 'pinned' | 'importance' | 'owner' | 'renewedClockMin' | 'createdClockMin'>, clockMin: number | null | undefined, fadeHours: number): number {
  if (!fades(t) || clockMin == null || fadeHours <= 0) return t.importance;
  const since = t.renewedClockMin ?? t.createdClockMin;
  if (since == null) return t.importance;
  const lost = Math.floor(Math.max(0, clockMin - since) / (fadeHours * 60));
  return Math.max(0, t.importance - lost);
}

/** Always on its owner's mind (shown once per thread window, like pinned, docs/11 §5.9). */
export const alwaysOn = (t: Pick<Thought, 'kind' | 'pinned' | 'importance'>) => t.pinned || t.kind === 'agenda' || t.importance >= ALWAYS_ON;

// ---- Writing ----

export interface PreparedThought {
  text: string;
  tags: string[];
  pinned: boolean;
  kind: ThoughtKind;
  importance: number;
  /** The #handle (without '#') it is about, checked against the roster. */
  aboutHandle?: string;
  notes: string[];
}

/**
 * Normalize a remember op: text ≤ 40 words, kind and importance clamped, tags normalized and capped, `#x` tags and
 * `about` checked against the roster (unknown → plain tag / dropped), the `about` person added as a tag, untagged
 * notes pinned. Returns undefined when nothing usable is left.
 */
export function prepareRemember(op: RememberOp, rosterHandles: Set<string>): PreparedThought | undefined {
  const notes: string[] = [];
  const clamped = clampWords(op.text.replace(/\s+/g, ' '), MAX_THOUGHT_WORDS);
  if (!clamped.text) return undefined;
  if (clamped.clamped) notes.push(`shortened to ${MAX_THOUGHT_WORDS} words`);
  let kind = normalizeKind(op.kind);
  const importance = clampImportance(op.importance);
  let aboutHandle: string | undefined;
  if (op.about?.trim()) {
    const a = normalizeTag(op.about.trim().startsWith('#') ? op.about.trim() : `#${op.about.trim()}`).slice(1);
    if (a && rosterHandles.has(a)) aboutHandle = a;
    else notes.push(`no one/nothing is called #${a || op.about.trim()}; kept without "about"`);
  }
  if (kind === 'opinion' && !aboutHandle) kind = 'note';
  const tags: string[] = [];
  const addTag = (tag: string) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };
  if (aboutHandle) addTag(`#${aboutHandle}`);
  for (const raw of op.tags ?? []) {
    let tag = normalizeTag(raw);
    if (!tag) continue;
    if (tag.startsWith('#') && !rosterHandles.has(tag.slice(1))) {
      notes.push(`no one/nothing is called ${tag}; kept as the tag '${tag.slice(1)}'`);
      tag = tag.slice(1);
    }
    addTag(tag);
  }
  if (tags.length > MAX_TAGS) {
    notes.push(`only the first ${MAX_TAGS} tags were kept`);
    tags.length = MAX_TAGS;
  }
  return { text: clamped.text, tags, pinned: !!op.pin || (tags.length === 0 && kind === 'note'), kind, importance, ...(aboutHandle ? { aboutHandle } : {}), notes };
}

// ---- Reading ----

export interface RenderOpts {
  /** The handle (without '#') of who/what it is about. */
  aboutHandle?: string | null;
  /** The current importance, when it differs from the written one. */
  current?: number;
}

/**
 * "t12 · Day 2, 19:40 · opinion of #agnes, 7/10 [caseworker] She says what the file says." (docs/11 §5.9)
 * Agenda: "t3 · agenda [kettle] Get the kettle." A note: "t9 · Day 1, 08:10 · 5/10 [kettle] …".
 */
export function renderThought(t: Pick<Thought, 'seq' | 'tags' | 'text'> & Partial<Pick<Thought, 'kind' | 'importance' | 'createdClockMin'>>, opts: RenderOpts = {}): string {
  const when = t.createdClockMin != null ? ` · ${formatGameClock(t.createdClockMin)}` : '';
  const kind = t.kind ?? 'note';
  const imp = opts.current ?? t.importance;
  const about = opts.aboutHandle ? `#${opts.aboutHandle}` : '';
  let label = '';
  if (kind === 'agenda') label = ' · agenda';
  else if (imp !== undefined) {
    const head = kind === 'opinion' ? `opinion${about ? ` of ${about}` : ''}` : kind === 'feeling' ? `feeling${about ? ` about ${about}` : ''}` : '';
    label = ` · ${head ? `${head}, ` : ''}${imp}/10`;
  }
  const tags = t.tags.filter((g) => !about || g !== about);
  return `${thoughtHandle(t)}${when}${label}${tags.length ? ` [${tags.join(', ')}]` : ''} ${t.text}`;
}

export interface RecallOpts {
  /** Current importance of a thought (fading applied). */
  current?: (t: Thought) => number;
  /** Object ids present this round: a thought about one of them is more relevant. */
  present?: Set<string>;
}

/**
 * Which thoughts come back this round (docs/11 §5.4, §5.9): active, not always on, sharing at least one tag with the
 * active set (or about someone present), not shown since the last compaction. Score = 2 × matching tags + 2 if about
 * someone present + current importance ÷ 2 + recency; take the best within budget.
 */
export function selectRecall(thoughts: Thought[], activeTags: Set<string>, alreadyShown: Set<string>, budgetTokens: number, opts: RecallOpts = {}): Thought[] {
  const current = opts.current ?? ((t: Thought) => t.importance);
  const aboutPresent = (t: Thought) => !!t.about && !!opts.present?.has(t.about);
  const candidates = thoughts.filter(
    (t) => t.status === 'active' && !alwaysOn(t) && !alreadyShown.has(t.id) && current(t) > 0 && (t.tags.some((g) => activeTags.has(g)) || aboutPresent(t)),
  );
  if (!candidates.length) return [];
  const maxSeq = Math.max(...candidates.map((t) => t.seq));
  const scored = candidates
    .map((t) => ({ t, score: 2 * t.tags.filter((g) => activeTags.has(g)).length + (aboutPresent(t) ? 2 : 0) + current(t) / 2 + t.seq / (maxSeq + 1) }))
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
