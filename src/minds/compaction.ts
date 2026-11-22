import type { Job } from '../db/stores/jobStore.ts';
import type { ThreadMessage } from '../db/stores/threadStore.ts';
import type { JobHandler } from '../orchestrator/postTurn.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { logger } from '../util/logger.ts';
import { estimateTokens } from '../util/tokens.ts';
import { NARRATOR_OWNER } from './builders.ts';
import { splitNarratorReply } from './contracts.ts';
import { clampWords } from './text.ts';
import { renderThought } from './thoughts.ts';
import type { Thought } from './thoughts.ts';
import { applyThoughtOps } from './service.ts';
import type { RoundDeps } from './round.ts';

// Thread compaction (docs/10 §8.4). When a thread's live log grows past its
// threshold, a Light-tier compactor folds the oldest half into a recap:
// first person for a character, third person for the narrator. The folded rows
// stay stored but flagged `compacted`; the old recap becomes `recap_old`; the
// new recap sits before the log. The thread pays one cache miss on its next
// call. Rewind restores the flags from the snapshot, so it undoes a compaction.

/** Recap length caps (words). */
export const RECAP_WORDS = { character: 350, narrator: 900 } as const;

export interface CompactionPlan {
  sessionId: string;
  kind: 'character' | 'narrator';
  /** The character whose thread this is (characters only). */
  objectId?: string;
  /** The oldest whole rounds (round message + reply pairs), folded into the recap. */
  fold: ThreadMessage[];
  /** What stays in the live log (never empty: the newest round always stays). */
  keep: ThreadMessage[];
  logTokens: number;
  threshold: number;
}

