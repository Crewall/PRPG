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
  // Minds engine (docs/11 §7); absent on older snapshots.
  sheets?: Row[];
  variableValues?: Row[];
  thoughts?: Row[];
  names?: Row[];
  ties?: Row[];
  met?: Row[];
  thoughtTags?: Row[];
  varChangeRowidWatermark?: number;
  /** Thread rows whose kind/compacted flag can change in place (pending → delivered, compaction). */
  messageFlags?: { id: string; kind: string; compacted: number }[];
}

const KEEP_PER_STORY = 16; // how many turns back a story can be rewound or regenerated

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

  /** Everything mutable a turn (and its post-turn work) can change, as it is now. */
  function collect(storyId: string): SnapshotPayload {
    const story = db.prepare(`SELECT current_scene_id, clock_min FROM stories WHERE id = ?`).get<Row>(storyId);
    return {
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
      sheets: db.prepare(`SELECT * FROM character_sheets WHERE story_id = ?`).all<Row>(storyId),
      variableValues: db.prepare(`SELECT * FROM variable_values WHERE story_id = ?`).all<Row>(storyId),
      thoughts: db.prepare(`SELECT * FROM thoughts WHERE story_id = ?`).all<Row>(storyId),
      names: db.prepare(`SELECT * FROM name_knowledge WHERE story_id = ?`).all<Row>(storyId),
      ties: db.prepare(`SELECT * FROM character_ties WHERE story_id = ?`).all<Row>(storyId),
      met: db.prepare(`SELECT * FROM character_met WHERE story_id = ?`).all<Row>(storyId),
      thoughtTags: db
        .prepare(`SELECT tt.* FROM thought_tags tt JOIN thoughts t ON t.id = tt.thought_id WHERE t.story_id = ?`)
        .all<Row>(storyId),
      varChangeRowidWatermark: Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM variable_changes`).get<{ m: number }>()!.m),
      messageFlags: db
        .prepare(
          `SELECT m.id AS id, m.kind AS kind, m.compacted AS compacted FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id
           WHERE s.story_id = ? AND (m.kind <> 'log' OR m.compacted = 1)`,
        )
        .all<{ id: string; kind: string; compacted: number }>(storyId),
    };
  }

  /** Put the story's mutable state back to a collected payload (the transcript tail after its watermark goes). */
  function apply(storyId: string, p: SnapshotPayload): void {
    // 2. Transcript messages appended during/after the turn (append-only → watermark).
    db.prepare(
      `DELETE FROM agent_messages WHERE rowid > ? AND session_id IN (SELECT id FROM agent_sessions WHERE story_id = ?)`,
    ).run(p.messageRowidWatermark, storyId);

    // 2b. Thread flags changed in place since the capture (pending briefs
    // delivered, log rows compacted): back to what they were.
    if (p.messageFlags) {
      db.prepare(`UPDATE agent_messages SET compacted = 0 WHERE session_id IN (SELECT id FROM agent_sessions WHERE story_id = ?)`).run(storyId);
      for (const f of p.messageFlags) db.prepare(`UPDATE agent_messages SET kind = ?, compacted = ? WHERE id = ?`).run(f.kind, f.compacted, f.id);
    }

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
    for (const s of p.scenes) upsert('scenes', s, ['story_id', 'idx', 'title', 'location_object_id', 'active_npc_ids', 'items_json', 'status', 'created_at', 'updated_at']);
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
    for (const o of p.objects) upsert('memory_objects', o, ['story_id', 'type', 'name', 'aliases_json', 'summary', 'salience', 'status', 'handle', 'created_at', 'updated_at']);
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

    // 6c. Minds engine. Sheets are keyed by object_id and were cascaded away
    // with the objects above; values and thoughts are small — wipe and
    // reinsert. The change log is append-only: drop rows after the watermark.
    if (p.sheets) {
      db.prepare(`DELETE FROM character_sheets WHERE story_id = ?`).run(storyId);
      for (const s of p.sheets) {
        db.prepare(
          `INSERT OR REPLACE INTO character_sheets (object_id, story_id, is_player, description, appearance, pronouns, known_as, concept, nature, state, awareness, tier_id, seeded, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(s.object_id, s.story_id, s.is_player, s.description, s.appearance, s.pronouns ?? '', s.known_as ?? '', s.concept ?? '', s.nature ?? '', s.state, s.awareness ?? 'awake', s.tier_id ?? null, s.seeded, s.created_at, s.updated_at);
      }
    }
    if (p.variableValues) {
      db.prepare(`DELETE FROM variable_values WHERE story_id = ?`).run(storyId);
      for (const v of p.variableValues) {
        db.prepare(`INSERT INTO variable_values (story_id, def_key, holder, value_json, updated_turn_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          v.story_id,
          v.def_key,
          v.holder,
          v.value_json,
          v.updated_turn_id ?? null,
          v.updated_at,
        );
      }
    }
    if (p.thoughts) {
      // Your hand edits aren't part of a turn (docs/11 §5.10c): a thought changed, forgotten or added by hand after
      // this state was saved keeps the hand edit.
      const handEdited = db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND user_edited_at IS NOT NULL`).all<Row>(storyId);
      const handTags = handEdited.length
        ? db.prepare(`SELECT tt.* FROM thought_tags tt JOIN thoughts t ON t.id = tt.thought_id WHERE t.story_id = ? AND t.user_edited_at IS NOT NULL`).all<Row>(storyId)
        : [];
      db.prepare(`DELETE FROM thoughts WHERE story_id = ?`).run(storyId); // cascades thought_tags
      const insertThought = (t: Row) =>
        db.prepare(
          `INSERT INTO thoughts (id, story_id, owner, seq, text, pinned, status, source, created_turn_id, created_clock_min, revoked_turn_id, last_recalled_turn_id, recall_count, created_at, updated_at,
                                kind, importance, about, renewed_clock_min, revises, status_turn_id, renewed_turn_index, confidence, hope, horizon, basis, user_edited_at, former_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(t.id, t.story_id, t.owner, t.seq, t.text, t.pinned, t.status, t.source, t.created_turn_id ?? null, t.created_clock_min ?? null, t.revoked_turn_id ?? null, t.last_recalled_turn_id ?? null, t.recall_count, t.created_at, t.updated_at,
          t.kind ?? 'note', t.importance ?? 5, t.about ?? null, t.renewed_clock_min ?? t.created_clock_min ?? null, t.revises ?? null, t.status_turn_id ?? null,
          t.renewed_turn_index ?? null, t.confidence ?? null, t.hope ?? null, t.horizon ?? null, t.basis ?? null, t.user_edited_at ?? null, t.former_text ?? null);
      for (const t of p.thoughts) insertThought(t);
      for (const tt of p.thoughtTags ?? []) db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(tt.thought_id, tt.tag);
      const saved = new Map(p.thoughts.map((t) => [t.id as string, t]));
      for (const r of handEdited) {
        const s = saved.get(r.id as string);
        if (s && Number(s.user_edited_at ?? 0) >= Number(r.user_edited_at)) continue; // the saved copy already has it
        // Its owner must still be in the story, and its number free (it always is, short of a clash we skip).
        if (r.owner !== 'narrator' && !db.prepare(`SELECT 1 FROM character_sheets WHERE object_id = ? AND story_id = ?`).get(r.owner, storyId)) continue;
        if (db.prepare(`SELECT 1 FROM thoughts WHERE story_id = ? AND owner = ? AND seq = ? AND id <> ?`).get(storyId, r.owner, r.seq, r.id)) continue;
        db.prepare(`DELETE FROM thoughts WHERE id = ?`).run(r.id);
        insertThought(r);
        for (const tt of handTags) if (tt.thought_id === r.id) db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(tt.thought_id, tt.tag);
      }
    }
    if (p.names) {
      db.prepare(`DELETE FROM name_knowledge WHERE story_id = ?`).run(storyId);
      for (const n of p.names) {
        db.prepare(`INSERT OR IGNORE INTO name_knowledge (story_id, viewer, subject, learned_turn_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          n.story_id, n.viewer, n.subject, n.learned_turn_id ?? null, n.created_at,
        );
      }
    }
    if (p.ties) {
      db.prepare(`DELETE FROM character_ties WHERE story_id = ?`).run(storyId);
      for (const t of p.ties) {
        db.prepare(`INSERT OR IGNORE INTO character_ties (story_id, holder, other, label, created_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          t.story_id, t.holder, t.other, t.label, t.created_turn_id ?? null, t.created_at,
        );
      }
    }
    if (p.met) {
      db.prepare(`DELETE FROM character_met WHERE story_id = ?`).run(storyId);
      for (const m of p.met) {
        db.prepare(`INSERT OR IGNORE INTO character_met (story_id, a, b, first_turn_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(m.story_id, m.a, m.b, m.first_turn_id ?? null, m.created_at);
      }
    }
    if (p.varChangeRowidWatermark !== undefined) {
      db.prepare(`DELETE FROM variable_changes WHERE story_id = ? AND rowid > ?`).run(storyId, p.varChangeRowidWatermark);
    }
  }

  return {
    /** Capture the story's mutable state as the backup for `turnId` (call before the turn writes anything). */
    capture(storyId: string, turnId: string, turnIndex: number): void {
      db.transaction(() => {
        const payload = collect(storyId);
        db.prepare(
          `INSERT OR REPLACE INTO turn_snapshots (turn_id, story_id, turn_index, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`,
        ).run(turnId, storyId, turnIndex, JSON.stringify(payload), Date.now());
        db.prepare(
          `DELETE FROM turn_snapshots WHERE story_id = ? AND turn_id NOT IN
             (SELECT turn_id FROM turn_snapshots WHERE story_id = ? ORDER BY turn_index DESC LIMIT ?)`,
        ).run(storyId, storyId, KEEP_PER_STORY);
      });
    },

    /** Forget a turn's snapshot (its turn was deleted another way). */
    drop(turnId: string): void {
      db.prepare(`DELETE FROM turn_snapshots WHERE turn_id = ?`).run(turnId);
    },

    /** The turns of a story that still have a snapshot (can be regenerated). */
    turnIds(storyId: string): Set<string> {
      return new Set(db.prepare(`SELECT turn_id FROM turn_snapshots WHERE story_id = ?`).all<{ turn_id: string }>(storyId).map((r) => r.turn_id));
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

        apply(storyId, p);

        // 7. Queued post-turn work is now stale.
        db.prepare(`DELETE FROM jobs WHERE story_id = ? AND status IN ('pending', 'running')`).run(storyId);

        // 8. This snapshot (and any that pointed past it) no longer describes a real turn.
        db.prepare(`DELETE FROM turn_snapshots WHERE story_id = ? AND turn_index >= ?`).run(storyId, snap.turn_index);
      });
      return true;
    },

    // ---- One undo step (docs/10 §10a) ----

    /**
     * Save the story as it is now, before a destructive action that touches turns from `fromIndex` on: the
     * mutable state, the turn rows and their snapshots, and the transcript and change-log rows written since the
     * turn at `fromIndex` began (which the action is about to delete). Replaces any earlier slot.
     */
    saveUndo(storyId: string, slot: { action: string; label: string; fromIndex: number }): void {
      db.transaction(() => {
        const snap = db.prepare(`SELECT payload_json FROM turn_snapshots WHERE story_id = ? AND turn_index = ?`).get<Row>(storyId, slot.fromIndex);
        const base = snap ? (JSON.parse(snap.payload_json as string) as SnapshotPayload) : undefined;
        const turns = db.prepare(`SELECT * FROM turns WHERE story_id = ? AND idx >= ? ORDER BY idx`).all<Row>(storyId, slot.fromIndex);
        const turnIds = turns.map((t) => t.id as string);
        // Where the touched turns' transcript begins: the snapshot's watermark, else their first message.
        const firstOwn = turnIds.length
          ? Number(
              db.prepare(`SELECT COALESCE(MIN(rowid), 0) AS m FROM agent_messages WHERE turn_id IN (${turnIds.map(() => '?').join(',')})`).get<{ m: number }>(...turnIds)!.m,
            )
          : 0;
        const messageWatermark = base?.messageRowidWatermark ?? (firstOwn ? firstOwn - 1 : Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM agent_messages`).get<{ m: number }>()!.m));
        const varWatermark = base?.varChangeRowidWatermark ?? Number(db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM variable_changes`).get<{ m: number }>()!.m);
        const payload = {
          kind: 'state' as const,
          state: collect(storyId),
          turns,
          snapshots: db.prepare(`SELECT * FROM turn_snapshots WHERE story_id = ? AND turn_index >= ?`).all<Row>(storyId, slot.fromIndex),
          messageWatermark,
          messages: db
            .prepare(`SELECT rowid AS rowid_, * FROM agent_messages WHERE rowid > ? AND session_id IN (SELECT id FROM agent_sessions WHERE story_id = ?) ORDER BY rowid`)
            .all<Row>(messageWatermark, storyId),
          varWatermark,
          varChanges: db.prepare(`SELECT rowid AS rowid_, * FROM variable_changes WHERE story_id = ? AND rowid > ? ORDER BY rowid`).all<Row>(storyId, varWatermark),
        };
        db.prepare(`INSERT OR REPLACE INTO undo_slots (story_id, action, label, from_index, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          storyId, slot.action, slot.label, slot.fromIndex, JSON.stringify(payload), Date.now(),
        );
      });
    },

    /** Save one turn's rows before a transcript-only change (an older message edited or removed). */
    saveRowUndo(storyId: string, turnId: string, slot: { action: string; label: string }): void {
      const turn = db.prepare(`SELECT * FROM turns WHERE id = ?`).get<Row>(turnId);
      if (!turn) return;
      const payload = {
        kind: 'rows' as const,
        turn,
        snapshot: db.prepare(`SELECT * FROM turn_snapshots WHERE turn_id = ?`).get<Row>(turnId) ?? null,
        messages: db.prepare(`SELECT rowid AS rowid_, * FROM agent_messages WHERE turn_id = ? ORDER BY rowid`).all<Row>(turnId),
      };
      db.prepare(`INSERT OR REPLACE INTO undo_slots (story_id, action, label, from_index, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        storyId, slot.action, slot.label, turn.idx as number, JSON.stringify(payload), Date.now(),
      );
    },

    /** What Revert would undo, if anything. */
    undoInfo(storyId: string): { action: string; label: string; fromIndex: number; createdAt: number } | undefined {
      const r = db.prepare(`SELECT action, label, from_index, created_at FROM undo_slots WHERE story_id = ?`).get<Row>(storyId);
      return r ? { action: r.action as string, label: r.label as string, fromIndex: r.from_index as number, createdAt: r.created_at as number } : undefined;
    },

    clearUndo(storyId: string): void {
      db.prepare(`DELETE FROM undo_slots WHERE story_id = ?`).run(storyId);
    },

    /** Revert: put the story back exactly as the slot saved it, then empty the slot. False when there is none. */
    applyUndo(storyId: string): boolean {
      const r = db.prepare(`SELECT * FROM undo_slots WHERE story_id = ?`).get<Row>(storyId);
      if (!r) return false;
      const fromIndex = r.from_index as number;
      const payload = JSON.parse(r.payload_json as string) as
        | { kind: 'state'; state: SnapshotPayload; turns: Row[]; snapshots: Row[]; messageWatermark: number; messages: Row[]; varWatermark: number; varChanges: Row[] }
        | { kind: 'rows'; turn: Row; snapshot: Row | null; messages: Row[] };
      const insert = (table: string, row: Row) => {
        const { rowid_, ...rest } = row;
        const cols = [...(rowid_ !== undefined ? ['rowid'] : []), ...Object.keys(rest)];
        const vals = [...(rowid_ !== undefined ? [rowid_] : []), ...Object.values(rest)];
        db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
      };
      db.transaction(() => {
        if (payload.kind === 'rows') {
          insert('turns', payload.turn);
          if (payload.snapshot) insert('turn_snapshots', payload.snapshot);
          for (const m of payload.messages) insert('agent_messages', m);
        } else {
          // What the action made since (a new reply, its transcript, its changes) goes first.
          db.prepare(`DELETE FROM turns WHERE story_id = ? AND idx >= ?`).run(storyId, fromIndex);
          db.prepare(`DELETE FROM agent_messages WHERE rowid > ? AND session_id IN (SELECT id FROM agent_sessions WHERE story_id = ?)`).run(payload.messageWatermark, storyId);
          db.prepare(`DELETE FROM variable_changes WHERE story_id = ? AND rowid > ?`).run(storyId, payload.varWatermark);
          db.prepare(`DELETE FROM turn_snapshots WHERE story_id = ? AND turn_index >= ?`).run(storyId, fromIndex);
          // Then the saved state: scenes, sessions and the rest first (the rows below refer to them).
          apply(storyId, payload.state);
          for (const t of payload.turns) insert('turns', t);
          for (const sn of payload.snapshots) insert('turn_snapshots', sn);
          for (const m of payload.messages) insert('agent_messages', m);
          for (const v of payload.varChanges) insert('variable_changes', v);
          db.prepare(`DELETE FROM jobs WHERE story_id = ? AND status IN ('pending', 'running')`).run(storyId);
        }
        db.prepare(`DELETE FROM undo_slots WHERE story_id = ?`).run(storyId);
      });
      return true;
    },
  };
}

export type SnapshotStore = ReturnType<typeof createSnapshotStore>;
