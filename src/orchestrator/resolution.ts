// Outcome bands for adjudicated actions. The adjudicator supplies a success
// chance; the engine rolls a hidden d100. The margin (chance − roll) picks the
// band, so better odds also mean better *quality* of success on average.

export type ResolutionOutcome = 'critical-success' | 'success' | 'partial' | 'failure' | 'critical-failure';

export interface ActionResolution {
  actor: string;
  action: string;
  chance: number; // clamped success chance (2..98)
  roll: number; // d100 (1..100)
  outcome: ResolutionOutcome;
  assessment: string;
  complication: string;
  keyFactors: string[];
}

export function clampChance(n: number): number {
  return Math.max(2, Math.min(98, Math.round(n)));
}

export function outcomeFromRoll(chance: number, roll: number): ResolutionOutcome {
  const margin = chance - roll;
  if (margin >= 40) return 'critical-success';
  if (margin >= 0) return 'success';
  if (margin >= -15) return 'partial';
  if (margin >= -45) return 'failure';
  return 'critical-failure';
}

// What the storyteller is told to do with each band — qualitative only; the
// numbers stay in the logs (and the debug UI), never in the narration.
export const OUTCOME_GUIDANCE: Record<ResolutionOutcome, string> = {
  'critical-success': 'succeeds impressively — grant the goal plus a small extra edge',
  success: 'succeeds — grant the goal cleanly',
  partial: 'barely succeeds — grant the goal BUT impose the complication',
  failure: 'fails — the goal is not achieved; fail forward: the situation changes rather than dead-ends',
  'critical-failure': 'fails badly — the complication hits hard and the situation worsens',
};
