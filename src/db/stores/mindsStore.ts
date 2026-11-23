import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';
import { VariableDef } from '../../minds/variables.ts';
import type { ChangeOutcome, VariableValue } from '../../minds/variables.ts';
import type { Thought } from '../../minds/thoughts.ts';

// Storage for the Minds engine (docs/11 §7): character sheets, scenario
// variables (definitions, values, change log) and self-written thoughts.

// ---- Character sheets ----

export interface CharacterSheet {
  objectId: string;
  storyId: string;
  isPlayer: boolean;
  description: string;
  appearance: string;
  /** Public: how others refer to them ("she/her"). */
  pronouns: string;
  /** Public: what someone who doesn't know their name calls them ("the elf girl in green"; docs/11 §2.5). */
  knownAs: string;
  state: string;
  tierId: string | null;
  seeded: boolean;
  createdAt: number;
  updatedAt: number;
}

const rowToSheet = (r: Row): CharacterSheet => ({
  objectId: r.object_id as string,
  storyId: r.story_id as string,
  isPlayer: !!(r.is_player as number),
  description: r.description as string,
  appearance: r.appearance as string,
  pronouns: (r.pronouns as string) ?? '',
  knownAs: (r.known_as as string) ?? '',
  state: r.state as string,
  tierId: (r.tier_id as string) ?? null,
  seeded: !!(r.seeded as number),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export type SheetPatch = Partial<Pick<CharacterSheet, 'isPlayer' | 'description' | 'appearance' | 'pronouns' | 'knownAs' | 'state' | 'tierId' | 'seeded'>>;

export function createSheetStore(db: Db) {
  const store = {
    get(objectId: string): CharacterSheet | undefined {
      const r = db.prepare(`SELECT * FROM character_sheets WHERE object_id = ?`).get<Row>(objectId);
      return r ? rowToSheet(r) : undefined;
    },

    listForStory(storyId: string): CharacterSheet[] {
      return db.prepare(`SELECT * FROM character_sheets WHERE story_id = ? ORDER BY is_player DESC, created_at ASC`).all<Row>(storyId).map(rowToSheet);
    },

    /** Create-or-update; only the given fields change. Setting isPlayer clears it on every other sheet. */
    upsert(storyId: string, objectId: string, patch: SheetPatch = {}): CharacterSheet {
      const now = Date.now();
      const prev = store.get(objectId);
      const next = {
        isPlayer: patch.isPlayer ?? prev?.isPlayer ?? false,
        description: patch.description ?? prev?.description ?? '',
        appearance: patch.appearance ?? prev?.appearance ?? '',
        pronouns: patch.pronouns ?? prev?.pronouns ?? '',
        knownAs: patch.knownAs ?? prev?.knownAs ?? '',
        state: patch.state ?? prev?.state ?? '',
        tierId: patch.tierId !== undefined ? patch.tierId : prev?.tierId ?? null,
        seeded: patch.seeded ?? prev?.seeded ?? false,
      };
      if (patch.isPlayer) db.prepare(`UPDATE character_sheets SET is_player = 0 WHERE story_id = ? AND object_id <> ?`).run(storyId, objectId);
      db.prepare(
        `INSERT INTO character_sheets (object_id, story_id, is_player, description, appearance, pronouns, known_as, state, tier_id, seeded, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_id) DO UPDATE SET is_player = excluded.is_player, description = excluded.description,
           appearance = excluded.appearance, pronouns = excluded.pronouns, known_as = excluded.known_as, state = excluded.state,
           tier_id = excluded.tier_id, seeded = excluded.seeded, updated_at = excluded.updated_at`,
      ).run(objectId, storyId, next.isPlayer ? 1 : 0, next.description, next.appearance, next.pronouns, next.knownAs, next.state, next.tierId, next.seeded ? 1 : 0, prev?.createdAt ?? now, now);
      return store.get(objectId)!;
    },

    player(storyId: string): CharacterSheet | undefined {
      const r = db.prepare(`SELECT * FROM character_sheets WHERE story_id = ? AND is_player = 1`).get<Row>(storyId);
      return r ? rowToSheet(r) : undefined;
    },
  };
  return store;
}
export type SheetStore = ReturnType<typeof createSheetStore>;

// ---- Variables ----

export interface VariableChangeRow {
  id: string;
  turnId: string | null;
  holder: string;
  key: string;
  old: VariableValue | null;
  new: VariableValue | null;
  op: unknown;
  by: string;
  result: string;
  reason: string;
  createdAt: number;
}

const parseJson = <T>(s: unknown): T | null => (s === null || s === undefined ? null : (JSON.parse(s as string) as T));

export function createVariableStore(db: Db) {
  const store = {
    listDefs(storyId: string): VariableDef[] {
      return db
        .prepare(`SELECT def_json FROM variable_defs WHERE story_id = ? ORDER BY sort ASC, key ASC`)
        .all<Row>(storyId)
        .map((r) => VariableDef.parse(JSON.parse(r.def_json as string)));
    },

    /**
     * Replace the scenario's definitions; the list order is the display order.
     * Values of removed keys are dropped. Validate first (validateDefs).
     */
    replaceDefs(storyId: string, defs: VariableDef[]): void {
      const now = Date.now();
      db.transaction(() => {
        db.prepare(`DELETE FROM variable_defs WHERE story_id = ?`).run(storyId);
        defs.forEach((d, i) => {
          db.prepare(`INSERT INTO variable_defs (id, story_id, key, sort, def_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            id(),
            storyId,
            d.key,
            i,
            JSON.stringify({ ...d, order: i }),
            now,
            now,
          );
        });
        const keep = new Set(defs.map((d) => d.key));
        for (const r of db.prepare(`SELECT DISTINCT def_key FROM variable_values WHERE story_id = ?`).all<Row>(storyId)) {
          if (!keep.has(r.def_key as string)) db.prepare(`DELETE FROM variable_values WHERE story_id = ? AND def_key = ?`).run(storyId, r.def_key);
        }
      });
    },

    /** Stored value, or undefined when the holder still has the default. */
    getValue(storyId: string, key: string, holder: string): VariableValue | undefined {
      const r = db.prepare(`SELECT value_json FROM variable_values WHERE story_id = ? AND def_key = ? AND holder = ?`).get<Row>(storyId, key, holder);
      return r ? (JSON.parse(r.value_json as string) as VariableValue) : undefined;
    },

    setValue(storyId: string, key: string, holder: string, value: VariableValue, turnId: string | null): void {
      db.prepare(
        `INSERT INTO variable_values (story_id, def_key, holder, value_json, updated_turn_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(story_id, def_key, holder) DO UPDATE SET value_json = excluded.value_json, updated_turn_id = excluded.updated_turn_id, updated_at = excluded.updated_at`,
      ).run(storyId, key, holder, JSON.stringify(value), turnId, Date.now());
    },

    /** Every stored value of the story: holder → key → value. */
    allValues(storyId: string): Map<string, Map<string, VariableValue>> {
      const out = new Map<string, Map<string, VariableValue>>();
      for (const r of db.prepare(`SELECT def_key, holder, value_json FROM variable_values WHERE story_id = ?`).all<Row>(storyId)) {
        const h = r.holder as string;
        if (!out.has(h)) out.set(h, new Map());
        out.get(h)!.set(r.def_key as string, JSON.parse(r.value_json as string));
      }
      return out;
    },

    logOutcomes(storyId: string, turnId: string | null, outcomes: ChangeOutcome[]): void {
      const now = Date.now();
      for (const o of outcomes) {
        const c = o.proposal.change;
        db.prepare(
          `INSERT INTO variable_changes (id, story_id, turn_id, holder, def_key, old_json, new_json, op_json, by, result, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id(),
          storyId,
          turnId,
          c.holder,
          c.key,
          o.old === undefined ? null : JSON.stringify(o.old),
          o.new === undefined ? null : JSON.stringify(o.new),
          JSON.stringify({ op: c.op, value: c.value ?? null }),
          o.proposal.by,
          o.result,
          o.reason,
          now,
        );
      }
    },

    listChanges(storyId: string, opts: { holder?: string; turnId?: string; limit?: number } = {}): VariableChangeRow[] {
      const where = ['story_id = ?'];
      const params: unknown[] = [storyId];
      if (opts.holder) {
        where.push('holder = ?');
        params.push(opts.holder);
      }
      if (opts.turnId) {
        where.push('turn_id = ?');
        params.push(opts.turnId);
      }
      params.push(opts.limit ?? 200);
      return db
        .prepare(`SELECT * FROM variable_changes WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all<Row>(...params)
        .map((r) => ({
          id: r.id as string,
          turnId: (r.turn_id as string) ?? null,
          holder: r.holder as string,
          key: r.def_key as string,
          old: parseJson<VariableValue>(r.old_json),
          new: parseJson<VariableValue>(r.new_json),
          op: parseJson(r.op_json),
          by: r.by as string,
          result: r.result as string,
          reason: r.reason as string,
          createdAt: r.created_at as number,
        }));
    },
  };
  return store;
}
export type VariableStore = ReturnType<typeof createVariableStore>;

// ---- Thoughts ----

function rowToThought(r: Row, tags: string[]): Thought {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    owner: r.owner as string,
    seq: r.seq as number,
    text: r.text as string,
    tags,
    pinned: !!(r.pinned as number),
    status: r.status as Thought['status'],
    source: r.source as Thought['source'],
    createdTurnId: (r.created_turn_id as string) ?? null,
    createdClockMin: r.created_clock_min == null ? null : Number(r.created_clock_min),
    revokedTurnId: (r.revoked_turn_id as string) ?? null,
    lastRecalledTurnId: (r.last_recalled_turn_id as string) ?? null,
    recallCount: r.recall_count as number,
    createdAt: r.created_at as number,
  };
}

export function createThoughtStore(db: Db) {
  const tagsOf = (thoughtId: string): string[] =>
    db.prepare(`SELECT tag FROM thought_tags WHERE thought_id = ? ORDER BY rowid ASC`).all<Row>(thoughtId).map((r) => r.tag as string);

  const store = {
    get(thoughtId: string): Thought | undefined {
      const r = db.prepare(`SELECT * FROM thoughts WHERE id = ?`).get<Row>(thoughtId);
      return r ? rowToThought(r, tagsOf(r.id as string)) : undefined;
    },

    bySeq(storyId: string, owner: string, seq: number): Thought | undefined {
      const r = db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND owner = ? AND seq = ?`).get<Row>(storyId, owner, seq);
      return r ? rowToThought(r, tagsOf(r.id as string)) : undefined;
    },

    list(storyId: string, owner: string, opts: { includeRevoked?: boolean } = {}): Thought[] {
      const rows = opts.includeRevoked
        ? db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND owner = ? ORDER BY seq ASC`).all<Row>(storyId, owner)
        : db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND owner = ? AND status = 'active' ORDER BY seq ASC`).all<Row>(storyId, owner);
      return rows.map((r) => rowToThought(r, tagsOf(r.id as string)));
    },

    countActive(storyId: string, owner: string): number {
      return db.prepare(`SELECT count(*) AS n FROM thoughts WHERE story_id = ? AND owner = ? AND status = 'active'`).get<{ n: number }>(storyId, owner)!.n;
    },

    insert(storyId: string, owner: string, t: { text: string; tags: string[]; pinned: boolean; source: Thought['source']; clockMin?: number | null }, turnId: string | null): Thought {
      const now = Date.now();
      const tid = id();
      const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM thoughts WHERE story_id = ? AND owner = ?`).get<{ m: number }>(storyId, owner)!.m ?? 0) + 1;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO thoughts (id, story_id, owner, seq, text, pinned, status, source, created_turn_id, created_clock_min, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        ).run(tid, storyId, owner, seq, t.text, t.pinned ? 1 : 0, t.source, turnId, t.clockMin ?? null, now, now);
        for (const tag of t.tags) db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(tid, tag);
      });
      return store.get(tid)!;
    },

    revoke(thoughtId: string, turnId: string | null): void {
      db.prepare(`UPDATE thoughts SET status = 'revoked', revoked_turn_id = ?, updated_at = ? WHERE id = ?`).run(turnId, Date.now(), thoughtId);
    },

    setPinned(thoughtId: string, pinned: boolean): void {
      db.prepare(`UPDATE thoughts SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, Date.now(), thoughtId);
    },

    markRecalled(thoughtIds: string[], turnId: string | null): void {
      for (const tid of thoughtIds) {
        db.prepare(`UPDATE thoughts SET last_recalled_turn_id = ?, recall_count = recall_count + 1 WHERE id = ?`).run(turnId, tid);
      }
    },

    /** The owner's active tags with how many thoughts use each, most used first. */
    vocabulary(storyId: string, owner: string): { tag: string; count: number }[] {
      return db
        .prepare(
          `SELECT tt.tag AS tag, count(*) AS n FROM thought_tags tt JOIN thoughts t ON t.id = tt.thought_id
           WHERE t.story_id = ? AND t.owner = ? AND t.status = 'active' GROUP BY tt.tag ORDER BY n DESC, tt.tag ASC`,
        )
        .all<Row>(storyId, owner)
        .map((r) => ({ tag: r.tag as string, count: r.n as number }));
    },

    /** Point every '#from' tag in the story at '#to' (after merging two roster objects). */
    retag(storyId: string, from: string, to: string): void {
      const rows = db
        .prepare(`SELECT tt.thought_id AS tid FROM thought_tags tt JOIN thoughts t ON t.id = tt.thought_id WHERE t.story_id = ? AND tt.tag = ?`)
        .all<Row>(storyId, `#${from}`);
      for (const r of rows) {
        db.prepare(`DELETE FROM thought_tags WHERE thought_id = ? AND tag = ?`).run(r.tid, `#${from}`);
        db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(r.tid, `#${to}`);
      }
    },
  };
  return store;
}
export type ThoughtStore = ReturnType<typeof createThoughtStore>;

// ---- Names: who knows whom (docs/11 §2.5) ----

export function createNameStore(db: Db) {
  return {
    /** Does `viewer` know `subject`'s name (as recorded)? */
    knows(viewer: string, subject: string): boolean {
      return !!db.prepare(`SELECT 1 FROM name_knowledge WHERE viewer = ? AND subject = ?`).get(viewer, subject);
    },
    /** Every subject whose name `viewer` knows. */
    knownBy(viewer: string): Set<string> {
      return new Set(db.prepare(`SELECT subject FROM name_knowledge WHERE viewer = ?`).all<Row>(viewer).map((r) => r.subject as string));
    },
    /** Record that `viewer` learned `subject`'s name (no-op when already known). Returns true when it was new. */
    learn(storyId: string, viewer: string, subject: string, turnId: string | null): boolean {
      if (viewer === subject) return false;
      const r = db
        .prepare(`INSERT OR IGNORE INTO name_knowledge (story_id, viewer, subject, learned_turn_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(storyId, viewer, subject, turnId, Date.now());
      return Number(r.changes) > 0;
    },
    forget(viewer: string, subject: string): void {
      db.prepare(`DELETE FROM name_knowledge WHERE viewer = ? AND subject = ?`).run(viewer, subject);
    },
    listForStory(storyId: string): { viewer: string; subject: string; learnedTurnId: string | null }[] {
      return db
        .prepare(`SELECT viewer, subject, learned_turn_id FROM name_knowledge WHERE story_id = ? ORDER BY created_at`)
        .all<Row>(storyId)
        .map((r) => ({ viewer: r.viewer as string, subject: r.subject as string, learnedTurnId: (r.learned_turn_id as string) ?? null }));
    },
  };
}
export type NameStore = ReturnType<typeof createNameStore>;
