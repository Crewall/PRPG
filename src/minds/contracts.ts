import { z } from 'zod';
import { extractJson } from '../llm/jsonCall.ts';
import { clampWords } from './text.ts';
import type { VarOp, VarOpKind } from './variables.ts';

// The round's contracts (docs/10 §6, §9): player input lanes, the character
// reply, the narrator's round block. AI output is parsed leniently — field by
// field, nulls tolerated — so one bad field never costs the whole round.

// ---- Player input (docs/10 §6) ----

export interface PlayerDeclaration {
  /** Spoken words: text inside "…" (or “…”). Heard by the characters present. */
  say: string;
  /** Everything else: what the player tries to do. Only the narrator sees it. */
  do: string;
  /** Text inside ((…)): an out-of-character note to the narrator. */
  ooc: string;
}

export function parsePlayerInput(text: string): PlayerDeclaration {
  const ooc: string[] = [];
  let rest = text.replace(/\(\(([\s\S]*?)\)\)/g, (_m, inner: string) => {
    ooc.push(inner.trim());
    return ' ';
  });
  const say: string[] = [];
  rest = rest.replace(/["“]([^"”]*)["”]/g, (_m, inner: string) => {
    if (inner.trim()) say.push(inner.trim());
    return ' … ';
  });
  const doText = rest
    .replace(/(\s*…\s*)+/g, ' … ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s…,.;:]+|[\s…,;:]+$/g, '')
    .trim();
  return { say: say.join(' '), do: doText, ooc: ooc.filter(Boolean).join(' ') };
}

// ---- Lenient parsing helpers ----

/** Drop nulls (keys and array entries) so optional fields parse. */
export function stripNulls(x: unknown): unknown {
  if (Array.isArray(x)) return x.filter((v) => v !== null).map(stripNulls);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return x;
}

/** Parse an object field by field: valid fields kept, broken ones defaulted and reported. */
function parseFields<T extends z.ZodRawShape>(shape: T, raw: unknown): { value: z.infer<z.ZodObject<T>>; problems: string[] } {
  const cleaned = stripNulls(raw);
  const obj = (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) ? cleaned : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const r = (schema as z.ZodTypeAny).safeParse(obj[key]);
    if (r.success) out[key] = r.data;
    else {
      problems.push(`${key}: ${r.error.issues[0]?.message ?? 'invalid'}`);
      out[key] = (schema as z.ZodTypeAny).safeParse(undefined).data;
    }
  }
  return { value: out as z.infer<z.ZodObject<T>>, problems };
}

const Str = z.string();
const VarEntry = z
  .object({
    key: z.string().min(1),
    who: z.string().optional(),
    set: z.unknown().optional(),
    delta: z.unknown().optional(),
    add: z.unknown().optional(),
    remove: z.unknown().optional(),
    toggle: z.unknown().optional(),
    why: z.string().optional(),
  })
  .passthrough();
export type VarEntry = z.infer<typeof VarEntry>;
/** A list that keeps its valid entries and drops broken ones. */
const listOf = <S extends z.ZodTypeAny>(item: S) =>
  z
    .array(z.unknown())
    .default([])
    .transform((xs) => xs.map((x) => item.safeParse(x)).filter((r) => r.success).map((r) => (r as z.SafeParseSuccess<z.infer<S>>).data));
const Remember = z.object({ text: z.string().min(1), tags: z.array(z.string()).default([]), pin: z.boolean().default(false) });
const Forget = z.union([z.string(), z.number()]).transform(String);

// ---- The character's reply (docs/10 §9.1) ----

const CharacterReplyShape = {
  say: Str.default(''),
  to: Str.optional(),
  intent: Str.default(''),
  state: Str.optional(),
  vars: listOf(VarEntry),
  remember: listOf(Remember),
  forget: listOf(Forget),
};
export type CharacterReply = z.infer<z.ZodObject<typeof CharacterReplyShape>>;

