// Who can perceive (docs/10 §5.1f): a present character who is asleep or unconscious hears nothing, gets no brief
// and is never called; waking and falling asleep are told to them.

export const AWARENESS = ['awake', 'asleep', 'unconscious'] as const;
export type Awareness = (typeof AWARENESS)[number];

/** Read an AI's or a user's word for awareness leniently; undefined when it means none of them. */
export function normalizeAwareness(raw: unknown): Awareness | undefined {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (/^(awake|woken|wakes?|woke|conscious|up|alert|comes? to|came to)\b/.test(s)) return 'awake';
  if (/^(asleep|sleep|sleeping|dozing|dozes|napping|dreaming)\b/.test(s)) return 'asleep';
  if (/^(unconscious|knocked out|ko|out cold|fainted|faints?|passed out|passes out|insensible|comatose|stunned senseless)\b/.test(s)) return 'unconscious';
  return undefined;
}

/** What a character's own thread is told when it changes. */
export function awarenessNote(from: Awareness, to: Awareness): string {
  if (to === 'asleep') return from === 'unconscious' ? 'You drift from unconsciousness into sleep.' : 'You fall asleep.';
  if (to === 'unconscious') return 'You lose consciousness.';
  return from === 'unconscious' ? 'You come to.' : 'You wake up.';
}

/** How others present see it, and how the narrator's sheet shows it. */
export const AWARENESS_SEEN: Record<Exclude<Awareness, 'awake'>, string> = { asleep: 'asleep', unconscious: 'unconscious' };
