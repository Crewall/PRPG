import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';

// Minds threads (docs/10 §8) on top of agent_messages: an append-only log
// read back on every call, pending items waiting for the next round message,
// and (M6) a recap. The stored `content` is the exact string sent/received.

export type ThreadMessageKind = 'log' | 'pending' | 'delivered' | 'recap' | 'recap_old';

export interface ThreadMessage {
  id: string;
  rowid: number;
  sessionId: string;
  turnId: string | null;
  role: 'user' | 'assistant';
  content: string;
  kind: ThreadMessageKind;
  compacted: boolean;
  createdAt: number;
}

const rowToMessage = (r: Row): ThreadMessage => ({
  id: r.id as string,
  rowid: Number(r.rowid),
  sessionId: r.session_id as string,
  turnId: (r.turn_id as string) ?? null,
  role: r.role as ThreadMessage['role'],
  content: r.content as string,
  kind: r.kind as ThreadMessageKind,
  compacted: !!(r.compacted as number),
  createdAt: r.created_at as number,
});

export function createThreadStore(db: Db) {
  const select = `SELECT rowid, * FROM agent_messages`;
  const store = {
    append(sessionId: string, msg: { role: 'user' | 'assistant'; content: string; kind?: ThreadMessageKind; turnId?: string | null }): ThreadMessage {
      const now = Date.now();
      const mid = id();
      db.prepare(
        `INSERT INTO agent_messages (id, session_id, turn_id, role, content, pinned, kind, compacted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
      ).run(mid, sessionId, msg.turnId ?? null, msg.role, msg.content, msg.kind ?? 'log', now, now);
      return rowToMessage(db.prepare(`${select} WHERE id = ?`).get<Row>(mid)!);
    },

    /** The live log (not folded into a recap), in order. */
    log(sessionId: string): ThreadMessage[] {
      return db.prepare(`${select} WHERE session_id = ? AND kind = 'log' AND compacted = 0 ORDER BY rowid ASC`).all<Row>(sessionId).map(rowToMessage);
    },

    /** Items waiting for the next round message, oldest first. */
    pending(sessionId: string): ThreadMessage[] {
      return db.prepare(`${select} WHERE session_id = ? AND kind = 'pending' ORDER BY rowid ASC`).all<Row>(sessionId).map(rowToMessage);
    },

    markDelivered(ids: string[]): void {
      for (const mid of ids) db.prepare(`UPDATE agent_messages SET kind = 'delivered', updated_at = ? WHERE id = ?`).run(Date.now(), mid);
    },

    /** Fold log rows into the recap (they stay stored, flagged; rewind can unflag them). */
    markCompacted(ids: string[]): void {
      for (const mid of ids) db.prepare(`UPDATE agent_messages SET compacted = 1, updated_at = ? WHERE id = ? AND kind = 'log'`).run(Date.now(), mid);
    },

    /** Replace the current recap: the old one is kept as `recap_old`, the new one appended. */
    replaceRecap(sessionId: string, content: string, turnId: string | null): ThreadMessage {
      db.prepare(`UPDATE agent_messages SET kind = 'recap_old', updated_at = ? WHERE session_id = ? AND kind = 'recap'`).run(Date.now(), sessionId);
      return store.append(sessionId, { role: 'user', content, kind: 'recap', turnId });
    },

    /** The current recap, if the thread was ever compacted. */
    recap(sessionId: string): ThreadMessage | undefined {
      const r = db.prepare(`${select} WHERE session_id = ? AND kind = 'recap' ORDER BY rowid DESC LIMIT 1`).get<Row>(sessionId);
      return r ? rowToMessage(r) : undefined;
    },

    /** The last reply in the live log (the character's or narrator's latest turn in this thread). */
    lastReply(sessionId: string): ThreadMessage | undefined {
      const r = db.prepare(`${select} WHERE session_id = ? AND kind = 'log' AND role = 'assistant' ORDER BY rowid DESC LIMIT 1`).get<Row>(sessionId);
      return r ? rowToMessage(r) : undefined;
    },
  };
  return store;
}
export type ThreadStore = ReturnType<typeof createThreadStore>;
