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
