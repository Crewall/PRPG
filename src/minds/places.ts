import type { MemoryObject, ObjectType } from '../memory/model.ts';
import type { MindsDeps } from './service.ts';
import { clampWords, isPlaceholder, realValue, slugify } from './text.ts';

// Places and things (docs/10 §5.1d): the narrator is shown what exists, with
// #handles, and its `objects` entries match what exists instead of naming the
// same thing afresh each time.

const GONE_MARK = /\s*\((?:removed|gone|destroyed|lost|taken(?: away)?|broken|discarded|used up)\)\s*$/i;
const TRAILING_PAREN = /\s*\(([^()]*)\)\s*$/;
const OBJECT_TYPES: ObjectType[] = ['item', 'location', 'faction', 'event', 'lore'];

/** A loose key for comparing names: no case, accents, punctuation, articles or possessive s. */
export function looseKey(name: string): string {
  return slugify(name.replace(/^(the|a|an)\s+/i, ''), 64).replace(/-s(?=-|$)/g, '');
}

export interface ObjectMatch {
  /** The existing object it names, if any. */
  obj?: MemoryObject;
  /** The name to create it under (without a gone marker or a trailing alias). */
  name: string;
  /** A trailing "(…)" that is an alias of an existing object ("(Bun)"). */
  alias?: string;
  /** Marked as gone ("(removed)"). */
  gone: boolean;
}

/** What `rawName` refers to: a #handle, an exact or loose name match, or a name with a trailing alias. */
export function matchObject(deps: Pick<MindsDeps, 'memory'>, storyId: string, rawName: string): ObjectMatch {
  let name = rawName.trim();
  let gone = false;
  if (GONE_MARK.test(name)) {
    gone = true;
    name = name.replace(GONE_MARK, '').trim();
  }
  if (name.startsWith('#')) {
    const obj = deps.memory.findByHandle(storyId, name);
    return { obj, gone, name: name.slice(1).replace(/[-_]+/g, ' ') };
  }
  const find = (n: string) => {
    const exact = deps.memory.findByName(storyId, n) ?? deps.memory.findByHandle(storyId, slugify(n));
    if (exact) return exact;
    const key = looseKey(n);
    return key ? deps.memory.listObjects(storyId).find((o) => looseKey(o.name) === key || o.aliases.some((a) => looseKey(a) === key)) : undefined;
  };
  const obj = find(name);
  if (obj) return { obj, gone, name };
  const m = name.match(TRAILING_PAREN);
  if (m) {
    const base = name.replace(TRAILING_PAREN, '').trim();
    const alias = m[1].trim();
    const hit = base ? find(base) : undefined;
    return { obj: hit, gone, name: base || name, ...(alias ? { alias } : {}) };
  }
  return { gone, name };
}

export interface ObjectEntry {
  name: string;
  type?: string;
  line?: string;
  gone?: boolean;
}

/**
 * Apply the block's `objects`: update the line of what exists (by #handle or name), mark things gone, create what
 * is new. Characters are never created or changed here (cast.enter does that).
 */
export function applyObjects(deps: Pick<MindsDeps, 'memory'>, storyId: string, entries: ObjectEntry[]): { created: string[]; gone: string[] } {
  const created: string[] = [];
  const gone: string[] = [];
  for (const o of entries) {
    if (isPlaceholder(o.name)) continue;
    const line = realValue(o.line);
    const m = matchObject(deps, storyId, o.name);
    const isGone = !!o.gone || m.gone;
    if (m.obj) {
      if (m.obj.type === 'character') continue;
      const patch: Parameters<typeof deps.memory.updateObject>[1] = {};
      if (line && m.obj.summary !== line) patch.summary = line;
      if (m.alias && !m.obj.aliases.some((a) => a.toLowerCase() === m.alias!.toLowerCase()) && m.alias.toLowerCase() !== m.obj.name.toLowerCase()) {
        patch.aliases = [...m.obj.aliases, clampWords(m.alias, 6).text];
      }
      if (isGone && m.obj.status !== 'destroyed') {
        patch.status = 'destroyed';
        gone.push(m.obj.id);
      } else if (!isGone && m.obj.status === 'destroyed' && line) patch.status = 'active'; // back again
      if (Object.keys(patch).length) deps.memory.updateObject(m.obj.id, patch);
      continue;
    }
    if (isGone || !m.name.trim()) continue; // nothing to create for a thing that is already gone
    const type = OBJECT_TYPES.includes(o.type as ObjectType) ? (o.type as ObjectType) : 'item';
    const obj = deps.memory.createObject({ storyId, type, name: m.name.trim(), aliases: m.alias ? [clampWords(m.alias, 6).text] : [], summary: line, salience: 0.5, status: 'active' });
    created.push(obj.id);
  }
  return { created, gone };
}

/**
 * The narrator's "Places and things" block: the location, the things in view, then up to `others` more known
 * places and things (most recently touched first). Gone things are left out.
 */
export function placesAndThings(
  deps: Pick<MindsDeps, 'memory'>,
  storyId: string,
  scene: { locationObjectId?: string | null; itemHandles?: string[] } | undefined,
  others = 12,
): string {
  const line = (o: MemoryObject) => `#${o.handle ?? deps.memory.ensureHandle(o.id)} (${o.name})${o.summary.trim() ? ` — ${clampWords(o.summary.replace(/\s+/g, ' ').trim(), 20).text}` : ''}`;
  const shown = new Set<string>();
  const lines: string[] = [];
  const loc = scene?.locationObjectId ? deps.memory.getObject(scene.locationObjectId) : undefined;
  if (loc) {
    lines.push(`Here: ${line(loc)}`);
    shown.add(loc.id);
  }
  const inView = (scene?.itemHandles ?? [])
    .map((handle) => deps.memory.findByHandle(storyId, handle))
    .filter((o): o is MemoryObject => !!o && o.status !== 'destroyed' && o.type !== 'character');
  if (inView.length) lines.push(`In view: ${inView.map(line).join('; ')}`);
  for (const o of inView) shown.add(o.id);
  const rest = deps.memory
    .listObjects(storyId)
    .filter((o) => o.type !== 'character' && o.status !== 'destroyed' && !shown.has(o.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, others);
  if (rest.length) lines.push(`Also known:\n${rest.map((o) => `- ${line(o)}`).join('\n')}`);
  return lines.length ? `Places and things (reuse these #handles):\n${lines.join('\n')}` : '';
}
