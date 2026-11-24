import type { StoryStore } from '../db/stores/storyStore.ts';
import { handleBaseFor, knowsName, namesOn } from './names.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { SheetStore, ThoughtStore, VariableStore, CharacterSheet, SheetPatch, NameStore, TieStore, MetStore } from '../db/stores/mindsStore.ts';
import { REL, STATE_KEY, appliesTo, canSee, defaultValue, relationHolder, renderValue, runPipeline, splitFinalId } from './variables.ts';
import type { ChangeOutcome, HolderInfo, Proposal, VariableDef, VariableValue, Viewer } from './variables.ts';
import {
  HORIZON_ROUNDS,
  MAX_EXPECTATIONS,
  MAX_RAISE,
  OPINION_CAP,
  MAX_AGENDA,
  MAX_FORGET_PER_REPLY,
  MAX_REMEMBER_PER_REPLY,
  MAX_REVISE_PER_REPLY,
  clampImportance,
  currentImportance,
  fades,
  normalizeKind,
  normalizeHope,
  normalizeHorizon,
  parseThoughtHandle,
  prepareRemember,
  renderThought,
  thoughtHandle,
} from './thoughts.ts';
import type { RememberOp, ReviseOp, Thought } from './thoughts.ts';
import { normalizeTag } from './text.ts';

// The Minds data layer's operations (docs/11): sheets, variables and thoughts
// with their rules applied. Agents and the round (M4) call these; so does the API.

export interface MindsDeps {
  stories: StoryStore;
  memory: MemoryStore;
  sheets: SheetStore;
  variables: VariableStore;
  thoughts: ThoughtStore;
  /** Who knows whose name (docs/11 §2.5). Absent: names are common knowledge. */
  names?: NameStore;
  /** How characters relate (docs/11 §2.6). */
  ties?: TieStore;
  /** Who has met whom: pairs for relation variables (docs/11 §4.9). */
  met?: MetStore;
}

/**
 * Every variable holder in the story: each character with a sheet, 'world', and for relation variables each
 * ordered pair of characters who have met or are tied ("<from>><to>", docs/11 §4.9).
 */
export function holdersFor(deps: MindsDeps, storyId: string): Map<string, HolderInfo> {
  const out = new Map<string, HolderInfo>([['world', { id: 'world', isPlayer: false }]]);
  for (const s of deps.sheets.listForStory(storyId)) {
    out.set(s.objectId, { id: s.objectId, isPlayer: s.isPlayer, handle: deps.memory.ensureHandle(s.objectId) });
  }
  for (const [a, b] of metPairs(deps, storyId)) {
    const x = out.get(a);
    const y = out.get(b);
    if (!x || !y) continue;
    const side = (h: HolderInfo) => ({ id: h.id, isPlayer: h.isPlayer, ...(h.handle ? { handle: h.handle } : {}) });
    out.set(`${a}${REL}${b}`, { id: `${a}${REL}${b}`, isPlayer: false, relation: { from: side(x), to: side(y) } });
    out.set(`${b}${REL}${a}`, { id: `${b}${REL}${a}`, isPlayer: false, relation: { from: side(y), to: side(x) } });
  }
  return out;
}

/** Pairs of characters who have met (present in the same round) or are tied, each once (docs/11 §4.9). */
export function metPairs(deps: MindsDeps, storyId: string): [string, string][] {
  const seen = new Set<string>();
  const out: [string, string][] = [];
  const add = (x: string, y: string) => {
    if (x === y) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    if (seen.has(`${a}${REL}${b}`)) return;
    seen.add(`${a}${REL}${b}`);
    out.push([a, b]);
  };
  for (const [a, b] of deps.met?.pairs(storyId) ?? []) add(a, b);
  for (const t of deps.ties?.listForStory(storyId) ?? []) add(t.holder, t.other);
  return out;
}

/** Whom `oid` has met (or is tied to). */
export function metWith(deps: MindsDeps, storyId: string, oid: string): string[] {
  return metPairs(deps, storyId).flatMap(([a, b]) => (a === oid ? [b] : b === oid ? [a] : []));
}

