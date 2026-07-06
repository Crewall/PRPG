// Near-duplicate detection for memory facts (feature 6). Purely lexical —
// lowercase, punctuation-stripped token overlap — so it runs on every insert
// for free. Conservative on short facts (exact match only) to avoid eating
// genuinely distinct one-liners.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'of', 'to', 'in', 'on', 'at',
  'with', 'his', 'her', 'their', 'its', 'has', 'have', 'had', 'he', 'she', 'they', 'it', 'that', 'this',
]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Very light suffix stemming so 'wears'/'wearing' and 'rings'/'ring' collide. */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function tokens(s: string): Set<string> {
  return new Set(
    normalizeText(s)
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
      .map(stem),
  );
}

/**
 * True when two fact contents say (nearly) the same thing:
 * - identical after normalization, or
 * - substantial token overlap (Jaccard ≥ 0.7) or one nearly contained in the
 *   other (≥ 0.9 of the shorter's tokens), for facts with enough substance.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return na === nb;
  if (na === nb) return true;

  const ta = tokens(a);
  const tb = tokens(b);
  const minSize = Math.min(ta.size, tb.size);
  if (minSize < 3) return false; // too short to fuzzy-match — require exact

  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union ? inter / union : 0;
  const containment = inter / minSize;
  return jaccard >= 0.7 || containment >= 0.9;
}

/** Find an existing fact whose content near-duplicates `content`, if any. */
export function findNearDuplicate<T extends { content: string }>(existing: T[], content: string): T | undefined {
  return existing.find((f) => isNearDuplicate(f.content, content));
}
