import { clampWords } from './text.ts';
import type { Beat } from './contracts.ts';

// How much each called character says this round (docs/10 §5.1e): four focus tiers, worked out from what the
// round already knows (who the player addressed, who was made to act or given the floor, the narrator's spotlight,
// the conversation partner), scaled by the story's character verbosity.

export type Focus = 'sole' | 'lead' | 'part' | 'background';

/** Words of speech and of action per tier, at verbosity 3. */
export const FOCUS_LIMITS: Record<Focus, { say: number; intent: number }> = {
  sole: { say: 240, intent: 50 },
  lead: { say: 120, intent: 25 },
  part: { say: 40, intent: 15 },
  background: { say: 15, intent: 10 },
};

/** Character verbosity 1–5 → a scale for every tier. */
export const VERBOSITY_SCALE = [0.5, 0.75, 1, 1.5, 2];

export function limitsFor(focus: Focus, verbosity = 3): { say: number; intent: number } {
  const scale = VERBOSITY_SCALE[Math.min(5, Math.max(1, Math.round(verbosity))) - 1];
  const base = FOCUS_LIMITS[focus];
  return { say: Math.max(5, Math.round(base.say * scale)), intent: Math.max(5, Math.round(base.intent * scale)) };
}

export interface FocusInput {
  /** Characters called this round. */
  called: string[];
  /** Why each was called (the gate's reasons: forced, spotlight, first appearance, mentioned by the player, …). */
  reasons: Record<string, string>;
  /** Whom the player's words are meant for (docs/10 §5.1b). */
  direction: { to: string[]; all: boolean };
  /** Given the floor by the player (⚡⚡). */
  floor: Set<string>;
  /** The conversation partner (dialogue mode). */
  partner?: string;
}

/** Made to act by the player, or spotlighted by the narrator. ("spoken to" alone may mean everyone: see direction.) */
const LEAD_REASONS = new Set(['forced', 'spotlight']);

/** A called character's focus this round. */
export function focusFor(oid: string, input: FocusInput): Focus {
  if (input.floor.has(oid) || input.partner === oid) return 'sole';
  const reason = input.reasons[oid] ?? '';
  const addressed = input.direction.to.includes(oid);
  if (addressed && input.direction.to.length === 1 && !input.direction.all) {
    // The only one the player speaks to has the floor, unless someone else was made to act or spotlighted too.
    const rivals = input.called.filter((x) => x !== oid && (LEAD_REASONS.has(input.reasons[x] ?? '') || input.floor.has(x)));
    return rivals.length ? 'lead' : 'sole';
  }
  if (addressed || LEAD_REASONS.has(reason)) return 'lead';
  if (input.direction.all || reason === 'mentioned by the player' || reason === 'first appearance') return 'part';
  return 'background';
}

/** The round message's line telling the character its focus and how much to say. */
export function focusLine(focus: Focus, limits: { say: number; intent: number }): string {
  const howMuch = `up to about ${limits.say} words of speech and ${limits.intent} of action`;
  switch (focus) {
    case 'sole':
      return `This moment is yours: you have the floor. Say and do as much as you naturally would, ${howMuch}; if words and actions interleave, give them in order as "beats".`;
    case 'lead':
      return `You are at the centre of this moment: answer as fully as you naturally would, ${howMuch}.`;
    case 'part':
      return `You are part of this moment, not its centre: a sentence or two at most (${howMuch}).`;
    case 'background':
      return `You are in the background this moment: a few words, a look, or nothing (${howMuch}).`;
  }
}

/** Cut at the last sentence end within `max` words, else at `max` words. */
export function clampSentences(text: string, max: number): string {
  const c = clampWords(text, max);
  if (!c.clamped) return c.text;
  const end = Math.max(c.text.lastIndexOf('. '), c.text.lastIndexOf('! '), c.text.lastIndexOf('? '), c.text.lastIndexOf('." '), c.text.lastIndexOf('.'), c.text.lastIndexOf('!'), c.text.lastIndexOf('?'));
  return end >= c.text.length / 3 ? c.text.slice(0, end + 1).trim() : `${c.text}…`;
}

/** Hold a reply's speech, action and beats to its tier's limits. */
export function holdToLimits<R extends { say: string; intent: string; beats: Beat[] }>(reply: R, limits: { say: number; intent: number }): R {
  let sayLeft = limits.say;
  let doLeft = limits.intent;
  const beats: Beat[] = [];
  for (const b of reply.beats) {
    const left = b.kind === 'say' ? sayLeft : doLeft;
    if (left <= 0) continue;
    const text = clampSentences(b.text, left);
    const used = text.split(/\s+/).filter(Boolean).length;
    if (b.kind === 'say') sayLeft -= used;
    else doLeft -= used;
    if (text) beats.push({ kind: b.kind, text });
  }
  return { ...reply, say: clampSentences(reply.say, limits.say), intent: clampSentences(reply.intent, limits.intent), beats };
}