/** A holder's current value of a variable (stored, else the default). */
export function valueOf(deps: MindsDeps, storyId: string, def: VariableDef, holder: string): VariableValue {
  return deps.variables.getValue(storyId, def.key, holder) ?? defaultValue(def);
}

/**
 * Run proposed changes through the rules and persist the results: values,
 * state sentences, and every outcome in the change log (docs/11 §4.6–4.7).
 * Pass a round's proposals characters-first, narrator last.
 */
export function applyChanges(deps: MindsDeps, storyId: string, proposals: Proposal[], turnId: string | null = null): ChangeOutcome[] {
  const defs = deps.variables.listDefs(storyId);
  const holders = holdersFor(deps, storyId);
  const { outcomes, finals } = runPipeline(
    {
      defs,
      holders,
      current: (key, holder) => deps.variables.getValue(storyId, key, holder),
      currentState: (holder) => deps.sheets.get(holder)?.state ?? '',
    },
    proposals,
  );
  deps.variables.logOutcomes(storyId, turnId, outcomes);
  for (const [fid, value] of finals) {
    const { holder, key } = splitFinalId(fid);
    if (key === STATE_KEY) deps.sheets.upsert(storyId, holder, { state: String(value) });
    else deps.variables.setValue(storyId, key, holder, value, turnId);
  }
  return outcomes;
}

export interface ThoughtOpsResult {
  added: Thought[];
  revoked: Thought[];
  revised: Thought[];
  /** Plain-language notes for the owner's next round message ("Not kept: …"). */
  notes: string[];
  /** How expectations turned out, for the owner's next round message ("Surprise: …", docs/11 §5.11). */
  outcomes: string[];
}

/** How thoughts read right now: current importance (fading applied) and the rendered line (docs/11 §5.7, §5.9). */
export function thoughtLens(deps: MindsDeps, storyId: string) {
  const story = deps.stories.getStory(storyId);
  const fadeHours = story?.settings.minds.fadeHours ?? 8;
  const fadeRounds = story?.settings.minds.fadeRounds ?? 12;
  const clock = story?.clockMin ?? null;
  const turnIndex = deps.stories.lastTurn(storyId)?.index ?? null;
  const current = (t: Thought) => currentImportance(t, { clockMin: clock, turnIndex, fadeHours, fadeRounds });
  const aboutHandle = (t: Thought) => (t.about ? (deps.memory.getObject(t.about)?.handle ?? null) : null);
  const render = (t: Thought) => renderThought(t, { aboutHandle: aboutHandle(t), current: current(t) });
  return { current, aboutHandle, render, clock, turnIndex, fadeHours, fadeRounds };
}

/**
 * End of round (docs/11 §5.7, §5.11): thoughts whose current importance reached 0 fade; expectations past their
 * horizon expire. Run once per round, after the clock moved.
 */
export function fadeThoughts(deps: MindsDeps, storyId: string, turnId: string | null): Thought[] {
  const { current, clock, turnIndex } = thoughtLens(deps, storyId);
  const createdIndex = (t: Thought) => (t.createdTurnId ? deps.stories.getTurn(t.createdTurnId)?.index : undefined);
  const faded: Thought[] = [];
  for (const t of deps.thoughts.listActiveForStory(storyId)) {
    if (t.kind === 'expectation' && t.horizon !== 'later') {
      const born = createdIndex(t) ?? t.renewedTurnIndex ?? undefined;
      const rounds = born !== undefined && turnIndex != null ? turnIndex - born : 0;
      const newDay = t.createdClockMin != null && clock != null && Math.floor(clock / 1440) > Math.floor(t.createdClockMin / 1440);
      if ((t.horizon === 'soon' && rounds >= HORIZON_ROUNDS.soon) || (t.horizon === 'today' && (rounds >= HORIZON_ROUNDS.today || newDay))) {
        deps.thoughts.setStatus(t.id, 'expired', turnId);
        faded.push({ ...t, status: 'expired' });
      }
      continue;
    }
    if (!fades(t) || current(t) > 0) continue;
    deps.thoughts.setStatus(t.id, 'faded', turnId);
    faded.push({ ...t, status: 'faded' });
  }
  return faded;
}

