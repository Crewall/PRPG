import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';
import { estimateTokens } from '../../util/tokens.ts';
import type { AgentMessage, AgentSession, SessionState } from '../../domain.ts';
import type { RoleName } from '../../config/config.ts';

function rowToSession(r: Row): AgentSession {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    role: r.role as RoleName,
    npcObjectId: (r.npc_object_id as string) ?? null,
    modelProfile: r.model_profile as string,
    state: r.state as SessionState,
  };
}

function rowToMessage(r: Row): AgentMessage {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnId: (r.turn_id as string) ?? null,
    role: r.role as AgentMessage['role'],
    content: r.content as string,
    pinned: !!(r.pinned as number),
  };
}

export function createAgentStore(db: Db) {
  return {
    /** Get or create the session for a (story, role[, npc]) tuple. */
    ensureSession(storyId: string, role: RoleName, modelProfile: string, npcObjectId?: string): AgentSession {
      const existing = npcObjectId
        ? db.prepare(`SELECT * FROM agent_sessions WHERE story_id = ? AND role = ? AND npc_object_id = ?`).get<Row>(storyId, role, npcObjectId)
        : db.prepare(`SELECT * FROM agent_sessions WHERE story_id = ? AND role = ? AND npc_object_id IS NULL`).get<Row>(storyId, role);
      if (existing) return rowToSession(existing);

      const now = Date.now();
      const sessionId = id();
      db.prepare(
        `INSERT INTO agent_sessions (id, story_id, role, npc_object_id, model_profile, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(sessionId, storyId, role, npcObjectId ?? null, modelProfile, now, now);
      return this.getSession(sessionId)!;
    },

    getSession(sessionId: string): AgentSession | undefined {
      const r = db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get<Row>(sessionId);
      return r ? rowToSession(r) : undefined;
    },

    listSessions(storyId: string): AgentSession[] {
      return db.prepare(`SELECT * FROM agent_sessions WHERE story_id = ? ORDER BY created_at ASC`).all<Row>(storyId).map(rowToSession);
    },

    setState(sessionId: string, state: SessionState): void {
      db.prepare(`UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?`).run(state, Date.now(), sessionId);
    },

    setModelProfile(sessionId: string, modelProfile: string): void {
      db.prepare(`UPDATE agent_sessions SET model_profile = ?, updated_at = ? WHERE id = ?`).run(modelProfile, Date.now(), sessionId);
    },

    appendMessage(sessionId: string, msg: { role: AgentMessage['role']; content: string; turnId?: string | null; pinned?: boolean }): AgentMessage {
      const now = Date.now();
      const msgId = id();
      db.prepare(
        `INSERT INTO agent_messages (id, session_id, turn_id, role, content, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(msgId, sessionId, msg.turnId ?? null, msg.role, msg.content, msg.pinned ? 1 : 0, now, now);
      return rowToMessage(db.prepare(`SELECT * FROM agent_messages WHERE id = ?`).get<Row>(msgId)!);
    },

    countMessages(sessionId: string): number {
      const r = db.prepare(`SELECT count(*) AS n FROM agent_messages WHERE session_id = ?`).get<{ n: number }>(sessionId);
      return r?.n ?? 0;
    },

    /**
     * Return pinned messages plus the most recent messages that fit within a
     * token budget, in chronological order. (Window compaction — Layer 1 uses a
     * naive full-history builder elsewhere; this is here for later layers.)
     */
    getWindow(sessionId: string, budgetTokens: number): AgentMessage[] {
      const all = db.prepare(`SELECT * FROM agent_messages WHERE session_id = ? ORDER BY created_at ASC`).all<Row>(sessionId).map(rowToMessage);
      const pinned = all.filter((m) => m.pinned);
      const rest = all.filter((m) => !m.pinned);
      let used = pinned.reduce((n, m) => n + estimateTokens(m.content), 0);
      const kept: AgentMessage[] = [];
      for (let i = rest.length - 1; i >= 0; i--) {
        const cost = estimateTokens(rest[i].content) + 4;
        if (used + cost > budgetTokens && kept.length) break;
        used += cost;
        kept.unshift(rest[i]);
      }
      // Merge pinned (which come first) with the recent window, chronologically.
      return [...pinned, ...kept].sort((a, b) => all.indexOf(a) - all.indexOf(b));
    },
  };
}

export type AgentStore = ReturnType<typeof createAgentStore>;
