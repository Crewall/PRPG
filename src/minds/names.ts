import type { MindsDeps } from './service.ts';
import { slugify } from './text.ts';

// Names: who knows whom (docs/11 §2.5). Nobody knows a stranger's name: until a
// name is heard, a person is known by their known-as label and their #handle
// (which, with names on, is made from that label, not from the name). Every
// character knows its own name; the narrator knows them all. With the story's
// `minds.nameKnowledge` off, names are common knowledge (older stories).

export const NARRATOR = 'narrator';

export function namesOn(deps: MindsDeps, storyId: string): boolean {
  return !!deps.names && !!deps.stories.getStory(storyId)?.settings.minds.nameKnowledge;
}

/** Does `viewer` (a character's or the player character's object id, or 'narrator') know `subject`'s name? */
export function knowsName(deps: MindsDeps, storyId: string, viewer: string | null | undefined, subject: string): boolean {
  if (!namesOn(deps, storyId)) return true;
  if (viewer === NARRATOR || viewer === subject) return true;
  if (!viewer) return false;
  return deps.names!.knows(viewer, subject);
}

/** The label `viewer` uses for `subject`: the name if known, else the known-as label (or "someone"). */
export function nameFor(deps: MindsDeps, storyId: string, viewer: string | null | undefined, subject: string): { name: string; known: boolean } {
  const obj = deps.memory.getObject(subject);
  const known = knowsName(deps, storyId, viewer, subject);
  if (known) return { name: obj?.name ?? '?', known };
  return { name: deps.sheets.get(subject)?.knownAs.trim() || 'someone', known };
}

/** "#handle Name" when the viewer knows the name, "#handle" when not (lines heard, the round's "Right now"). */
export function labelFor(deps: MindsDeps, storyId: string, viewer: string | null | undefined, subject: string): string {
  const obj = deps.memory.getObject(subject);
  const handle = `#${obj?.handle ?? deps.memory.ensureHandle(subject) ?? '?'}`;
  return knowsName(deps, storyId, viewer, subject) ? `${handle} ${obj?.name ?? '?'}` : handle;
}

/** The handle a new character gets: from its known-as label when names are on (it must not give the name away). */
export function handleBaseFor(deps: MindsDeps, storyId: string, name: string, knownAs: string | undefined): string {
  if (!namesOn(deps, storyId)) return name;
  const label = (knownAs ?? '').replace(/^(the|a|an)\s+/i, '').trim();
  return slugify(label) !== 'x' ? label : 'stranger';
}

// ---- Finding names in text ----

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A whole-word, case-sensitive match of `word` (Unicode letters count as word characters). */
const wordRe = (word: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, 'gu');

interface NamedPerson {
  id: string;
  handle: string;
  /** Full name first, then its first word (≥ 3 letters) and aliases. */
  forms: string[];
}

function roster(deps: MindsDeps, storyId: string): NamedPerson[] {
  const out: NamedPerson[] = [];
  for (const sheet of deps.sheets.listForStory(storyId)) {
    const obj = deps.memory.getObject(sheet.objectId);
    if (!obj) continue;
    const forms = new Set<string>();
    const full = obj.name.trim();
    if (full) forms.add(full);
    const first = full.split(/\s+/)[0];
    if (first && first !== full && (first.match(/\p{L}/gu) ?? []).length >= 3) forms.add(first);
    for (const a of obj.aliases ?? []) if ((a.match(/\p{L}/gu) ?? []).length >= 3) forms.add(a.trim());
    out.push({ id: obj.id, handle: obj.handle ?? deps.memory.ensureHandle(obj.id) ?? 'x', forms: [...forms].sort((a, b) => b.length - a.length) });
  }
  return out;
}

/** The people whose names appear in `text`. */
export function namesIn(deps: MindsDeps, storyId: string, text: string): string[] {
  if (!text.trim()) return [];
  return roster(deps, storyId)
    .filter((p) => p.forms.some((f) => wordRe(f).test(text)))
    .map((p) => p.id);
}

/**
 * Heard speech teaches names: every hearer learns the name of each person named in `text`.
 * Returns how many names were learned.
 */
export function learnFromSpeech(deps: MindsDeps, storyId: string, hearers: (string | null | undefined)[], text: string, turnId: string | null): number {
  if (!namesOn(deps, storyId) || !text.trim()) return 0;
  let n = 0;
  for (const subject of namesIn(deps, storyId, text)) {
    for (const hearer of hearers) if (hearer && hearer !== subject && deps.names!.learn(storyId, hearer, subject, turnId)) n++;
  }
  return n;
}

/** Record that `viewer` learned `subject`'s name (names on only). */
export function learnName(deps: MindsDeps, storyId: string, viewer: string, subject: string, turnId: string | null): boolean {
  if (!namesOn(deps, storyId) || viewer === subject) return false;
  return deps.names!.learn(storyId, viewer, subject, turnId);
}

/**
 * A brief, as its reader may read it: every name the reader doesn't know becomes that person's #handle
 * (the narrator is told who knows whom; this is the safety net). Speech is never masked: hearing a name is how
 * it is learned.
 */
export function maskUnknownNames(deps: MindsDeps, storyId: string, reader: string, text: string): string {
  if (!namesOn(deps, storyId) || !text) return text;
  let out = text;
  for (const p of roster(deps, storyId)) {
    if (p.id === reader || knowsName(deps, storyId, reader, p.id)) continue;
    for (const form of p.forms) out = out.replace(wordRe(form), `#${p.handle}`);
  }
  // "#handle #handle" (name already next to its handle) reads as one.
  return out.replace(/(#[\w-]+)\s+\1(?![\w-])/g, '$1');
}

/** Whose names `viewer` knows, among `subjects` (the narrator's round message). */
export function knownNames(deps: MindsDeps, storyId: string, viewer: string, subjects: string[]): string[] {
  return subjects.filter((s) => s !== viewer && knowsName(deps, storyId, viewer, s));
}