/**
 * The most a character may rate an opinion or feeling about `about` in play (docs/11 §5.7b): 7, or — when it
 * already held a stronger one before this scene (or from its seed) — that + 1.
 */
export function opinionCeiling(deps: MindsDeps, storyId: string, owner: string, about: string): number {
  const sceneId = deps.stories.getStory(storyId)?.currentSceneId ?? null;
  const sceneStart = sceneId ? (deps.stories.getScene(sceneId)?.createdAt ?? 0) : 0;
  let baseline = 0;
  for (const t of deps.thoughts.list(storyId, owner, { includeRevoked: true })) {
    if (t.about !== about || (t.kind !== 'opinion' && t.kind !== 'feeling') || t.status === 'revoked') continue;
    const turn = t.createdTurnId ? deps.stories.getTurn(t.createdTurnId) : undefined;
    const before = t.source === 'seed' || t.source === 'user' || (turn ? turn.sceneId !== sceneId : t.createdAt < sceneStart);
    if (before) baseline = Math.max(baseline, t.importance);
  }
  return Math.min(10, Math.max(OPINION_CAP, baseline + 1));
}

/**
 * Apply an owner's remember / revise / forget / outcomes operations (docs/11 §5.3, §5.6–5.8, §5.11). For the
 * owner's own replies (`source: 'self'`) the per-reply caps and the opinion ceilings apply; the active-thought,
 * agenda and expectation caps always do. Restating a thought word for word renews it instead of adding a copy.
 */
