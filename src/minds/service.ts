import type { StoryStore } from '../db/stores/storyStore.ts';
import type { MemoryStore } from '../db/stores/memoryStore.ts';
import type { SheetStore, ThoughtStore, VariableStore, CharacterSheet, SheetPatch } from '../db/stores/mindsStore.ts';
import { STATE_KEY, appliesTo, canSee, defaultValue, renderValue, runPipeline, splitFinalId } from './variables.ts';
import type { ChangeOutcome, HolderInfo, Proposal, VariableDef, VariableValue, Viewer } from './variables.ts';
import { MAX_FORGET_PER_REPLY, MAX_REMEMBER_PER_REPLY, parseThoughtHandle, prepareRemember, thoughtHandle } from './thoughts.ts';
import type { RememberOp, Thought } from './thoughts.ts';

// The Minds data layer's operations (docs/11): sheets, variables and thoughts
// with their rules applied. Agents and the round (M4) call these; so does the API.

export interface MindsDeps {
  stories: StoryStore;
  memory: MemoryStore;
  sheets: SheetStore;
  variables: VariableStore;
  thoughts: ThoughtStore;
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
  /** Plain-language notes for the owner's next round message ("Not kept: …"). */
  notes: string[];
}

/**
 * Apply an owner's remember/forget operations (docs/11 §5.3). For the owner's
 * own replies (`source: 'self'`) the per-reply caps apply; the active-thought
 * cap always does.
 */
export function applyThoughtOps(
  deps: MindsDeps,
  storyId: string,
  owner: string,
  ops: { remember?: RememberOp[]; forget?: unknown[] },
  source: Thought['source'],
  turnId: string | null = null,
): ThoughtOpsResult {
  const story = deps.stories.getStory(storyId);
  const maxActive = story?.settings.minds.maxActiveThoughts ?? 80;
  const result: ThoughtOpsResult = { added: [], revoked: [], notes: [] };
  const remember = ops.remember ?? [];
  const forget = ops.forget ?? [];
  const selfCaps = source === 'self';

  const forgetList = selfCaps && forget.length > MAX_FORGET_PER_REPLY ? forget.slice(0, MAX_FORGET_PER_REPLY) : forget;
  if (forgetList.length < forget.length) result.notes.push(`Only ${MAX_FORGET_PER_REPLY} thoughts can be forgotten at once; the rest were kept.`);
  for (const h of forgetList) {
    const seq = parseThoughtHandle(h);
    const t = seq === undefined ? undefined : deps.thoughts.bySeq(storyId, owner, seq);
    if (!t) {
      result.notes.push(`Not forgotten: you have no thought ${String(h)}.`);
      continue;
    }
    if (t.status === 'revoked') continue;
    deps.thoughts.revoke(t.id, turnId);
    result.revoked.push({ ...t, status: 'revoked' });
  }

  const rememberList = selfCaps && remember.length > MAX_REMEMBER_PER_REPLY ? remember.slice(0, MAX_REMEMBER_PER_REPLY) : remember;
  if (rememberList.length < remember.length) result.notes.push(`Only ${MAX_REMEMBER_PER_REPLY} new thoughts are kept per reply; the rest were dropped.`);
  const handles = deps.memory.listHandles(storyId);
  const existing = new Set(deps.thoughts.list(storyId, owner).map((t) => t.text.toLowerCase()));
  for (const op of rememberList) {
    const prepared = prepareRemember(op, handles);
    if (!prepared) continue;
    if (existing.has(prepared.text.toLowerCase())) continue; // already remembered, verbatim
    if (deps.thoughts.countActive(storyId, owner) >= maxActive) {
      result.notes.push(`Not kept: you already hold ${maxActive} thoughts. Forget or merge some first.`);
      break;
    }
    const t = deps.thoughts.insert(storyId, owner, { text: prepared.text, tags: prepared.tags, pinned: prepared.pinned, source }, turnId);
    existing.add(prepared.text.toLowerCase());
    result.added.push(t);
    for (const n of prepared.notes) result.notes.push(`${thoughtHandle(t)}: ${n}.`);
  }
  return result;
}

/** Create a character: roster object (with handle) + sheet. `isPlayer` also marks it on the story. */
export function createCharacter(
  deps: MindsDeps,
  storyId: string,
  input: { name: string; isPlayer?: boolean; description?: string; appearance?: string; state?: string },
): CharacterSheet {
  const obj = deps.memory.createObject({ storyId, type: 'character', name: input.name.trim(), aliases: [], summary: '', salience: 0.6, status: 'active' });
  const sheet = deps.sheets.upsert(storyId, obj.id, {
    isPlayer: !!input.isPlayer,
    description: input.description ?? '',
    appearance: input.appearance ?? '',
    state: input.state ?? '',
  });
  if (input.isPlayer) deps.stories.updateStory(storyId, { settings: { playerObjectId: obj.id } });
  return sheet;
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
  /** Present only when the viewer may see it. */
  description?: string;
  state?: string;
  tierId?: string | null;
  seeded: boolean;
  variables: VariableView[];
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
    characters.push({
      objectId: sheet.objectId,
      handle: holder.handle ?? '',
      name: obj.name,
      isPlayer: sheet.isPlayer,
      appearance: sheet.appearance,
      ...(own ? { description: sheet.description, state: sheet.state } : {}),
      ...(viewer.kind === 'advanced' ? { tierId: sheet.tierId } : {}),
      seeded: sheet.seeded,
      variables: variableViews(deps, storyId, defs, holder, viewer),
    });
  }
  return { characters, world: variableViews(deps, storyId, defs, holders.get('world')!, viewer) };
}
