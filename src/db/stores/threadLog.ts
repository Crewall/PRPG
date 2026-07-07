import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';
import type { EventBus } from '../../util/events.ts';

export interface ThreadLogEntry {
  id: string;
  storyId: string | null;
  turnId: string | null;
  sessionId: string | null;
  agentRole: string;
  direction: 'request' | 'response';
  payload: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  createdAt: number;
}

export interface NewThreadLogEntry {
  storyId?: string | null;
  turnId?: string | null;
  sessionId?: string | null;
  agentRole: string;
  direction: 'request' | 'response';
  payload: unknown;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
}

function rowToEntry(r: Row): ThreadLogEntry {
  return {
    id: r.id as string,
    storyId: (r.story_id as string) ?? null,
    turnId: (r.turn_id as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    agentRole: r.agent_role as string,
    direction: r.direction as 'request' | 'response',
    payload: JSON.parse(r.payload_json as string),
    tokensIn: (r.tokens_in as number) ?? null,
    tokensOut: (r.tokens_out as number) ?? null,
    durationMs: (r.duration_ms as number) ?? null,
    createdAt: r.created_at as number,
  };
}

export function createThreadLog(db: Db, events?: EventBus) {
  return {
    log(entry: NewThreadLogEntry): ThreadLogEntry {
      const now = Date.now();
      const entryId = id();
      db.prepare(
        `INSERT INTO thread_log (id, story_id, turn_id, session_id, agent_role, direction, payload_json, tokens_in, tokens_out, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entryId,
        entry.storyId ?? null,
        entry.turnId ?? null,
        entry.sessionId ?? null,
        entry.agentRole,
        entry.direction,
        JSON.stringify(entry.payload),
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.durationMs ?? null,
        now,
      );
      const saved = rowToEntry(db.prepare(`SELECT * FROM thread_log WHERE id = ?`).get<Row>(entryId)!);
      // Live agent-activity feed for the status bar (06-orchestration WS protocol).
      // Emitting on every request/response lets the client show which agent is
      // waiting vs. done, and count retries (each job re-run logs a fresh request).
      events?.emit({
        t: 'thread.activity',
        storyId: saved.storyId,
        entry: { agentRole: saved.agentRole, direction: saved.direction, turnId: saved.turnId, sessionId: saved.sessionId },
      });
      return saved;
    },

    query(storyId: string, opts: { turnId?: string; role?: string; limit?: number } = {}): ThreadLogEntry[] {
      const clauses = ['story_id = ?'];
      const params: unknown[] = [storyId];
      if (opts.turnId) {
        clauses.push('turn_id = ?');
        params.push(opts.turnId);
      }
      if (opts.role) {
        clauses.push('agent_role = ?');
        params.push(opts.role);
      }
      params.push(opts.limit ?? 200);
      return db
        .prepare(`SELECT * FROM thread_log WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .all<Row>(...params)
        .map(rowToEntry);
    },
  };
}

export type ThreadLog = ReturnType<typeof createThreadLog>;
