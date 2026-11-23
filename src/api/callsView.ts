import type { App } from '../app.ts';
import type { ThreadLogEntry } from '../db/stores/threadLog.ts';
import { ROLE_LABELS } from '../config/config.ts';
import type { RoleName } from '../config/config.ts';
import { formatGameClock } from '../util/gameClock.ts';

// The Threads view (debug drawer): every agent call as one row — whose mind it
// was, when (turn, game time, wall time), request and response together, cache
// use, and the error when it failed.

export interface CallView {
  id: string;
  role: string;
  /** "Marta", "Narrator", "Compactor · Marta", "Seeder · Tom"… */
  mind: string;
  sessionId: string | null;
  turnId: string | null;
  turnIndex: number | null;
  gameTime: string | null;
  startedAt: number;
  status: 'waiting' | 'done' | 'failed';
  error?: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheRead: number | null;
  durationMs: number | null;
  model?: string;
  request: ThreadLogEntry;
  response: ThreadLogEntry | null;
}

const MIND_ROLES = new Set(['character', 'npc']);

export function listCalls(app: App, storyId: string, limit = 40): CallView[] {
  // Oldest first, so each response closes the latest open request of its session.
  const entries = app.threadLog.query(storyId, { limit: limit * 2 + 20 }).reverse();
  const open = new Map<string, CallView>();
  const calls: CallView[] = [];
  const turnCache = new Map<string, { index: number; gameTime: string | null } | null>();
  const turnInfo = (turnId: string | null) => {
    if (!turnId) return null;
    if (!turnCache.has(turnId)) {
      const t = app.stories.getTurn(turnId);
      const clock = t && typeof t.meta?.clockMin === 'number' ? (t.meta.clockMin as number) : undefined;
      turnCache.set(turnId, t ? { index: t.index, gameTime: clock !== undefined ? formatGameClock(clock) : null } : null);
    }
    return turnCache.get(turnId)!;
  };
  const mindOf = (e: ThreadLogEntry) => {
    const session = e.sessionId ? app.agents.getSession(e.sessionId) : undefined;
    const who = session?.npcObjectId ? app.memory.getObject(session.npcObjectId)?.name : undefined;
    if (MIND_ROLES.has(e.agentRole) && who) return who;
    const label = e.agentRole === 'narrator' ? 'Narrator' : (ROLE_LABELS[e.agentRole as RoleName] ?? e.agentRole).replace(/ \(Minds\)$/, '');
    return who ? `${label} · ${who}` : label;
  };

  for (const e of entries) {
    const key = e.sessionId ?? `role:${e.agentRole}`;
    if (e.direction === 'request') {
      const info = turnInfo(e.turnId);
      const payload = e.payload as { model?: string } | null;
      const call: CallView = {
        id: e.id,
        role: e.agentRole,
        mind: mindOf(e),
        sessionId: e.sessionId,
        turnId: e.turnId,
        turnIndex: info?.index ?? null,
        gameTime: info?.gameTime ?? null,
        startedAt: e.createdAt,
        status: 'waiting',
        tokensIn: e.tokensIn,
        tokensOut: null,
        cacheRead: null,
        durationMs: null,
        model: payload?.model,
        request: e,
        response: null,
      };
      // A request left open by an earlier attempt (no response logged) stays "waiting" only if it is the latest.
      open.set(key, call);
      calls.push(call);
    } else {
      const call = open.get(key);
      if (!call) continue; // its request fell outside the window
      open.delete(key);
      const error = (e.payload as { error?: string } | null)?.error;
      call.response = e;
      call.status = error ? 'failed' : 'done';
      if (error) call.error = error;
      call.tokensIn = e.tokensIn ?? call.tokensIn;
      call.tokensOut = e.tokensOut;
      call.cacheRead = e.cacheRead;
      call.durationMs = e.durationMs;
    }
  }
  // An unanswered request that is not the newest of its session was cut off (crash, restart).
  for (const c of calls) if (c.status === 'waiting' && open.get(c.sessionId ?? `role:${c.role}`) !== c) c.status = 'failed';
  return calls.reverse().slice(0, limit);
}
