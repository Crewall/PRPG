// Small text rules shared by the Minds engine (docs/11): handles, tags, word limits.

/** Lowercase ASCII-ish slug: accents folded, anything else becomes '-'. "Éva Kovács" → "eva-kovacs". */
export function slugify(name: string, maxLength = 32): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug || 'x';
}

/** Words in a string (whitespace-separated). */
export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Keep at most `max` words; whitespace collapsed. Returns the text and whether it was cut. */
export function clampWords(text: string, max: number): { text: string; clamped: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return { text: words.join(' '), clamped: false };
  return { text: words.slice(0, max).join(' '), clamped: true };
}

/** Keep at most `max` words, leaving the text's own spacing and line breaks as they are. */
export function clampWordsKeepLines(text: string, max: number): string {
  const t = text.trim();
  let n = 0;
  for (const m of t.matchAll(/\S+/g)) if (++n === max) return t.slice(0, m.index! + m[0].length);
  return t;
}

/**
 * Normalize a thought tag (docs/11 §5.3): lowercase, trimmed, spaces → hyphens,
 * letters/digits/-/_ only (accented letters kept), ≤ 32 characters. A leading
 * '#' marks a roster handle. Returns '' for a tag with nothing left.
 */
export function normalizeTag(raw: string): string {
  const s = raw.trim().toLowerCase();
  const handle = s.startsWith('#');
  const body = (handle ? s.slice(1) : s)
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, handle ? 31 : 32);
  if (!body) return '';
  return handle ? `#${body}` : body;
}

// ---- Telling real values from copied placeholders (models sometimes copy a template's "<name>" or "…") ----

const PLACEHOLDER_NAMES = new Set([
  'name', 'a name', 'a real name', 'their name', 'his name', 'her name', 'new character', 'character', 'unknown', 'none', 'n/a', 'na',
  'player', 'the player', 'player character', 'the player character', 'you', 'pc',
]);

/** A template placeholder copied as a value: "<their name>", "…", "...", "{name}". */
export function isPlaceholder(value: string | undefined | null): boolean {
  const v = (value ?? '').trim();
  return !v || /[<>{}]/.test(v) || /^(…|\.{2,}|-+|\?+)$/.test(v);
}

/** A usable name for a person: two letters at least, not a placeholder or a stand-in like "player". */
export function isRealName(name: string | undefined | null): boolean {
  const n = (name ?? '').trim();
  if (isPlaceholder(n) || n.includes('…')) return false;
  if ((n.match(/\p{L}/gu) ?? []).length < 2) return false;
  return !PLACEHOLDER_NAMES.has(n.toLowerCase());
}

/** A field value, or '' when it is a copied placeholder. */
export const realValue = (value: string | undefined | null): string => (isPlaceholder(value) ? '' : (value ?? '').trim());
