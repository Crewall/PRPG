import type { Db, Row } from '../db.ts';

// NPC Story Mode (docs/09): one row per major NPC — the character's "mind" as
// a narrative document instead of structured facts. `personality` is stable
// (seeded once, player-editable); `notes` is the NPC's own evolving private
// story, rewritten by the NPC itself each round it acts.
export interface NpcProfile {
  objectId: string;
  storyId: string;
  personality: string;
  notes: string;
  /** Index of the last turn this NPC was present for (gap notes on re-entry). */
  lastPresentTurnIdx: number;
  /** Index of the last turn this NPC actually acted in (skip-gate input). */
  lastActedTurnIdx: number;
  createdAt: number;
  updatedAt: number;
}

function rowToProfile(r: Row): NpcProfile {
  return {
    objectId: r.object_id as string,
    storyId: r.story_id as string,
    personality: r.personality as string,
    notes: r.notes as string,
    lastPresentTurnIdx: r.last_present_turn_idx as number,
    lastActedTurnIdx: r.last_acted_turn_idx as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function createNpcProfileStore(db: Db) {
  return {
    get(objectId: string): NpcProfile | undefined {
      const r = db.prepare(`SELECT * FROM npc_profiles WHERE object_id = ?`).get<Row>(objectId);
      return r ? rowToProfile(r) : undefined;
    },

    listForStory(storyId: string): NpcProfile[] {
      return db
        .prepare(`SELECT * FROM npc_profiles WHERE story_id = ? ORDER BY updated_at DESC`)
        .all<Row>(storyId)
        .map(rowToProfile);
    },

    /** Create-or-update; only the provided fields change on an existing row. */
    upsert(
      storyId: string,
      objectId: string,
      patch: { personality?: string; notes?: string; lastPresentTurnIdx?: number; lastActedTurnIdx?: number },
    ): NpcProfile {
      const now = Date.now();
      const existing = this.get(objectId);
      if (!existing) {
        db.prepare(
          `INSERT INTO npc_profiles (object_id, story_id, personality, notes, last_present_turn_idx, last_acted_turn_idx, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(objectId, storyId, patch.personality ?? '', patch.notes ?? '', patch.lastPresentTurnIdx ?? -1, patch.lastActedTurnIdx ?? -1, now, now);
      } else {
        db.prepare(
          `UPDATE npc_profiles SET personality = ?, notes = ?, last_present_turn_idx = ?, last_acted_turn_idx = ?, updated_at = ? WHERE object_id = ?`,
        ).run(
          patch.personality ?? existing.personality,
          patch.notes ?? existing.notes,
          patch.lastPresentTurnIdx ?? existing.lastPresentTurnIdx,
          patch.lastActedTurnIdx ?? existing.lastActedTurnIdx,
          now,
          objectId,
        );
      }
      return this.get(objectId)!;
    },

    delete(objectId: string): void {
      db.prepare(`DELETE FROM npc_profiles WHERE object_id = ?`).run(objectId);
    },
  };
}

export type NpcProfileStore = ReturnType<typeof createNpcProfileStore>;
