import type { StoryStore } from '../db/stores/storyStore.ts';
import { handleBaseFor, knowsName, namesOn } from './names.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { SheetStore, ThoughtStore, VariableStore, CharacterSheet, SheetPatch, NameStore, TieStore } from '../db/stores/mindsStore.ts';
import { STATE_KEY, appliesTo, canSee, defaultValue, renderValue, runPipeline, splitFinalId } from './variables.ts';
import type { ChangeOutcome, HolderInfo, Proposal, VariableDef, VariableValue, Viewer } from './variables.ts';
import {
  MAX_AGENDA,
  MAX_FORGET_PER_REPLY,
  MAX_REMEMBER_PER_REPLY,
  MAX_REVISE_PER_REPLY,
  clampImportance,
  currentImportance,
  fades,
  normalizeKind,
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
}

/** Every variable holder in the story: each character with a sheet, plus 'world'. */
export function holdersFor(deps: MindsDeps, storyId: string): Map<string, HolderInfo> {
  const out = new Map<string, HolderInfo>([['world', { id: 'world', isPlayer: false }]]);
  for (const s of deps.sheets.listForStory(storyId)) {
    out.set(s.objectId, { id: s.objectId, isPlayer: s.isPlayer, handle: deps.memory.ensureHandle(s.objectId) });
  }
  return out;
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
}

/** How thoughts read right now: current importance (fading applied) and the rendered line (docs/11 §5.7, §5.9). */
export function thoughtLens(deps: MindsDeps, storyId: string) {
  const story = deps.stories.getStory(storyId);
  const fadeHours = story?.settings.minds.fadeHours ?? 8;
  const clock = story?.clockMin ?? null;
  const current = (t: Thought) => currentImportance(t, clock, fadeHours);
  const aboutHandle = (t: Thought) => (t.about ? (deps.memory.getObject(t.about)?.handle ?? null) : null);
  const render = (t: Thought) => renderThought(t, { aboutHandle: aboutHandle(t), current: current(t) });
  return { current, aboutHandle, render, clock, fadeHours };
}

/** Thoughts whose current importance reached 0 fade (docs/11 §5.7). Run once per round, after the clock moved. */
export function fadeThoughts(deps: MindsDeps, storyId: string, turnId: string | null): Thought[] {
  const { current } = thoughtLens(deps, storyId);
  const faded: Thought[] = [];
  for (const t of deps.thoughts.listActiveForStory(storyId)) {
    if (!fades(t) || current(t) > 0) continue;
    deps.thoughts.setStatus(t.id, 'faded', turnId);
    faded.push({ ...t, status: 'faded' });
  }
  return faded;
}

/**
 * Apply an owner's remember / revise / forget operations (docs/11 §5.3, §5.6–5.8). For the owner's own replies
 * (`source: 'self'`) the per-reply caps apply; the active-thought and agenda caps always do. Restating a thought
 * word for word renews it instead of adding a copy.
 */
export function applyThoughtOps(
  deps: MindsDeps,
  storyId: string,
  owner: string,
  ops: { remember?: RememberOp[]; forget?: unknown[]; revise?: ReviseOp[] },
  source: Thought['source'],
  turnId: string | null = null,
): ThoughtOpsResult {
  const story = deps.stories.getStory(storyId);
  const clock = story?.clockMin ?? null;
  const maxActive = story?.settings.minds.maxActiveThoughts ?? 80;
  const result: ThoughtOpsResult = { added: [], revoked: [], revised: [], notes: [] };
  const remember = ops.remember ?? [];
  const forget = ops.forget ?? [];
  const revise = ops.revise ?? [];
  const selfCaps = source === 'self';
  const handles = deps.memory.listHandles(storyId);
  const objectOf = (handle: string | undefined) => (handle ? (deps.memory.findByHandle(storyId, handle)?.id ?? null) : null);
  const agendaCount = () => deps.thoughts.list(storyId, owner).filter((t) => t.kind === 'agenda').length;

  const forgetList = selfCaps && forget.length > MAX_FORGET_PER_REPLY ? forget.slice(0, MAX_FORGET_PER_REPLY) : forget;
  if (forgetList.length < forget.length) result.notes.push(`Only ${MAX_FORGET_PER_REPLY} thoughts can be forgotten at once; the rest were kept.`);
  for (const h of forgetList) {
    const seq = parseThoughtHandle(h);
    const t = seq === undefined ? undefined : deps.thoughts.bySeq(storyId, owner, seq);
    if (!t) {
      result.notes.push(`Not forgotten: you have no thought ${String(h)}.`);
      continue;
    }
    if (t.status !== 'active') continue;
    deps.thoughts.revoke(t.id, turnId);
    result.revoked.push({ ...t, status: 'revoked' });
  }

  // Revise: the old thought is kept as history; a new one takes its place (docs/11 §5.8).
  const reviseList = selfCaps && revise.length > MAX_REVISE_PER_REPLY ? revise.slice(0, MAX_REVISE_PER_REPLY) : revise;
  if (reviseList.length < revise.length) result.notes.push(`Only ${MAX_REVISE_PER_REPLY} thoughts can be revised at once; the rest were kept as they were.`);
  for (const op of reviseList) {
    const seq = parseThoughtHandle(op.id);
    const old = seq === undefined ? undefined : deps.thoughts.bySeq(storyId, owner, seq);
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
      },
      handles,
    );
    if (!prepared) continue;
    deps.thoughts.setStatus(old.id, 'revised', turnId);
    const t = deps.thoughts.insert(
      storyId,
      owner,
      { text: prepared.text, tags: prepared.tags, pinned: prepared.pinned, source, clockMin: clock, kind: prepared.kind, importance: prepared.importance, about: objectOf(prepared.aboutHandle) ?? old.about, revises: old.id },
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
    const t = deps.thoughts.insert(
      storyId,
      owner,
      { text: prepared.text, tags: prepared.tags, pinned: prepared.pinned, source, clockMin: clock, kind: prepared.kind, importance: prepared.importance, about: objectOf(prepared.aboutHandle) },
      turnId,
    );
    existing.set(prepared.text.toLowerCase(), t);
    result.added.push(t);
    for (const n of prepared.notes) result.notes.push(`${thoughtHandle(t)}: ${n}.`);
  }
  return result;
}

/** A user's edit of one thought (advanced mode): text, kind, importance, about, tags. */
export function editThought(
  deps: MindsDeps,
  storyId: string,
  t: Thought,
  patch: { text?: string; kind?: string; importance?: unknown; about?: string | null; tags?: string[] },
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
  state?: string;
  /** How they are related to others, from their side (docs/11 §2.6): own sheet only, or advanced. */
  ties?: TieView[];
  tierId?: string | null;
  seeded: boolean;
  variables: VariableView[];
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
      ...(own ? { description: sheet.description, concept: sheet.concept, state: sheet.state, ties: tieViews(deps, sheet.objectId) } : {}),
      ...(viewer.kind === 'advanced' ? { tierId: sheet.tierId } : {}),
      seeded: sheet.seeded,
      variables: variableViews(deps, storyId, defs, holder, viewer),
    });
  }
  return { characters, world: variableViews(deps, storyId, defs, holders.get('world')!, viewer) };
}
