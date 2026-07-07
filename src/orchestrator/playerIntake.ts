import type { HandlerDeps } from './handlers.ts';
import { PlayerIntake } from '../agents/playerIntake.ts';
import { applyMemoryDelta } from './memoryHandlers.ts';
import { logger } from '../util/logger.ts';

export type InterviewResult =
  | { done: false; question: string; round: number; maxRounds: number }
  | { done: true; objectId: string; name: string };

export const MAX_INTERVIEW_ROUNDS = 3;

/**
 * One step of the player-dossier interview (its own agent thread, separate
 * from play). Called with the exchanges so far; returns either the next
 * question or — when the interviewer finishes (forced at round 3) — applies
 * the resulting MemoryDelta, marks the created character as THE player
 * character on the story, and returns it.
 */
export async function runPlayerInterview(
  deps: HandlerDeps,
  storyId: string,
  exchanges: { question: string; answer: string }[],
): Promise<InterviewResult> {
  const story = deps.stories.getStory(storyId);
  if (!story) throw new Error(`story '${storyId}' not found`);

  let bound;
  const override = story.settings.roles.player_intake;
  if (override) bound = deps.registry.getProfile(override);
  else {
    try {
      bound = deps.registry.getForRole('player_intake');
    } catch {
      bound = deps.registry.getForRole('storyteller'); // configs from before the role existed
    }
  }
  const session = deps.agents.ensureSession(storyId, 'player_intake', bound.name);
  const agent = new PlayerIntake({ session, bound, threadLog: deps.threadLog, storyId });

  const mustFinish = exchanges.length >= MAX_INTERVIEW_ROUNDS;
  const reply = await agent.step({
    premise: story.settings.premise,
    digest: deps.summaries.getStoryDigest(storyId)?.content ?? '',
    exchanges,
    mustFinish,
  });

  if (!reply.done || !reply.delta) {
    if (mustFinish) throw new Error('the interviewer failed to produce a dossier — try again');
    return { done: false, question: reply.nextQuestion || 'Tell me about your character.', round: exchanges.length + 1, maxRounds: MAX_INTERVIEW_ROUNDS };
  }

  const affected = applyMemoryDelta(deps, storyId, null, reply.delta);
  const obj =
    (reply.playerName ? deps.memory.findByName(storyId, reply.playerName) : undefined) ??
    affected.map((id) => deps.memory.getObject(id)).find((o) => o?.type === 'character');
  if (!obj) throw new Error('the interview finished but no character was created — try again');

  deps.stories.updateStory(storyId, { settings: { playerObjectId: obj.id } });
  deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });
  logger.info('player character created', { storyId, objectId: obj.id, name: obj.name });
  return { done: true, objectId: obj.id, name: obj.name };
}
