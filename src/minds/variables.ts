import { z } from 'zod';
import { clampWords, normalizeTag } from './text.ts';

// Scenario variables (docs/11 §4): definitions, validation, visibility, the
// change pipeline and rendering. Pure — the store and service do the I/O.

const Key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'key: lowercase letters, digits and _ (start with a letter, ≤ 32 chars)');
const Changer = z.enum(['narrator', 'self']);

const Base = z.object({
  key: Key,
  label: z.string().min(1),
  /** For the AIs: what it means, what the ends of the range mean. */
  description: z.string().default(''),
  /** For the AIs: when and how to change it. */
  changeGuide: z.string().default(''),
  scope: z.enum(['character', 'world']).default('character'),
  /** Character scope: 'all' | 'player' | 'npcs' | a list of handles (without '#'). */
  appliesTo: z.union([z.enum(['all', 'player', 'npcs']), z.array(z.string().min(1))]).default('all'),
  visibility: z.enum(['public', 'self', 'hidden']).default('self'),
  changedBy: z.array(Changer).default(['narrator']),
  order: z.number().int().default(0),
});

const Band = z.object({ upTo: z.number(), label: z.string().min(1) });

export const VariableDef = z.discriminatedUnion('type', [
  Base.extend({
    type: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().default(1),
    unit: z.string().optional(),
    /** Largest change one AI may make in one round. */
    maxStep: z.number().positive().optional(),
    /** Labelled ranges, ascending by upTo: rendered next to the value. */
    bands: z.array(Band).optional(),
    default: z.number().optional(),
  }),
  Base.extend({ type: z.literal('text'), maxWords: z.number().int().positive().default(8), default: z.string().optional() }),
  Base.extend({ type: z.literal('choice'), options: z.array(z.string().min(1)).min(2, 'a choice needs at least 2 options'), default: z.string().optional() }),
  Base.extend({ type: z.literal('flag'), default: z.boolean().optional() }),
  Base.extend({
    type: z.literal('list'),
    maxItems: z.number().int().positive().default(10),
    itemMaxWords: z.number().int().positive().default(6),
    default: z.array(z.string()).optional(),
  }),
]);
export type VariableDef = z.infer<typeof VariableDef>;
export type VariableValue = number | string | boolean | string[];

/** The pseudo-variable for a character's one-sentence state (docs/11 §3). */
export const STATE_KEY = '$state';
export const STATE_DEF: VariableDef = VariableDef.parse({
  key: 'state',
  label: 'State',
  type: 'text',
  maxWords: 25,
  scope: 'character',
  visibility: 'self',
  changedBy: ['narrator', 'self'],
});

// ---- Definition validation (docs/11 §4.4) ----

/** Problems with one definition (empty = valid). */
export function defProblems(def: VariableDef): string[] {
  const p: string[] = [];
  const name = `'${def.key}'`;
  if (def.visibility === 'hidden' && def.changedBy.includes('self')) p.push(`${name}: a hidden variable can't be changed by its holder (they can't see it)`);
  if (def.scope === 'world') {
    if (def.changedBy.includes('self')) p.push(`${name}: a world variable can't be changed by 'self'`);
    if (def.visibility === 'self') p.push(`${name}: a world variable is 'public' or 'hidden', not 'self'`);
  }
  if (def.type === 'number' && def.min !== undefined && def.max !== undefined && def.min >= def.max) p.push(`${name}: min must be below max`);
  if (def.type === 'number' && def.bands) {
    for (let i = 1; i < def.bands.length; i++) if (def.bands[i].upTo <= def.bands[i - 1].upTo) p.push(`${name}: bands must be in ascending order`);
  }
  if (def.default !== undefined) {
    const check = coerce(def, def.default);
    if (!check.ok) p.push(`${name}: default ${check.reason}`);
    else if (check.clamped) p.push(`${name}: default is outside the allowed range or size`);
  }
  if (def.type === 'choice' && new Set(def.options.map((o) => o.toLowerCase())).size !== def.options.length) p.push(`${name}: duplicate options`);
  return p;
}

/** Validate a whole scenario; throws one readable Error listing every problem. */
export function validateDefs(defs: VariableDef[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.key)) problems.push(`duplicate key '${d.key}'`);
    seen.add(d.key);
    problems.push(...defProblems(d));
  }
  if (problems.length) throw new Error(problems.join('; '));
}