/** The reply's shape as sent to providers that enforce structured outputs (parsing stays lenient). */
export const CharacterReplyWire = z.object({
  say: z.string(),
  to: z.string().optional(),
  intent: z.string(),
  state: z.string().optional(),
  vars: z
    .array(
      z.object({
        key: z.string(),
        set: z.union([z.string(), z.number(), z.boolean()]).optional(),
        delta: z.number().optional(),
        add: z.string().optional(),
        remove: z.string().optional(),
        why: z.string().optional(),
      }),
    )
    .optional(),
  remember: z.array(z.object({ text: z.string(), tags: z.array(z.string()), pin: z.boolean().optional() })).optional(),
  forget: z.array(z.string()).optional(),
});

/** Accepts anything JSON: AI replies are salvaged, never rejected wholesale. */
export const CharacterReplySchema = z.unknown().transform((raw) => parseCharacterReply(raw));

/** Parse + clamp a character's reply (say ≤ 80 words, intent and state ≤ 25). */
export function parseCharacterReply(raw: unknown): CharacterReply & { problems: string[] } {
  const { value, problems } = parseFields(CharacterReplyShape, raw);
  const say = clampWords(value.say, 80).text;
  const intent = clampWords(value.intent, 25).text;
  const state = value.state ? clampWords(value.state, 25).text : undefined;
  const to = value.to?.trim() ? (value.to.trim().startsWith('#') ? value.to.trim() : `#${value.to.trim()}`) : undefined;
  return { ...value, say, intent, state, to, problems };
}

// ---- The narrator's round block (docs/10 §9.3) ----

const RoundBlockShape = {
  briefs: z.record(z.string(), Str).default({}),
  spotlight: z.array(Str).default([]),
  state: z.record(z.string(), Str).default({}),
  vars: listOf(VarEntry),
  tags: z.array(Str).default([]),
  evoke: z.record(z.string(), z.array(Str)).default({}),
  notes: z.object({ remember: listOf(Remember), forget: listOf(Forget) }).default({}),
  cast: z
    .object({
      enter: listOf(
        z.object({
          name: z.string().min(1),
          appearance: Str.default(''),
          pronouns: Str.default(''),
          knownAs: Str.default(''),
          knows: z.array(Str).default([]),
          knownBy: z.array(Str).default([]),
        }),
      ),
      exit: z.array(Str).default([]),
    })
    .default({}),
  objects: listOf(z.object({ name: z.string().min(1), type: Str.default('item'), line: Str.default('') })),
  scene: z
    .object({
      break: z.boolean().default(false),
      title: Str.optional(),
      location: Str.optional(),
      items: z.array(Str).optional(),
    })
    .default({}),
  time: z.number().min(0).max(7 * 24 * 60).optional(),
  /** The player character, created or completed by the narrator (docs/11 §2.1): fills only empty fields. */
  player: z.object({ name: Str.optional(), pronouns: Str.optional(), appearance: Str.optional(), knownAs: Str.optional() }).optional(),
  /** Names learned other than by hearing them: { "#learner": ["#whose name"] } (docs/11 §2.5). */
  names: z.record(z.string(), z.array(Str)).default({}),
};
export type RoundBlock = z.infer<z.ZodObject<typeof RoundBlockShape>>;

export function parseRoundBlock(raw: unknown): { block: RoundBlock; problems: string[] } {
  const { value, problems } = parseFields(RoundBlockShape, raw);
  return { block: value, problems };
}

/** An empty block (nothing changes). */
export const emptyBlock = (): RoundBlock => parseRoundBlock({}).block;

/** For the distributor: the same block, any JSON accepted and salvaged. */
export const RoundBlockSchema = z.unknown().transform((raw) => parseRoundBlock(raw).block);

/**
 * Split the narrator's reply into the prose the player reads and the raw round
 * block. The prose is everything before the first ``` fence (exactly what the
 * streaming gate showed). The block is the ```round fence, or a fenced/trailing
 * JSON object with "briefs"; an unclosed fence (cut-off reply) is still tried.
 */