export function logTokens(log: ThreadMessage[]): number {
  return log.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

/**
 * Does this thread need compacting, and what would be folded? Undefined when
 * it is under its threshold or there is nothing safe to fold. The fold ends at
 * a round boundary (after a reply, before a round message) as soon as it holds
 * half the log's tokens, and always leaves the newest round in place.
 */
export function planCompaction(deps: RoundDeps, storyId: string, sessionId: string): CompactionPlan | undefined {
  const story = deps.stories.getStory(storyId);
  const session = deps.agents.getSession(sessionId);
  if (!story || !session || session.storyId !== storyId) return undefined;
  if (session.role !== 'character' && session.role !== 'narrator') return undefined;
  const kind = session.role;
  const threshold = kind === 'character' ? story.settings.minds.characterLogTokens : story.settings.minds.narratorLogTokens;
  const log = deps.threads.log(sessionId);
  const total = logTokens(log);
  if (total <= threshold) return undefined;

  // Round boundaries: a reply followed by a round message.
  const boundaries: number[] = [];
  for (let i = 1; i < log.length; i++) if (log[i - 1].role === 'assistant' && log[i].role === 'user') boundaries.push(i);
  if (!boundaries.length) return undefined;
  let cut = boundaries[boundaries.length - 1];
  let acc = 0;
  let b = 0;
  for (let i = 0; i < log.length && b < boundaries.length; i++) {
    acc += estimateTokens(log[i].content) + 4;
    if (i + 1 === boundaries[b]) {
      if (acc * 2 >= total) {
        cut = boundaries[b];
        break;
      }
      b++;
    }
  }
  return {
    sessionId,
    kind,
    objectId: kind === 'character' ? (session.npcObjectId ?? undefined) : undefined,
    fold: log.slice(0, cut),
    keep: log.slice(cut),
    logTokens: total,
    threshold,
  };
}

/** After a turn: queue a compaction for each touched thread over its threshold (once per thread). */
export function queueCompactions(deps: RoundDeps, storyId: string, sessionIds: Iterable<string>, turnId: string): void {
  for (const sessionId of new Set(sessionIds)) {
    if (!planCompaction(deps, storyId, sessionId)) continue;
    const queued = deps.db
      .prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'minds_compact' AND status IN ('pending','running') AND json_extract(payload_json, '$.sessionId') = ?`)
      .get<{ n: number }>(sessionId)!.n;
    if (!queued) deps.jobs.enqueue('minds_compact', { storyId, turnId, payload: { sessionId } });
  }
}

const handleOf = (deps: RoundDeps, oid: string) => `#${deps.memory.getObject(oid)?.handle ?? deps.memory.ensureHandle(oid) ?? '?'}`;

/** The folded rounds as the compactor reads them (the narrator's hidden blocks left out). */
function renderFolded(plan: CompactionPlan): string {
  return plan.fold
    .map((m) => {
      if (m.role === 'user') return `[Round — ${plan.kind === 'character' ? 'what you were told' : 'what the narrator was told'}]\n${m.content.trim()}`;
      const text = plan.kind === 'narrator' ? splitNarratorReply(m.content).prose || m.content : m.content;
      return `[${plan.kind === 'character' ? 'Your reply' : "The narrator's reply"}]\n${text.trim()}`;
    })
    .join('\n\n');
}

/**
 * The recap as stored in the thread: the compactor's text plus what must not be
 * lost, rendered by the server — the owner's pinned thoughts and, for
 * characters, their tag vocabulary; for the narrator, the roster.
 */
function renderRecap(deps: RoundDeps, storyId: string, plan: CompactionPlan, text: string, pinned: Thought[]): string {
  const owner = plan.kind === 'character' ? plan.objectId! : NARRATOR_OWNER;
  const parts: string[] = [];
  if (plan.kind === 'character') {
    parts.push(`What you remember from earlier (your older rounds, in your own words):\n${text}`);
    if (pinned.length) parts.push(`Always on your mind:\n${pinned.map(renderThought).join('\n')}`);
    const vocab = deps.thoughts.vocabulary(storyId, owner).map((v) => v.tag);
    if (vocab.length) parts.push(`Your tags so far: ${[...vocab].sort().join(', ')}`);
  } else {
    parts.push(`The story so far (the older rounds, summarised):\n${text}`);
    const player = deps.sheets.player(storyId);
    const roster = deps.sheets
      .listForStory(storyId)
      .filter((s) => deps.memory.getObject(s.objectId))
      .map((s) => {
        const name = deps.memory.getObject(s.objectId)!.name;
        const look = s.appearance.trim() ? ` — ${clampWords(s.appearance.trim(), 20).text}` : '';
        return `- ${handleOf(deps, s.objectId)} ${name}${s.objectId === player?.objectId ? ' (the player character)' : ''}${look}`;
      });
    if (roster.length) parts.push(`Characters so far:\n${roster.join('\n')}`);
    if (pinned.length) parts.push(`Your pinned notes:\n${pinned.map(renderThought).join('\n')}`);
  }
  return parts.join('\n\n');
}

export function createMindsCompactHandler(deps: RoundDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const sessionId = job.payload.sessionId as string;
    const story = deps.stories.getStory(storyId);
    const turn = job.turnId ? deps.stories.getTurn(job.turnId) : undefined;
    if (!story || (job.turnId && turn?.status !== 'complete')) return; // deleted or rewound meanwhile
    const plan = planCompaction(deps, storyId, sessionId);
    if (!plan) return; // already compacted, or edited below the threshold
    const priorRecap = deps.threads.recap(sessionId);

    const whose =
      plan.kind === 'character'
        ? `This is the thread of ${handleOf(deps, plan.objectId!)} ${deps.memory.getObject(plan.objectId!)?.name ?? '?'}, a character. Write the recap in their voice, first person.`
        : "This is the narrator's thread. Write the recap in the third person.";
    const user = [
      whose,
      priorRecap ? `The earlier recap (fold it in):\n${priorRecap.content.trim()}` : '',
      `The oldest rounds, to fold:\n\n${renderFolded(plan)}`,
      `Write the recap in at most ${RECAP_WORDS[plan.kind]} words. Reply as JSON.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const bound = deps.registry.getForRole('compactor', story.settings.roles.compactor);
    const session = deps.agents.ensureSession(storyId, 'compactor', bound.name, plan.objectId);
    const reply = await new MindAgent({ session, bound, threadLog: deps.threadLog, storyId }).compact(
      { system: renderPrompt('minds-compactor', {}), messages: [{ role: 'user', content: user }] },
      { maxTokens: RECAP_WORDS[plan.kind] * 3 },
    );
    if (!reply.recap) throw new Error('the compactor wrote no recap');
    const text = clampWords(reply.recap, RECAP_WORDS[plan.kind]).text;

    let done = false;
    deps.db.transaction(() => {
      // The thread may have moved on while the compactor wrote (a rewind, another compaction): fold only if
      // the rounds read are still the live log's oldest and the recap is still the one folded in.
      const live = deps.threads.log(sessionId);
      const same = plan.fold.every((m, i) => live[i]?.id === m.id) && deps.threads.recap(sessionId)?.id === priorRecap?.id;
      if (!same) return;
      const owner = plan.kind === 'character' ? plan.objectId! : NARRATOR_OWNER;
      const pinned = deps.thoughts.list(storyId, owner).filter((t) => t.pinned);
      deps.threads.replaceRecap(sessionId, renderRecap(deps, storyId, plan, text, pinned), job.turnId ?? null);
      deps.threads.markCompacted(plan.fold.map((m) => m.id));
      // The recap restates them, so the builders count them as shown (docs/10 §8: never repeat what the thread holds).
      deps.thoughts.markRecalled(pinned.map((t) => t.id), job.turnId ?? null);
      if (plan.kind === 'character' && reply.pins.length) {
        applyThoughtOps(deps, storyId, plan.objectId!, { remember: reply.pins.map((p) => ({ ...p, pin: true })) }, 'compactor', job.turnId ?? null);
      }
      done = true;
    });
    if (!done) {
      logger.info('compaction skipped: the thread changed meanwhile', { storyId, sessionId });
      return;
    }
    logger.info('thread compacted', { storyId, sessionId, kind: plan.kind, folded: plan.fold.length, kept: plan.keep.length, logTokens: plan.logTokens });
    if (plan.objectId) deps.events.emit({ t: 'minds.updated', storyId, objectIds: [plan.objectId] });
  };
}