/** The value a holder has before anything changed it. */
export function defaultValue(def: VariableDef): VariableValue {
  switch (def.type) {
    case 'number': {
      const v = def.default ?? def.min ?? 0;
      return clampNumber(def, v).value;
    }
    case 'text':
      return def.default ?? '';
    case 'choice':
      return def.default ?? def.options[0];
    case 'flag':
      return def.default ?? false;
    case 'list':
      return def.default ?? [];
  }
}

// ---- Who holds and who sees ----

export interface HolderInfo {
  id: string; // object id, or 'world'
  isPlayer: boolean;
  handle?: string; // without '#'
}

/** Does this definition give `holder` a value? */
export function appliesTo(def: VariableDef, holder: HolderInfo): boolean {
  if (def.scope === 'world') return holder.id === 'world';
  if (holder.id === 'world') return false;
  const a = def.appliesTo;
  if (a === 'all') return true;
  if (a === 'player') return holder.isPlayer;
  if (a === 'npcs') return !holder.isPlayer;
  return !!holder.handle && a.map((h) => h.replace(/^#/, '').toLowerCase()).includes(holder.handle.toLowerCase());
}

export type Viewer =
  | { kind: 'narrator' }
  | { kind: 'character'; id: string } // an AI mind
  | { kind: 'player'; playerId: string | null } // the user in normal mode
  | { kind: 'advanced' }; // the user in advanced mode

/** May `viewer` see `holder`'s value of `def`? (docs/11 §1, §4.4) */
export function canSee(def: VariableDef, holderId: string, viewer: Viewer): boolean {
  if (viewer.kind === 'narrator' || viewer.kind === 'advanced') return true;
  if (def.visibility === 'hidden') return false;
  if (def.visibility === 'public') return true;
  // 'self' (character scope only)
  if (viewer.kind === 'character') return viewer.id === holderId;
  return viewer.playerId !== null && viewer.playerId === holderId;
}

// ---- The change pipeline (docs/11 §4.6) ----

export const VarOpKind = z.enum(['set', 'delta', 'add', 'remove', 'toggle']);
export type VarOpKind = z.infer<typeof VarOpKind>;

export interface VarOp {
  holder: string; // object id or 'world'
  key: string; // a def key, or STATE_KEY
  op: VarOpKind;
  value?: unknown;
  why?: string;
}

export type ChangedBy = 'narrator' | 'self' | 'user' | 'seed' | 'system';
export interface Proposal {
  change: VarOp;
  by: ChangedBy;
  /** For 'self': the character proposing (must be the holder). */
  proposer?: string;
}

export type ChangeResult = 'applied' | 'clamped' | 'rejected' | 'overridden';
export interface ChangeOutcome {
  proposal: Proposal;
  result: ChangeResult;
  old?: VariableValue;
  new?: VariableValue;
  reason: string;
}

interface Coerced {
  ok: boolean;
  value?: VariableValue;
  clamped?: boolean;
  reason?: string;
}

function clampNumber(def: Extract<VariableDef, { type: 'number' }>, v: number): { value: number; clamped: boolean } {
  let value = v;
  if (def.step === 1 || Number.isInteger(def.step)) value = Math.round(value / def.step) * def.step;
  if (def.min !== undefined && value < def.min) value = def.min;
  if (def.max !== undefined && value > def.max) value = def.max;
  return { value, clamped: value !== v };
}

function toNumber(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return undefined;
}

function toBool(x: unknown): boolean | undefined {
  if (typeof x === 'boolean') return x;
  if (x === 'true' || x === 'yes') return true;
  if (x === 'false' || x === 'no') return false;
  return undefined;
}

/** Validate/clamp a full value for a definition (used by 'set' and defaults). */
function coerce(def: VariableDef, raw: unknown): Coerced {
  switch (def.type) {
    case 'number': {
      const n = toNumber(raw);
      if (n === undefined) return { ok: false, reason: 'must be a number' };
      const c = clampNumber(def, n);
      return { ok: true, value: c.value, clamped: c.clamped };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, reason: 'must be text' };
      const c = clampWords(raw, def.maxWords);
      return { ok: true, value: c.text, clamped: c.clamped };
    }
    case 'choice': {
      if (typeof raw !== 'string') return { ok: false, reason: `must be one of: ${def.options.join(', ')}` };
      const hit = def.options.find((o) => o.toLowerCase() === raw.trim().toLowerCase());
      return hit ? { ok: true, value: hit } : { ok: false, reason: `must be one of: ${def.options.join(', ')}` };
    }
    case 'flag': {
      const b = toBool(raw);
      return b === undefined ? { ok: false, reason: 'must be true or false' } : { ok: true, value: b };
    }
    case 'list': {
      if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) return { ok: false, reason: 'must be a list of short texts' };
      let clamped = raw.length > def.maxItems;
      const items = (raw as string[]).slice(0, def.maxItems).map((x) => {
        const c = clampWords(x, def.itemMaxWords);
        if (c.clamped) clamped = true;
        return c.text;
      }).filter(Boolean);
      return { ok: true, value: items, clamped };
    }
  }
}

