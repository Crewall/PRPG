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
  /** The narrator's hand-over: who they are, why here (docs/11 §2.3). Canon for the seeder. */
  concept: string;
  /** 3–6 traits as nuanced phrases (docs/11 §2.7). */
  nature: string;
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
  concept: (r.concept as string) ?? '',
  nature: (r.nature as string) ?? '',
  state: r.state as string,
  tierId: (r.tier_id as string) ?? null,
  seeded: !!(r.seeded as number),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

export type SheetPatch = Partial<Pick<CharacterSheet, 'isPlayer' | 'description' | 'appearance' | 'pronouns' | 'knownAs' | 'concept' | 'nature' | 'state' | 'tierId' | 'seeded'>>;

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
        concept: patch.concept ?? prev?.concept ?? '',
        nature: patch.nature ?? prev?.nature ?? '',
        state: patch.state ?? prev?.state ?? '',
        tierId: patch.tierId !== undefined ? patch.tierId : prev?.tierId ?? null,
        seeded: patch.seeded ?? prev?.seeded ?? false,
      };
      if (patch.isPlayer) db.prepare(`UPDATE character_sheets SET is_player = 0 WHERE story_id = ? AND object_id <> ?`).run(storyId, objectId);
      db.prepare(
        `INSERT INTO character_sheets (object_id, story_id, is_player, description, appearance, pronouns, known_as, concept, nature, state, tier_id, seeded, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(object_id) DO UPDATE SET is_player = excluded.is_player, description = excluded.description,
           appearance = excluded.appearance, pronouns = excluded.pronouns, known_as = excluded.known_as, concept = excluded.concept,
           nature = excluded.nature, state = excluded.state, tier_id = excluded.tier_id, seeded = excluded.seeded, updated_at = excluded.updated_at`,
      ).run(objectId, storyId, next.isPlayer ? 1 : 0, next.description, next.appearance, next.pronouns, next.knownAs, next.concept, next.nature, next.state, next.tierId, next.seeded ? 1 : 0, prev?.createdAt ?? now, now);
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
    kind: ((r.kind as string) ?? 'note') as Thought['kind'],
    importance: r.importance == null ? 5 : Number(r.importance),
    about: (r.about as string) ?? null,
    createdTurnId: (r.created_turn_id as string) ?? null,
    createdClockMin: r.created_clock_min == null ? null : Number(r.created_clock_min),
    renewedClockMin: r.renewed_clock_min == null ? (r.created_clock_min == null ? null : Number(r.created_clock_min)) : Number(r.renewed_clock_min),
    revises: (r.revises as string) ?? null,
    renewedTurnIndex: r.renewed_turn_index == null ? null : Number(r.renewed_turn_index),
    confidence: r.confidence == null ? null : Number(r.confidence),
    hope: (r.hope as Thought['hope']) ?? null,
    horizon: (r.horizon as Thought['horizon']) ?? null,
    basis: (r.basis as string) ?? null,
    userEditedAt: r.user_edited_at == null ? null : Number(r.user_edited_at),
    formerText: (r.former_text as string) ?? null,
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

    /** Active thoughts, or (includeRevoked) every thought: forgotten, revised and faded too. */
    list(storyId: string, owner: string, opts: { includeRevoked?: boolean } = {}): Thought[] {
      const rows = opts.includeRevoked
        ? db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND owner = ? ORDER BY seq ASC`).all<Row>(storyId, owner)
        : db.prepare(`SELECT * FROM thoughts WHERE story_id = ? AND owner = ? AND status = 'active' ORDER BY seq ASC`).all<Row>(storyId, owner);
      return rows.map((r) => rowToThought(r, tagsOf(r.id as string)));
    },

    /** Every active thought in the story (all owners), for fading. */
    listActiveForStory(storyId: string): Thought[] {
      return db
        .prepare(`SELECT * FROM thoughts WHERE story_id = ? AND status = 'active' ORDER BY owner, seq ASC`)
        .all<Row>(storyId)
        .map((r) => rowToThought(r, tagsOf(r.id as string)));
    },

    countActive(storyId: string, owner: string): number {
      return db.prepare(`SELECT count(*) AS n FROM thoughts WHERE story_id = ? AND owner = ? AND status = 'active'`).get<{ n: number }>(storyId, owner)!.n;
    },

    insert(
      storyId: string,
      owner: string,
      t: {
        text: string;
        tags: string[];
        pinned: boolean;
        source: Thought['source'];
        clockMin?: number | null;
        kind?: Thought['kind'];
        importance?: number;
        about?: string | null;
        revises?: string | null;
        confidence?: number | null;
        hope?: Thought['hope'];
        horizon?: Thought['horizon'];
        basis?: string | null;
      },
      turnId: string | null,
    ): Thought {
      const now = Date.now();
      const tid = id();
      const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM thoughts WHERE story_id = ? AND owner = ?`).get<{ m: number }>(storyId, owner)!.m ?? 0) + 1;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO thoughts (id, story_id, owner, seq, text, pinned, status, source, created_turn_id, created_clock_min, renewed_clock_min, kind, importance, about, revises,
                                 renewed_turn_index, confidence, hope, horizon, basis, user_edited_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT idx FROM turns WHERE id = ?), (SELECT MAX(idx) FROM turns WHERE story_id = ?)), ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tid, storyId, owner, seq, t.text, t.pinned ? 1 : 0, t.source, turnId, t.clockMin ?? null, t.clockMin ?? null, t.kind ?? 'note', t.importance ?? 5, t.about ?? null, t.revises ?? null,
          turnId, storyId, t.confidence ?? null, t.hope ?? null, t.horizon ?? null, t.basis ?? null, t.source === 'user' ? now : null, now, now);
        for (const tag of t.tags) db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(tid, tag);
      });
      return store.get(tid)!;
    },

    /** Changed by hand just now (docs/11 §5.10c): always later than any earlier mark, so a rewind can tell. */
    markHandEdited(thoughtId: string): void {
      db.prepare(`UPDATE thoughts SET user_edited_at = MAX(COALESCE(user_edited_at, 0) + 1, ?) WHERE id = ?`).run(Date.now(), thoughtId);
    },

    revoke(thoughtId: string, turnId: string | null): void {
      db.prepare(`UPDATE thoughts SET status = 'revoked', revoked_turn_id = ?, status_turn_id = ?, updated_at = ? WHERE id = ?`).run(turnId, turnId, Date.now(), thoughtId);
    },

    /** Set a thought's status (revised, faded, or back to active). */
    setStatus(thoughtId: string, status: Thought['status'], turnId: string | null): void {
      db.prepare(`UPDATE thoughts SET status = ?, status_turn_id = ?, updated_at = ? WHERE id = ?`).run(status, turnId, Date.now(), thoughtId);
    },

    /** Edit a thought in place (the user, in advanced mode). */
    update(
      thoughtId: string,
      patch: { text?: string; kind?: Thought['kind']; importance?: number; about?: string | null; tags?: string[]; confidence?: number | null; hope?: Thought['hope']; horizon?: Thought['horizon'] },
    ): void {
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      // The old wording is kept when the text changes (SET reads the row as it was before the update).
      if (patch.text !== undefined) (sets.push('former_text = CASE WHEN text <> ? THEN text ELSE former_text END, text = ?'), args.push(patch.text, patch.text));
      if (patch.confidence !== undefined) (sets.push('confidence = ?'), args.push(patch.confidence));
      if (patch.hope !== undefined) (sets.push('hope = ?'), args.push(patch.hope));
      if (patch.horizon !== undefined) (sets.push('horizon = ?'), args.push(patch.horizon));
      if (patch.kind !== undefined) (sets.push('kind = ?'), args.push(patch.kind));
      if (patch.importance !== undefined) (sets.push('importance = ?'), args.push(patch.importance));
      if (patch.about !== undefined) (sets.push('about = ?'), args.push(patch.about));
      db.transaction(() => {
        if (sets.length) db.prepare(`UPDATE thoughts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), thoughtId);
        if (patch.tags) {
          db.prepare(`DELETE FROM thought_tags WHERE thought_id = ?`).run(thoughtId);
          for (const tag of patch.tags) db.prepare(`INSERT OR IGNORE INTO thought_tags (thought_id, tag) VALUES (?, ?)`).run(thoughtId, tag);
        }
      });
    },

    /** It came up again: fading starts over from now, the story's in-story time and round (docs/11 §5.7). */
    renew(thoughtIds: string[], clockMin?: number | null): void {
      for (const tid of thoughtIds) {
        db.prepare(
          `UPDATE thoughts SET renewed_clock_min = COALESCE(?, (SELECT clock_min FROM stories WHERE stories.id = thoughts.story_id)),
             renewed_turn_index = COALESCE((SELECT MAX(idx) FROM turns WHERE turns.story_id = thoughts.story_id), renewed_turn_index) WHERE id = ?`,
        ).run(clockMin ?? null, tid);
      }
    },

    setPinned(thoughtId: string, pinned: boolean): void {
      db.prepare(`UPDATE thoughts SET pinned = ?, updated_at = ? WHERE id = ?`).run(pinned ? 1 : 0, Date.now(), thoughtId);
    },

    /** Shown to its owner this round. (Being shown doesn't renew it: only something happening does, docs/11 §5.7.) */
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

// ---- Ties: how one character relates to another (docs/11 §2.6) ----

export interface Tie {
  holder: string;
  other: string;
  /** What `other` is to `holder` ("older sibling"). */
  label: string;
  createdTurnId: string | null;
}

export function createTieStore(db: Db) {
  const toTie = (r: Row): Tie => ({ holder: r.holder as string, other: r.other as string, label: r.label as string, createdTurnId: (r.created_turn_id as string) ?? null });
  return {
    /** Set (or replace) what `other` is to `holder`. */
    set(storyId: string, holder: string, other: string, label: string, turnId: string | null): void {
      db.prepare(
        `INSERT INTO character_ties (story_id, holder, other, label, created_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(holder, other) DO UPDATE SET label = excluded.label`,
      ).run(storyId, holder, other, label, turnId, Date.now());
    },
    remove(holder: string, other: string): void {
      db.prepare(`DELETE FROM character_ties WHERE holder = ? AND other = ?`).run(holder, other);
    },
    /** The holder's ties, in the order they were made. */
    of(holder: string): Tie[] {
      return db.prepare(`SELECT * FROM character_ties WHERE holder = ? ORDER BY created_at, other`).all<Row>(holder).map(toTie);
    },
    listForStory(storyId: string): Tie[] {
      return db.prepare(`SELECT * FROM character_ties WHERE story_id = ? ORDER BY created_at, holder, other`).all<Row>(storyId).map(toTie);
    },
  };
}
export type TieStore = ReturnType<typeof createTieStore>;

// ---- Who has met whom (docs/11 §4.9) ----

export function createMetStore(db: Db) {
  const order = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
  return {
    /** Record that everyone in `ids` has met everyone else (pairs already known are kept). */
    meetAll(storyId: string, ids: string[], turnId: string | null): number {
      const uniq = [...new Set(ids)];
      let n = 0;
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const [a, b] = order(uniq[i], uniq[j]);
          const r = db.prepare(`INSERT OR IGNORE INTO character_met (story_id, a, b, first_turn_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(storyId, a, b, turnId, Date.now());
          n += Number(r.changes);
        }
      }
      return n;
    },
    met(x: string, y: string): boolean {
      const [a, b] = order(x, y);
      return !!db.prepare(`SELECT 1 FROM character_met WHERE a = ? AND b = ?`).get(a, b);
    },
    pairs(storyId: string): [string, string][] {
      return db.prepare(`SELECT a, b FROM character_met WHERE story_id = ? ORDER BY created_at`).all<Row>(storyId).map((r) => [r.a as string, r.b as string]);
    },
  };
}
export type MetStore = ReturnType<typeof createMetStore>;
