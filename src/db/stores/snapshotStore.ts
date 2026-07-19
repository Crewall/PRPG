import type { Db, Row } from '../db.ts';

// Pre-turn state backups (feature 1a). At the start of every turn the pipeline
// captures everything a turn — and its async post-turn scribes — can mutate:
// scenes, summaries, memory objects/facts/knowledge links, suggestions, agent
// sessions and the transcript messages. Restoring a snapshot and deleting the
// turn rewinds the story to the exact moment the message was sent.
//
// Sizing: mutable tables are copied whole (they stay small and get rewritten
// in place); the append-only agent_messages transcript is NOT copied — a rowid
// watermark is enough, since rewinding only ever deletes messages appended
// after the capture.

interface SnapshotPayload {
  capturedAt: number;
  currentSceneId: string | null;
  clockMin?: number; // hidden in-game clock (absent on pre-clock snapshots)
  messageRowidWatermark: number;
  scenes: Row[];
  summaries: Row[];
  sessions: Row[];
  objects: Row[];
  facts: Row[];
  links: Row[];
  suggestions: Row[];
  npcProfiles?: Row[]; // absent on snapshots from before NPC Story Mode
}

const KEEP_PER_STORY = 8; // how many rewind steps back a story supports

export function createSnapshotStore(db: Db) {
  /** UPDATE by id with the given columns; INSERT if the row does not exist. */
  function upsert(table: string, row: Row, columns: string[]): void {
    const sets = columns.map((c) => `${c} = ?`).join(', ');
    const values = columns.map((c) => row[c] ?? null);
    const res = db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values, row.id);
    if (Number(res.changes) === 0) {
      const cols = ['id', ...columns];
      db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(row.id, ...values);
    }
  }

  return {
    /** Capture the story's mutable state as the backup for `turnId` (call before the turn writes anything). */
    capture(storyId: string, turnId: string, turnIndex: number): void {
      db.transaction(() => {
        const story = db.prepare(`SELECT current_scene_id, clock_min FROM stories WHERE id = ?`).get<Row>(storyId);
        const payload: SnapshotPayload = {
          capturedAt: Date.now(),
          currentSceneId: (story?.current_scene_id as string) ?? null,
          clockMin: (story?.clock_min as number) ?? undefined,
          messageRowidWatermark: Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM agent_messages`).get<{ m: number }>()!.m),
          scenes: db.prepare(`SELECT * FROM scenes WHERE story_id = ?`).all<Row>(storyId),
          summaries: db.prepare(`SELECT * FROM story_summaries WHERE story_id = ?`).all<Row>(storyId),
          sessions: db.prepare(`SELECT * FROM agent_sessions WHERE story_id = ?`).all<Row>(storyId),
          objects: db.prepare(`SELECT * FROM memory_objects WHERE story_id = ?`).all<Row>(storyId),
          facts: db
            .prepare(`SELECT mf.* FROM memory_facts mf JOIN memory_objects mo ON mo.id = mf.object_id WHERE mo.story_id = ?`)
            .all<Row>(storyId),
          links: db
            .prepare(
              `SELECT kl.* FROM knowledge_links kl
               JOIN memory_facts mf ON mf.id = kl.fact_id
               JOIN memory_objects mo ON mo.id = mf.object_id
               WHERE mo.story_id = ?`,
            )
            .all<Row>(storyId),
          suggestions: db.prepare(`SELECT * FROM memory_suggestions WHERE story_id = ?`).all<Row>(storyId),
          npcProfiles: db.prepare(`SELECT * FROM npc_profiles WHERE story_id = ?`).all<Row>(storyId),
        };
        db.prepare(
          `INSERT OR REPLACE INTO turn_snapshots (turn_id, story_id, turn_index, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(turnId, storyId, turnIndex, JSON.stringify(payload), Date.now());
        db.prepare(
          `DELETE FROM turn_snapshots WHERE story_id = ? AND turn_id NOT IN
             (SELECT turn_id FROM turn_snapshots WHERE story_id = ? ORDER BY turn_index DESC LIMIT ?)`,
        ).run(storyId, storyId, KEEP_PER_STORY);
      });
    },

    has(turnId: string): boolean {
      return !!db.prepare(`SELECT turn_id FROM turn_snapshots WHERE turn_id = ?`).get(turnId);
    },

    /**
     * Rewind: restore the state captured before `turnId` ran and delete that
     * turn (plus everything the turn and its scribes wrote since). Returns
     * false when no snapshot exists for the turn (pre-feature stories).
     */
    restore(storyId: string, turnId: string): boolean {
      const snap = db.prepare(`SELECT * FROM turn_snapshots WHERE turn_id = ? AND story_id = ?`).get<Row>(turnId, storyId);
      if (!snap) return false;
      const p = JSON.parse(snap.payload_json as string) as SnapshotPayload;

      db.transaction(() => {
        // 1. The rewound turn itself.
        db.prepare(`DELETE FROM turns WHERE id = ?`).run(turnId);

        // 2. Transcript messages appended during/after the turn (append-only → watermark).
        db.prepare(
          `DELETE FROM agent_messages WHERE rowid > ? AND session_id IN (SELECT id FROM agent_sessions WHERE story_id = ?)`,
        ).run(p.messageRowidWatermark, storyId);

        // 3. Agent sessions: drop ones created during the turn, restore prior state on the rest.
        const keepSessions = new Set(p.sessions.map((s) => s.id as string));
        for (const s of db.prepare(`SELECT id FROM agent_sessions WHERE story_id = ?`).all<Row>(storyId)) {
          if (!keepSessions.has(s.id as string)) db.prepare(`DELETE FROM agent_sessions WHERE id = ?`).run(s.id);
        }
        for (const s of p.sessions) upsert('agent_sessions', s, ['story_id', 'role', 'npc_object_id', 'model_profile', 'state', 'created_at', 'updated_at']);

        // 4. Scenes. Update-or-insert (never REPLACE: the FK's ON DELETE SET NULL
        // would null out scene_id on earlier turns), then drop scenes opened
        // during the rewound turn — only that (now deleted) turn referenced them.
        const keepScenes = new Set(p.scenes.map((s) => s.id as string));
        for (const s of p.scenes) upsert('scenes', s, ['story_id', 'idx', 'title', 'location_object_id', 'active_npc_ids', 'status', 'created_at', 'updated_at']);
        for (const s of db.prepare(`SELECT id FROM scenes WHERE story_id = ?`).all<Row>(storyId)) {
          if (!keepScenes.has(s.id as string)) db.prepare(`DELETE FROM scenes WHERE id = ?`).run(s.id);
        }
        db.prepare(`UPDATE stories SET current_scene_id = ?, updated_at = ? WHERE id = ?`).run(p.currentSceneId, Date.now(), storyId);
        if (p.clockMin !== undefined) db.prepare(`UPDATE stories SET clock_min = ? WHERE id = ?`).run(p.clockMin, storyId);

        // 5. Summaries & suggestions: small, rewritten wholesale — wipe and reinsert.
        db.prepare(`DELETE FROM story_summaries WHERE story_id = ?`).run(storyId);
        for (const s of p.summaries) upsert('story_summaries', s, ['story_id', 'scope', 'scene_id', 'content', 'covers_to_turn_index', 'created_at', 'updated_at']);
        db.prepare(`DELETE FROM memory_suggestions WHERE story_id = ?`).run(storyId);
        for (const s of p.suggestions) upsert('memory_suggestions', s, ['story_id', 'type', 'keep_id', 'merge_id', 'reason', 'status', 'payload_json', 'created_at', 'updated_at']);

        // 6. Memory. Plain per-row DELETE on facts fires the FTS sync triggers
        // (and cascades knowledge links); reinserting fires the insert triggers.
        db.prepare(`DELETE FROM memory_facts WHERE object_id IN (SELECT id FROM memory_objects WHERE story_id = ?)`).run(storyId);
        db.prepare(`DELETE FROM memory_objects WHERE story_id = ?`).run(storyId);
        for (const o of p.objects) upsert('memory_objects', o, ['story_id', 'type', 'name', 'aliases_json', 'summary', 'salience', 'status', 'created_at', 'updated_at']);
        for (const f of p.facts)
          upsert('memory_facts', f, ['object_id', 'category', 'subcategory', 'detail_level', 'tier', 'content', 'source_turn_id', 'supersedes_id', 'superseded', 'confidence', 'game_time_min', 'created_at', 'updated_at']);
        for (const l of p.links) upsert('knowledge_links', l, ['fact_id', 'knower_type', 'knower_npc_object_id', 'learned_turn_id', 'distortion', 'created_at', 'updated_at']);

        // 6b. NPC Story Mode profiles. Keyed by object_id (not id) so the
        // generic upsert doesn't apply; the object wipe above already cascaded
        // them away, so plain reinsert restores the captured state. Old
        // snapshots without the field leave whatever survived the cascade.
        for (const np of p.npcProfiles ?? []) {
          db.prepare(
            `INSERT OR REPLACE INTO npc_profiles (object_id, story_id, personality, notes, last_present_turn_idx, last_acted_turn_idx, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(np.object_id, np.story_id, np.personality, np.notes, np.last_present_turn_idx, np.last_acted_turn_idx, np.created_at, np.updated_at);
        }

        // 7. Queued post-turn work is now stale.
        db.prepare(`DELETE FROM jobs WHERE story_id = ? AND status IN ('pending', 'running')`).run(storyId);

        // 8. This snapshot (and any that pointed past it) no longer describes a real turn.
        db.prepare(`DELETE FROM turn_snapshots WHERE story_id = ? AND turn_index >= ?`).run(storyId, snap.turn_index);
      });
      return true;
    },
  };
}

export type SnapshotStore = ReturnType<typeof createSnapshotStore>;
