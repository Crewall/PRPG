import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';

export interface Suggestion {
  id: string;
  storyId: string;
  type: 'merge' | 'contradiction';
  keepId: string | null;
  mergeId: string | null;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
  payload: Record<string, unknown>;
  createdAt: number;
}

function rowToSuggestion(r: Row): Suggestion {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    type: r.type as 'merge' | 'contradiction',
    keepId: (r.keep_id as string) ?? null,
    mergeId: (r.merge_id as string) ?? null,
    reason: r.reason as string,
    status: r.status as Suggestion['status'],
    payload: JSON.parse((r.payload_json as string) || '{}'),
    createdAt: r.created_at as number,
  };
}

// The suggestion inbox (Layer 3b): fuzzy merges / contradictions for human review.
export function createSuggestionStore(db: Db) {
  return {
    add(input: { storyId: string; type: 'merge' | 'contradiction'; keepId?: string; mergeId?: string; reason: string; payload?: Record<string, unknown> }): Suggestion {
      // Dedupe identical pending merge suggestions.
      if (input.type === 'merge' && input.keepId && input.mergeId) {
        const existing = db
          .prepare(`SELECT * FROM memory_suggestions WHERE story_id = ? AND type = 'merge' AND keep_id = ? AND merge_id = ? AND status = 'pending'`)
          .get<Row>(input.storyId, input.keepId, input.mergeId);
        if (existing) return rowToSuggestion(existing);
      }
      const now = Date.now();
      const sid = id();
      db.prepare(
        `INSERT INTO memory_suggestions (id, story_id, type, keep_id, merge_id, reason, status, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(sid, input.storyId, input.type, input.keepId ?? null, input.mergeId ?? null, input.reason, JSON.stringify(input.payload ?? {}), now, now);
      return rowToSuggestion(db.prepare(`SELECT * FROM memory_suggestions WHERE id = ?`).get<Row>(sid)!);
    },

    listPending(storyId: string): Suggestion[] {
      return db.prepare(`SELECT * FROM memory_suggestions WHERE story_id = ? AND status = 'pending' ORDER BY created_at DESC`).all<Row>(storyId).map(rowToSuggestion);
    },

    get(sid: string): Suggestion | undefined {
      const r = db.prepare(`SELECT * FROM memory_suggestions WHERE id = ?`).get<Row>(sid);
      return r ? rowToSuggestion(r) : undefined;
    },

    setStatus(sid: string, status: 'accepted' | 'rejected'): void {
      db.prepare(`UPDATE memory_suggestions SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), sid);
    },
  };
}

export type SuggestionStore = ReturnType<typeof createSuggestionStore>;