const isAi = (by: ChangedBy) => by === 'narrator' || by === 'self';

/** Apply one op to the current value. */
function applyOp(def: VariableDef, current: VariableValue, op: VarOp, by: ChangedBy): Coerced {
  const step = def.type === 'number' && isAi(by) ? def.maxStep : undefined;
  switch (op.op) {
    case 'set': {
      const c = coerce(def, op.value);
      if (!c.ok || step === undefined) return c;
      const diff = (c.value as number) - (current as number);
      if (Math.abs(diff) <= step) return c;
      return { ok: true, value: clampNumber(def as Extract<VariableDef, { type: 'number' }>, (current as number) + Math.sign(diff) * step).value, clamped: true };
    }
    case 'delta': {
      if (def.type !== 'number') return { ok: false, reason: `'delta' only works on numbers` };
      const d = toNumber(op.value);
      if (d === undefined) return { ok: false, reason: 'delta must be a number' };
      const limited = step !== undefined && Math.abs(d) > step ? Math.sign(d) * step : d;
      const c = clampNumber(def, (current as number) + limited);
      return { ok: true, value: c.value, clamped: c.clamped || limited !== d };
    }
    case 'toggle':
      if (def.type !== 'flag') return { ok: false, reason: `'toggle' only works on flags` };
      return { ok: true, value: !(current as boolean) };
    case 'add':
    case 'remove': {
      if (def.type !== 'list') return { ok: false, reason: `'${op.op}' only works on lists` };
      if (typeof op.value !== 'string' || !op.value.trim()) return { ok: false, reason: 'the item must be a short text' };
      const list = current as string[];
      const item = clampWords(op.value, def.itemMaxWords);
      const idx = list.findIndex((x) => x.toLowerCase() === item.text.toLowerCase());
      if (op.op === 'remove') {
        if (idx < 0) return { ok: false, reason: `'${item.text}' is not in the list` };
        return { ok: true, value: list.filter((_, i) => i !== idx) };
      }
      if (idx >= 0) return { ok: true, value: list };
      if (list.length >= def.maxItems) return { ok: false, reason: `the list is full (${def.maxItems} items)` };
      return { ok: true, value: [...list, item.text], clamped: item.clamped };
    }
  }
}