export function applyThoughtOps(
  deps: MindsDeps,
  storyId: string,
  owner: string,
  ops: { remember?: RememberOp[]; forget?: unknown[]; revise?: ReviseOp[]; outcomes?: Record<string, unknown> },
  source: Thought['source'],
  turnId: string | null = null,
): ThoughtOpsResult {
  const story = deps.stories.getStory(storyId);
  const clock = story?.clockMin ?? null;
  const maxActive = story?.settings.minds.maxActiveThoughts ?? 80;
  const result: ThoughtOpsResult = { added: [], revoked: [], revised: [], notes: [], outcomes: [] };
  const remember = ops.remember ?? [];
  const forget = ops.forget ?? [];
  const revise = ops.revise ?? [];
  const selfCaps = source === 'self';
  const handles = deps.memory.listHandles(storyId);
  const objectOf = (handle: string | undefined) => (handle ? (deps.memory.findByHandle(storyId, handle)?.id ?? null) : null);
  const agendaCount = () => deps.thoughts.list(storyId, owner).filter((t) => t.kind === 'agenda').length;
  const bySeq = (h: unknown) => {
    const seq = parseThoughtHandle(h);
    return seq === undefined ? undefined : deps.thoughts.bySeq(storyId, owner, seq);
  };
  /** In proportion (docs/11 §5.7b): what the owner writes in play about someone stays under its ceiling. */
  const held = (kind: Thought['kind'], about: string | null, importance: number, from?: number): number => {
    if (!selfCaps || !about || (kind !== 'opinion' && kind !== 'feeling')) return importance;
    let v = Math.min(importance, opinionCeiling(deps, storyId, owner, about));
    if (from !== undefined) v = Math.min(v, Math.max(from, from + MAX_RAISE));
    return v;
  };

  const forgetList = selfCaps && forget.length > MAX_FORGET_PER_REPLY ? forget.slice(0, MAX_FORGET_PER_REPLY) : forget;
  if (forgetList.length < forget.length) result.notes.push(`Only ${MAX_FORGET_PER_REPLY} thoughts can be forgotten at once; the rest were kept.`);
  for (const h of forgetList) {
    const t = bySeq(h);
    if (!t) {
      result.notes.push(`Not forgotten: you have no thought ${String(h)}.`);
      continue;
    }
    if (t.status !== 'active') continue;
    deps.thoughts.revoke(t.id, turnId);
    result.revoked.push({ ...t, status: 'revoked' });
  }

  // How expectations turned out, as the owner judges it (docs/11 §5.11). Lopsided on purpose: a miss weighs more.
  for (const [h, raw] of Object.entries(ops.outcomes ?? {})) {
    const outcome = String(raw ?? '').trim().toLowerCase();
    if (outcome !== 'met' && outcome !== 'missed') continue;
    const e = bySeq(h);
    if (!e || e.kind !== 'expectation' || e.status !== 'active') continue;
    deps.thoughts.setStatus(e.id, outcome, turnId);
    const basis = e.basis ? deps.thoughts.get(e.basis) : undefined;
    const live = basis && basis.status === 'active' ? basis : undefined;
    const ref = live ? ` (t${live.seq})` : '';
    if (outcome === 'met') {
      if (live) {
        deps.thoughts.update(live.id, { importance: held(live.kind, live.about, Math.min(10, live.importance + 1), live.importance) });
        deps.thoughts.renew([live.id], clock);
      }
      result.outcomes.push(
        e.hope === 'hope' ? `It came true, as you hoped (t${e.seq}): ${e.text}` : e.hope === 'fear' ? `What you feared happened (t${e.seq}): ${e.text}${live ? ` It weighs more on t${live.seq} now.` : ''}` : `As you expected (t${e.seq}): ${e.text}${live ? ` That bears out t${live.seq}.` : ''}`,
      );
    } else {
      if (live) deps.thoughts.update(live.id, { importance: Math.max(1, live.importance - 2) });
      const head = e.hope === 'fear' ? 'Relief: what you feared didn’t happen' : e.hope === 'hope' ? 'Disappointment: what you hoped for didn’t happen' : 'Surprise: you expected otherwise';
      result.outcomes.push(`${head} (t${e.seq}: ${e.text}).${live ? ` Rethink t${live.seq}${ref ? '' : ''} if you see it differently now.` : ''}`);
    }
  }

  // Revise: the old thought is kept as history; a new one takes its place (docs/11 §5.8).
  const reviseList = selfCaps && revise.length > MAX_REVISE_PER_REPLY ? revise.slice(0, MAX_REVISE_PER_REPLY) : revise;
  if (reviseList.length < revise.length) result.notes.push(`Only ${MAX_REVISE_PER_REPLY} thoughts can be revised at once; the rest were kept as they were.`);
  for (const op of reviseList) {
    const old = bySeq(op.id);
    if (!old || old.status !== 'active') {
      result.notes.push(`Not revised: you have no thought ${String(op.id)} in mind.`);
      continue;
    }
    const prepared = prepareRemember(
      {
        text: op.text?.trim() || old.text,
        tags: op.tags ?? old.tags.filter((g) => !old.about || g !== `#${deps.memory.getObject(old.about)?.handle}`),
        pin: old.pinned,
        kind: op.kind ?? old.kind,
        about: old.about ? (deps.memory.getObject(old.about)?.handle ?? undefined) : undefined,
        importance: op.importance ?? old.importance,
        confidence: old.confidence ?? undefined,
        hope: old.hope ?? undefined,
        horizon: old.horizon ?? undefined,
      },
      handles,
    );
    if (!prepared) continue;
    const about = objectOf(prepared.aboutHandle) ?? old.about;
    const importance = held(prepared.kind, about, prepared.importance, old.importance);
    if (importance < prepared.importance) result.notes.push(`t${old.seq}: kept at ${importance}/10 (a view of someone grows a little at a time).`);
    deps.thoughts.setStatus(old.id, 'revised', turnId);
    const t = deps.thoughts.insert(
      storyId,
      owner,
      {
        text: prepared.text, tags: prepared.tags, pinned: prepared.pinned, source, clockMin: clock, kind: prepared.kind, importance, about, revises: old.id,
        confidence: prepared.confidence ?? null, hope: prepared.hope ?? null, horizon: prepared.horizon ?? null, basis: old.basis,
      },
      turnId,
    );
    result.revised.push(t);
  }

  const rememberList = selfCaps && remember.length > MAX_REMEMBER_PER_REPLY ? remember.slice(0, MAX_REMEMBER_PER_REPLY) : remember;
  if (rememberList.length < remember.length) result.notes.push(`Only ${MAX_REMEMBER_PER_REPLY} new thoughts are kept per reply; the rest were dropped.`);
  const existing = new Map(deps.thoughts.list(storyId, owner).map((t) => [t.text.toLowerCase(), t]));
  for (const op of rememberList) {
    const prepared = prepareRemember(op, handles);
    if (!prepared) continue;
    const same = existing.get(prepared.text.toLowerCase());
    if (same) {
      deps.thoughts.renew([same.id], clock); // restated: it came up again
      continue;
    }
    if (prepared.kind === 'agenda' && agendaCount() >= MAX_AGENDA) {
      result.notes.push(`Not kept as agenda: you already have ${MAX_AGENDA} goals. Drop or revise one first. ("${prepared.text}")`);
      continue;
    }
    if (deps.thoughts.countActive(storyId, owner) >= maxActive) {
      result.notes.push(`Not kept: you already hold ${maxActive} thoughts. Forget or merge some first.`);
      break;
    }
    if (prepared.kind === 'expectation') {
      // At most a few open expectations: the least important, oldest one gives way.
      const open = deps.thoughts.list(storyId, owner).filter((t) => t.kind === 'expectation');
      if (open.length >= MAX_EXPECTATIONS) {
        const out = [...open].sort((a, b) => a.importance - b.importance || a.seq - b.seq)[0];
        deps.thoughts.setStatus(out.id, 'expired', turnId);
      }
    }
    const about = objectOf(prepared.aboutHandle);
    const importance = held(prepared.kind, about, prepared.importance);
    if (importance < prepared.importance) result.notes.push(`"${prepared.text}" kept at ${importance}/10: a view of someone grows a little at a time.`);
    const basis = prepared.basisSeq !== undefined ? deps.thoughts.bySeq(storyId, owner, prepared.basisSeq)?.id ?? null : null;
    const t = deps.thoughts.insert(
      storyId,
      owner,
      {
        text: prepared.text, tags: prepared.tags, pinned: prepared.pinned, source, clockMin: clock, kind: prepared.kind, importance, about,
        confidence: prepared.confidence ?? null, hope: prepared.hope ?? null, horizon: prepared.horizon ?? null, basis,
      },
      turnId,
    );
    existing.set(prepared.text.toLowerCase(), t);
    result.added.push(t);
    for (const n of prepared.notes) result.notes.push(`${thoughtHandle(t)}: ${n}.`);
  }
  return result;
}

