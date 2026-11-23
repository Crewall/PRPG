import type { MindsDeps } from './service.ts';
import { learnName, labelFor } from './names.ts';
import { clampWords, realValue } from './text.ts';

// Ties: how one character relates to another, from the holder's side (docs/11 §2.6).
// A tie also means both know each other's name (docs/11 §2.5).

/** A tie label as stored: a real value, at most 8 words, without a leading "my"/"your". */
export function cleanTieLabel(label: string | undefined | null): string {
  const v = realValue(label).replace(/^(my|your|his|her|their)\s+/i, '').replace(/[.\s]+$/, '');
  return v ? clampWords(v, 8).text : '';
}

/** Set what `other` is to `holder` (an empty label removes the tie). Returns whether anything changed. */
export function setTie(deps: MindsDeps, storyId: string, holder: string, other: string, label: string, turnId: string | null): boolean {
  if (!deps.ties || holder === other) return false;
  const clean = cleanTieLabel(label);
  if (!clean) {
    const had = deps.ties.of(holder).some((t) => t.other === other);
    deps.ties.remove(holder, other);
    return had;
  }
  deps.ties.set(storyId, holder, other, clean, turnId);
  learnName(deps, storyId, holder, other, turnId);
  learnName(deps, storyId, other, holder, turnId);
  return true;
}

/** The holder's ties as lines for its own prompt, under "Your people": "- #tall-stranger Rin: older sister". */
export function tieLines(deps: MindsDeps, storyId: string, holder: string): string[] {
  if (!deps.ties) return [];
  return deps.ties
    .of(holder)
    .filter((t) => deps.memory.getObject(t.other))
    .map((t) => `- ${labelFor(deps, storyId, holder, t.other)}: ${t.label}`);
}

/** The holder's ties as the narrator and the seeder read them: "#tall-stranger (older sibling)". */
export function tieSummary(deps: MindsDeps, holder: string): string[] {
  if (!deps.ties) return [];
  return deps.ties
    .of(holder)
    .map((t) => {
      const o = deps.memory.getObject(t.other);
      return o ? `#${o.handle} ${o.name} (${t.label})` : '';
    })
    .filter(Boolean);
}