export interface PipelineInput {
  defs: VariableDef[];
  holders: Map<string, HolderInfo>; // includes 'world'
  /** Current value, or undefined when the holder still has the default. */
  current(key: string, holder: string): VariableValue | undefined;
  /** Current state sentence of a character. */
  currentState(holder: string): string;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Run proposals through the rules (docs/11 §4.6) and return every outcome plus
 * the final values. Pass a round's proposals in order: characters' first, then
 * the narrator's. A narrator change is computed from the value at the start of
 * the batch (the state the narrator saw) and makes an earlier change by the
 * holder to the same key 'overridden'. 'user', 'seed' and 'system' bypass the
 * changer rules and maxStep, never the type and range checks.
 */
export function runPipeline(input: PipelineInput, proposals: Proposal[]): { outcomes: ChangeOutcome[]; finals: Map<string, VariableValue> } {
  const defsByKey = new Map(input.defs.map((d) => [d.key, d]));
  const finals = new Map<string, VariableValue>(); // `${holder}\u0000${key}` → value
  const outcomes: ChangeOutcome[] = [];
  const lastSelf = new Map<string, ChangeOutcome>();
  const id = (holder: string, key: string) => `${holder}\u0000${key}`;
  const start = (def: VariableDef, holder: string, key: string): VariableValue =>
    key === STATE_KEY ? input.currentState(holder) : input.current(key, holder) ?? defaultValue(def);

  for (const proposal of proposals) {
    const { change, by } = proposal;
    const reject = (reason: string) => outcomes.push({ proposal, result: 'rejected', reason });
    const def = change.key === STATE_KEY ? STATE_DEF : defsByKey.get(change.key);
    if (!def) {
      reject(`there is no variable '${change.key}'`);
      continue;
    }
    const holder = input.holders.get(change.holder);
    if (!holder || !appliesTo(def, holder)) {
      reject(`'${change.key}' does not apply to ${change.holder === 'world' ? 'the world' : 'this character'}`);
      continue;
    }
    if (by === 'narrator' && !def.changedBy.includes('narrator')) {
      reject(`the narrator may not change '${change.key}'`);
      continue;
    }
    if (by === 'self') {
      if (!def.changedBy.includes('self') || def.visibility === 'hidden' || def.scope === 'world') {
        reject(`you can't change '${change.key === STATE_KEY ? 'state' : change.key}'`);
        continue;
      }
      if (proposal.proposer !== change.holder) {
        reject(`you can only change your own '${change.key}'`);
        continue;
      }
    }
    const k = id(change.holder, change.key);
    const roundStart = start(def, change.holder, change.key);
    const base = by === 'narrator' ? roundStart : finals.get(k) ?? roundStart;
    const r = applyOp(def, base, change, by);
    if (!r.ok) {
      reject(r.reason ?? 'invalid value');
      continue;
    }
    const outcome: ChangeOutcome = { proposal, result: r.clamped ? 'clamped' : 'applied', old: base, new: r.value, reason: change.why ?? '' };
    if (r.clamped) outcome.reason = `${change.why ? change.why + ' — ' : ''}adjusted to the allowed range/size`;
    outcomes.push(outcome);
    finals.set(k, r.value!);
    if (by === 'self') lastSelf.set(k, outcome);
    if (by === 'narrator') {
      const earlier = lastSelf.get(k);
      if (earlier && !sameValue(earlier.new, r.value)) {
        earlier.result = 'overridden';
        earlier.reason = `${earlier.reason ? earlier.reason + ' — ' : ''}the narrator set it this round`;
      }
      outcome.old = roundStart;
    }
  }
  return { outcomes, finals };
}

/** Parse a "holder|key" final-map id. */
export function splitFinalId(fid: string): { holder: string; key: string } {
  const [holder, key] = fid.split('\u0000');
  return { holder, key };
}

// ---- Rendering for prompts and the UI (docs/11 §4.5) ----

export function bandLabel(def: VariableDef, value: VariableValue): string | undefined {
  if (def.type !== 'number' || !def.bands || typeof value !== 'number') return undefined;
  return def.bands.find((b) => value <= b.upTo)?.label;
}

/** "4/10 (hurt)" · "\"cornered\"" · "[ledger, kitchen knife]" · "true" */
export function renderValue(def: VariableDef, value: VariableValue): string {
  switch (def.type) {
    case 'number': {
      const unit = def.unit ? ` ${def.unit}` : '';
      const range = def.max !== undefined && (def.min ?? 0) === 0 ? `/${def.max}` : '';
      const band = bandLabel(def, value);
      return `${value}${range}${unit}${band ? ` (${band})` : ''}`;
    }
    case 'text':
      return `"${value}"`;
    case 'choice':
      return String(value);
    case 'flag':
      return value ? 'yes' : 'no';
    case 'list':
      return `[${(value as string[]).join(', ')}]`;
  }
}

/** "health (0–10; 0–2 critical, 3–5 hurt, 6–10 fine)" — the range part of a definition line. */
export function renderRange(def: VariableDef): string {
  switch (def.type) {
    case 'number': {
      const parts: string[] = [];
      if (def.min !== undefined && def.max !== undefined) parts.push(`${def.min}–${def.max}`);
      else if (def.min !== undefined) parts.push(`≥ ${def.min}`);
      else if (def.max !== undefined) parts.push(`≤ ${def.max}`);
      else parts.push('a number');
      if (def.bands?.length) {
        let lo = def.min;
        const bands = def.bands.map((b) => {
          const label = `${lo !== undefined ? `${lo}–` : '≤ '}${b.upTo} ${b.label}`;
          lo = b.upTo + (def.step ?? 1);
          return label;
        });
        parts.push(bands.join(', '));
      }
      return parts.join('; ');
    }
    case 'text':
      return 'a few words';
    case 'choice':
      return `one of: ${def.options.join(' / ')}`;
    case 'flag':
      return 'yes/no';
    case 'list':
      return 'a list';
  }
}

/** Tags normalized for an appliesTo list ("#Marta" → "marta"). */
export function normalizeAppliesTo(a: VariableDef['appliesTo']): VariableDef['appliesTo'] {
  return Array.isArray(a) ? a.map((h) => normalizeTag(h.startsWith('#') ? h : `#${h}`).slice(1)).filter(Boolean) : a;
}