/** A user's edit of one thought (advanced mode): text, kind, importance, about, tags; an expectation's confidence, hope, horizon. */
export function editThought(
  deps: MindsDeps,
  storyId: string,
  t: Thought,
  patch: { text?: string; kind?: string; importance?: unknown; about?: string | null; tags?: string[]; confidence?: unknown; hope?: unknown; horizon?: unknown },
): void {
  const about =
    patch.about === undefined ? undefined : patch.about === null || !patch.about.trim() ? null : (deps.sheets.get(patch.about) ? patch.about : deps.memory.findByHandle(storyId, patch.about)?.id ?? null);
  // The subject is a tag too, so the thought comes back when they are around (docs/11 §5.9).
  const subject = about === undefined ? t.about : about;
  const subjectTag = subject ? `#${deps.memory.getObject(subject)?.handle ?? ''}` : '';
  const oldSubjectTag = t.about ? `#${deps.memory.getObject(t.about)?.handle ?? ''}` : '';
  let tags = patch.tags?.map((x) => normalizeTag(x)).filter(Boolean);
  if (about !== undefined && !tags) tags = t.tags.filter((g) => g !== oldSubjectTag);
  if (tags && subjectTag.length > 1 && !tags.includes(subjectTag)) tags = [subjectTag, ...tags];
  deps.thoughts.update(t.id, {
    ...(patch.text?.trim() ? { text: patch.text.trim() } : {}),
    ...(patch.kind !== undefined ? { kind: normalizeKind(patch.kind) } : {}),
    ...(patch.importance !== undefined ? { importance: clampImportance(patch.importance, t.importance) } : {}),
    ...(about !== undefined ? { about } : {}),
    ...(tags ? { tags } : {}),
    ...(patch.confidence !== undefined ? { confidence: clampImportance(patch.confidence, t.confidence ?? 5) } : {}),
    ...(patch.hope !== undefined ? { hope: normalizeHope(patch.hope) } : {}),
    ...(patch.horizon !== undefined ? { horizon: normalizeHorizon(patch.horizon) } : {}),
  });
}