export function splitNarratorReply(text: string): { prose: string; rawBlock?: string } {
  const prose = text.split('```')[0].trim();
  const fenced = text.match(/```\s*(?:round|json)?\s*\n?([\s\S]*?)(?:```|$)/i);
  if (fenced && fenced[1].includes('{')) return { prose, rawBlock: fenced[1].trim() };
  const trailing = text.lastIndexOf('{"briefs"');
  if (trailing >= 0) return { prose: text.slice(0, trailing).trim(), rawBlock: text.slice(trailing) };
  return { prose };
}

/** Parse a raw block string; undefined when it is not JSON at all. */
export function readRoundBlock(rawBlock: string | undefined): { block: RoundBlock; problems: string[] } | undefined {
  if (!rawBlock) return undefined;
  try {
    return parseRoundBlock(JSON.parse(extractJson(rawBlock)));
  } catch {
    return undefined;
  }
}

// ---- Variable entries → pipeline ops ----

const OP_ORDER: VarOpKind[] = ['set', 'delta', 'add', 'remove', 'toggle'];

/** One reply entry ({key, set|delta|add|remove|toggle, why}) as a pipeline op for `holder`. */
export function entryToOp(entry: VarEntry, holder: string): VarOp | undefined {
  for (const op of OP_ORDER) {
    if (op === 'toggle' ? entry.toggle !== undefined : (entry as Record<string, unknown>)[op] !== undefined) {
      return { holder, key: entry.key, op, value: op === 'toggle' ? undefined : (entry as Record<string, unknown>)[op], why: entry.why };
    }
  }
  return undefined;
}

// ---- Dialogue mode (docs/10 §7, §9.2) ----

const DialogueReplyShape = {
  say: Str.default(''),
  gesture: Str.default(''),
  state: Str.optional(),
  remember: listOf(Remember),
  forget: listOf(Forget),
  act: Str.optional(),
};
export type DialogueReply = z.infer<z.ZodObject<typeof DialogueReplyShape>>;

/** Parse + clamp a conversation reply (say ≤ 80 words, gesture ≤ 15, state and act ≤ 25). */
export function parseDialogueReply(raw: unknown): DialogueReply & { problems: string[] } {
  const { value, problems } = parseFields(DialogueReplyShape, raw);
  const act = value.act?.trim() ? clampWords(value.act, 25).text : undefined;
  return {
    ...value,
    say: clampWords(value.say, 80).text,
    gesture: clampWords(value.gesture, 15).text,
    state: value.state?.trim() ? clampWords(value.state, 25).text : undefined,
    act,
    problems,
  };
}
export const DialogueReplySchema = z.unknown().transform((raw) => parseDialogueReply(raw));

export const DialogueReplyWire = z.object({
  say: z.string(),
  gesture: z.string().optional(),
  state: z.string().optional(),
  remember: z.array(z.object({ text: z.string(), tags: z.array(z.string()), pin: z.boolean().optional() })).optional(),
  forget: z.array(z.string()).optional(),
  act: z.string().optional(),
});

// ---- The director: who the player's words are meant for (docs/10 §5.1b) ----

export interface Direction {
  /** #handles (resolved to object ids by the round) the player's words are meant for. */
  to: string[];
  /** The player addressed everyone present. */
  all: boolean;
  /** People not spoken to who would plausibly react anyway. */
  react: string[];
  why: string;
}

export const DirectionReply = z.unknown().transform((raw): Direction => {
  const r = (stripNulls(raw) && typeof raw === 'object' ? (stripNulls(raw) as Record<string, unknown>) : {}) as Record<string, unknown>;
  const handles = (x: unknown) => (Array.isArray(x) ? x : typeof x === 'string' && x.trim() ? [x] : []).filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
  return { to: handles(r.to), all: r.all === true, react: handles(r.react), why: typeof r.why === 'string' ? r.why.slice(0, 200) : '' };
});
