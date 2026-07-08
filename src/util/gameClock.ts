// The hidden in-game clock. Time is stored as whole minutes since the story
// began counting days: minute 0 is Day 1, 00:00. New stories start at Day 1,
// 08:00. The clock is engine state — the player never sees it directly; the
// storyteller is told the time and may reveal it only through the fiction.

export const CLOCK_START_MIN = 8 * 60; // Day 1, 08:00
export const DEFAULT_TURN_MINUTES = 5; // advance when the storyteller doesn't say
export const MAX_ADVANCE_MINUTES = 7 * 24 * 60; // one week per turn, tops

/** "Day 2, 14:30" — for prompts and the debug UI. */
export function formatGameClock(min: number): string {
  const m = Math.max(0, Math.floor(min));
  const day = Math.floor(m / 1440) + 1;
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return `Day ${day}, ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "d2 14:30" — compact tag for rendered memory facts. */
export function formatGameClockShort(min: number): string {
  const m = Math.max(0, Math.floor(min));
  const day = Math.floor(m / 1440) + 1;
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return `d${day} ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