/** Create a character: roster object (with handle) + sheet. `isPlayer` also marks it on the story. */
export function createCharacter(
  deps: MindsDeps,
  storyId: string,
  input: { name: string; isPlayer?: boolean; description?: string; appearance?: string; pronouns?: string; knownAs?: string; state?: string },
): CharacterSheet {
  // With names on, the handle comes from the known-as label, so it doesn't give the name away (docs/11 §2.5).
  const knownAs = input.knownAs?.trim() || (namesOn(deps, storyId) ? defaultKnownAs(input.appearance) : '');
  const obj = deps.memory.createObject(
    { storyId, type: 'character', name: input.name.trim(), aliases: [], summary: '', salience: 0.6, status: 'active' },
    { handleFrom: handleBaseFor(deps, storyId, input.name.trim(), knownAs) },
  );
  const sheet = deps.sheets.upsert(storyId, obj.id, {
    isPlayer: !!input.isPlayer,
    description: input.description ?? '',
    appearance: input.appearance ?? '',
    pronouns: input.pronouns?.trim() ?? '',
    knownAs,
    state: input.state ?? '',
  });
  if (input.isPlayer) deps.stories.updateStory(storyId, { settings: { playerObjectId: obj.id } });
  return sheet;
}

/** A known-as label from an appearance when none was given: its first phrase, up to five words ("a stranger" if empty). */
export function defaultKnownAs(appearance: string | undefined): string {
  const first = (appearance ?? '').split(/[,.;:—–(]/)[0].trim().split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return first ? (/^(a|an|the)\s/i.test(first) ? first : `the ${first.toLowerCase()}`) : 'a stranger';
}

/** Update a sheet. Becoming the player character also marks it on the story. */
export function updateSheet(deps: MindsDeps, storyId: string, objectId: string, patch: SheetPatch): CharacterSheet {
  const sheet = deps.sheets.upsert(storyId, objectId, patch);
  if (patch.isPlayer) deps.stories.updateStory(storyId, { settings: { playerObjectId: objectId } });
  return sheet;
}

// ---- Views (what a viewer may see; docs/11 §1) ----

export interface VariableView {
  key: string;
  label: string;
  type: VariableDef['type'];
  visibility: VariableDef['visibility'];
  value: VariableValue;
  display: string;
}

export interface CharacterView {
  objectId: string;
  handle: string;
  name: string;
  isPlayer: boolean;
  appearance: string;
  pronouns: string;
  /** What strangers call them. */
  knownAs: string;
  /** Whether the viewing player knows this name (`name` is then the real name; otherwise the known-as label). */
  nameKnown: boolean;
  /** Advanced view: the real name, and whether the player knows it. */
  realName?: string;
  playerKnowsName?: boolean;
  /** Present only when the viewer may see it. */
  description?: string;
  /** The narrator's hand-over: who they are, until (and besides) the description (docs/11 §2.3). */
  concept?: string;
  /** Their traits as nuanced phrases (docs/11 §2.7). */
  nature?: string;
  state?: string;
  /** How they are related to others, from their side (docs/11 §2.6): own sheet only, or advanced. */
  ties?: TieView[];
  /** Relation variables toward each person they have met (docs/11 §4.9), as far as the viewer may see them. */
  relations?: RelationView[];
  tierId?: string | null;
  seeded: boolean;
  variables: VariableView[];
}

export interface RelationView {
  other: string;
  handle: string;
  name: string;
  values: (VariableView & { holder: string })[];
}

export interface TieView {
  other: string;
  handle: string;
  name: string;
  label: string;
}

function tieViews(deps: MindsDeps, holder: string): TieView[] {
  return (deps.ties?.of(holder) ?? [])
    .map((t) => {
      const o = deps.memory.getObject(t.other);
      return o ? { other: t.other, handle: o.handle ?? '', name: o.name, label: t.label } : undefined;
    })
    .filter((x): x is TieView => !!x);
}

function variableViews(deps: MindsDeps, storyId: string, defs: VariableDef[], holder: HolderInfo, viewer: Viewer): VariableView[] {
  return defs
    .filter((d) => appliesTo(d, holder) && canSee(d, holder.id, viewer))
    .map((d) => {
      const value = valueOf(deps, storyId, d, holder.id);
      return { key: d.key, label: d.label, type: d.type, visibility: d.visibility, value, display: renderValue(d, value) };
    });
}

/** One character's relation values toward everyone it has met, as `viewer` may see them. */
function relationViews(deps: MindsDeps, storyId: string, defs: VariableDef[], holders: Map<string, HolderInfo>, oid: string, viewer: Viewer): RelationView[] {
  const rels = defs.filter((d) => d.scope === 'relation');
  if (!rels.length) return [];
  const out: RelationView[] = [];
  for (const other of metWith(deps, storyId, oid)) {
    const obj = deps.memory.getObject(other);
    if (!obj) continue;
    const values: RelationView['values'] = [];
    for (const d of rels) {
      const hid = relationHolder(d, oid, other);
      const holder = holders.get(hid);
      if (!holder || !appliesTo(d, holder) || !canSee(d, hid, viewer)) continue;
      const value = valueOf(deps, storyId, d, hid);
      values.push({ holder: hid, key: d.key, label: d.label, type: d.type, visibility: d.visibility, value, display: renderValue(d, value) });
    }
    if (values.length) out.push({ other, handle: obj.handle ?? '', name: viewer.kind === 'player' && !knowsName(deps, storyId, viewer.playerId, other) ? deps.sheets.get(other)?.knownAs || 'someone' : obj.name, values });
  }
  return out;
}

/** Sheets and variables as `viewer` may see them (the API's normal vs advanced mode). */
export function mindsView(deps: MindsDeps, storyId: string, viewer: Viewer): { characters: CharacterView[]; world: VariableView[] } {
  const defs = deps.variables.listDefs(storyId);
  const holders = holdersFor(deps, storyId);
  const characters: CharacterView[] = [];
  for (const sheet of deps.sheets.listForStory(storyId)) {
    const obj = deps.memory.getObject(sheet.objectId);
    if (!obj) continue;
    const holder = holders.get(sheet.objectId)!;
    const own = viewer.kind === 'advanced' || viewer.kind === 'narrator' || (viewer.kind === 'player' && viewer.playerId === sheet.objectId) || (viewer.kind === 'character' && viewer.id === sheet.objectId);
    // Names (docs/11 §2.5): the player's view shows a name only once the player knows it.
    const playerId = viewer.kind === 'player' ? viewer.playerId : deps.sheets.player(storyId)?.objectId ?? null;
    const known = sheet.isPlayer || knowsName(deps, storyId, playerId, sheet.objectId);
    const shownName = viewer.kind === 'player' && !known ? sheet.knownAs.trim() || 'someone' : obj.name;
    characters.push({
      objectId: sheet.objectId,
      handle: holder.handle ?? '',
      name: shownName,
      isPlayer: sheet.isPlayer,
      appearance: sheet.appearance,
      pronouns: sheet.pronouns,
      knownAs: sheet.knownAs,
      nameKnown: viewer.kind === 'player' ? known : true,
      ...(viewer.kind === 'advanced' ? { realName: obj.name, playerKnowsName: known } : {}),
      ...(own ? { description: sheet.description, concept: sheet.concept, nature: sheet.nature, state: sheet.state, ties: tieViews(deps, sheet.objectId) } : {}),
      ...(own ? { relations: relationViews(deps, storyId, defs, holders, sheet.objectId, viewer) } : {}),
      ...(viewer.kind === 'advanced' ? { tierId: sheet.tierId } : {}),
      seeded: sheet.seeded,
      variables: variableViews(deps, storyId, defs, holder, viewer),
    });
  }
  return { characters, world: variableViews(deps, storyId, defs, holders.get('world')!, viewer) };
}
