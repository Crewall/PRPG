import { mentionsNpc } from '../orchestrator/npcRound.ts';

// Who gets a model call this round (docs/10 §5.1). Zero LLM cost. A present
// character not called keeps its pending briefs, so the next time it is
// called it reads everything it witnessed, in order.

export interface GateCandidate {
  id: string;
  name: string;
  aliases: string[];
  handle: string;
}

export interface GateInput {
  present: GateCandidate[];
  /** What the player said and did this round. */
  playerText: string;
  /** The narrator's spotlight from the last round block. */
  spotlight: Set<string>;
  /** Characters with no reply in their thread yet (just created / just entered). */
  neverActed: Set<string>;
  /** Characters who replied in the previous round. */
  actedLastRound: Set<string>;
  /** Forced by the user (UI). */
  forced: Set<string>;
  cap: number;
}

export interface GateResult {
  called: string[];
  idle: string[];
  /** Why each called character was called (debug / turn meta). */
  reasons: Record<string, string>;
}

/** Does the text mention this character by name, alias, distinctive name word or #handle? */
export function mentionsCharacter(text: string, c: GateCandidate): boolean {
  if (!text) return false;
  if (new RegExp(`(^|[^\\p{L}\\p{N}_-])#${c.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(text)) return true;
  return mentionsNpc(text, { name: c.name, aliases: c.aliases });
}

export function chooseCallers(input: GateInput): GateResult {
  const ranked: { id: string; rank: number; reason: string }[] = [];
  for (const c of input.present) {
    let rank = -1;
    let reason = '';
    if (input.forced.has(c.id)) [rank, reason] = [0, 'forced'];
    else if (input.spotlight.has(c.id)) [rank, reason] = [1, 'spotlight'];
    else if (input.neverActed.has(c.id)) [rank, reason] = [2, 'first appearance'];
    else if (mentionsCharacter(input.playerText, c)) [rank, reason] = [3, 'mentioned by the player'];
    else if (input.actedLastRound.has(c.id)) [rank, reason] = [4, 'acted last round'];
    if (rank >= 0) ranked.push({ id: c.id, rank, reason });
  }
  // Stable: rank first, then scene order.
  const order = new Map(input.present.map((c, i) => [c.id, i]));
  ranked.sort((a, b) => a.rank - b.rank || order.get(a.id)! - order.get(b.id)!);
  const chosen = ranked.slice(0, Math.max(0, input.cap));
  const calledSet = new Set(chosen.map((r) => r.id));
  return {
    called: input.present.map((c) => c.id).filter((id) => calledSet.has(id)),
    idle: input.present.map((c) => c.id).filter((id) => !calledSet.has(id)),
    reasons: Object.fromEntries(chosen.map((r) => [r.id, r.reason])),
  };
}
