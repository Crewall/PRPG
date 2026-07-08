import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';
import { StorySettings, defaultStorySettings } from '../../domain.ts';
import { CLOCK_START_MIN, MAX_ADVANCE_MINUTES } from '../../util/gameClock.ts';
import type { Scene, Story, Turn, TurnStatus } from '../../domain.ts';

export interface NewStory {
  title: string;
  settings?: Partial<StorySettings>;
}

export interface NewTurn {
  storyId: string;
  sceneId?: string | null;
  playerInput: string;
  status?: TurnStatus;
}

export interface SceneSeed {
  title?: string;
  locationObjectId?: string | null;
  activeNpcIds?: string[];
}

function rowToStory(r: Row): Story {
  return {
    id: r.id as string,
    title: r.title as string,
    settings: StorySettings.parse(JSON.parse(r.settings_json as string)),
    currentSceneId: (r.current_scene_id as string) ?? null,
    clockMin: (r.clock_min as number) ?? CLOCK_START_MIN,
    status: r.status as Story['status'],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToTurn(r: Row): Turn {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    sceneId: (r.scene_id as string) ?? null,
    index: r.idx as number,
    playerInput: r.player_input as string,
    narration: r.narration as string,
    status: r.status as TurnStatus,
    meta: JSON.parse((r.meta_json as string) || '{}'),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToScene(r: Row): Scene {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    index: r.idx as number,
    title: (r.title as string) ?? null,
    locationObjectId: (r.location_object_id as string) ?? null,
    activeNpcIds: JSON.parse((r.active_npc_ids as string) || '[]'),
    status: r.status as Scene['status'],
  };
}

export function createStoryStore(db: Db) {
  return {
    createStory(input: NewStory): Story {
      const now = Date.now();
      const storyId = id();
      const settings = StorySettings.parse({ ...defaultStorySettings(), ...(input.settings ?? {}) });
      db.transaction(() => {
        db.prepare(
          `INSERT INTO stories (id, title, settings_json, current_scene_id, status, created_at, updated_at)
           VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
        ).run(storyId, input.title, JSON.stringify(settings), now, now);
        // Every story opens with a first scene (scene lifecycle proper comes in Layer 2+).
        const sceneId = id();
        db.prepare(
          `INSERT INTO scenes (id, story_id, idx, title, active_npc_ids, status, created_at, updated_at)
           VALUES (?, ?, 0, ?, '[]', 'open', ?, ?)`,
        ).run(sceneId, storyId, 'Scene 1', now, now);
        db.prepare(`UPDATE stories SET current_scene_id = ? WHERE id = ?`).run(sceneId, storyId);
      });
      return this.getStory(storyId)!;
    },

    getStory(storyId: string): Story | undefined {
      const r = db.prepare(`SELECT * FROM stories WHERE id = ?`).get<Row>(storyId);
      return r ? rowToStory(r) : undefined;
    },

    listStories(includeArchived = false): Story[] {
      const rows = includeArchived
        ? db.prepare(`SELECT * FROM stories ORDER BY updated_at DESC`).all<Row>()
        : db.prepare(`SELECT * FROM stories WHERE status = 'active' ORDER BY updated_at DESC`).all<Row>();
      return rows.map(rowToStory);
    },

    updateStory(storyId: string, patch: { title?: string; settings?: Partial<StorySettings>; status?: Story['status'] }): Story | undefined {
      const existing = this.getStory(storyId);
      if (!existing) return undefined;
      const settings = patch.settings ? StorySettings.parse({ ...existing.settings, ...patch.settings }) : existing.settings;
      db.prepare(`UPDATE stories SET title = ?, settings_json = ?, status = ?, updated_at = ? WHERE id = ?`).run(
        patch.title ?? existing.title,
        JSON.stringify(settings),
        patch.status ?? existing.status,
        Date.now(),
        storyId,
      );
      return this.getStory(storyId);
    },

    deleteStory(storyId: string, hard = false): void {
      if (hard) {
        db.prepare(`DELETE FROM stories WHERE id = ?`).run(storyId);
      } else {
        db.prepare(`UPDATE stories SET status = 'archived', updated_at = ? WHERE id = ?`).run(Date.now(), storyId);
      }
    },

    /** Advance the hidden in-game clock; returns the new clock (minutes). */
    advanceClock(storyId: string, minutes: number): number {
      const story = this.getStory(storyId);
      if (!story) return 0;
      const next = story.clockMin + Math.max(0, Math.min(MAX_ADVANCE_MINUTES, Math.floor(minutes)));
      db.prepare(`UPDATE stories SET clock_min = ?, updated_at = ? WHERE id = ?`).run(next, Date.now(), storyId);
      return next;
    },

    nextTurnIndex(storyId: string): number {
      const r = db.prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM turns WHERE story_id = ?`).get<{ m: number }>(storyId);
      return (r?.m ?? -1) + 1;
    },

    appendTurn(t: NewTurn): Turn {
      const now = Date.now();
      const turnId = id();
      const story = this.getStory(t.storyId);
      const sceneId = t.sceneId ?? story?.currentSceneId ?? null;
      const idx = this.nextTurnIndex(t.storyId);
      db.prepare(
        `INSERT INTO turns (id, story_id, scene_id, idx, player_input, narration, status, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, '{}', ?, ?)`,
      ).run(turnId, t.storyId, sceneId, idx, t.playerInput, t.status ?? 'streaming', now, now);
      db.prepare(`UPDATE stories SET updated_at = ? WHERE id = ?`).run(now, t.storyId);
      return this.getTurn(turnId)!;
    },

    getTurn(turnId: string): Turn | undefined {
      const r = db.prepare(`SELECT * FROM turns WHERE id = ?`).get<Row>(turnId);
      return r ? rowToTurn(r) : undefined;
    },

    updateTurn(turnId: string, patch: { narration?: string; status?: TurnStatus; meta?: Record<string, unknown> }): void {
      const existing = this.getTurn(turnId);
      if (!existing) return;
      const meta = patch.meta ? { ...existing.meta, ...patch.meta } : existing.meta;
      db.prepare(`UPDATE turns SET narration = ?, status = ?, meta_json = ?, updated_at = ? WHERE id = ?`).run(
        patch.narration ?? existing.narration,
        patch.status ?? existing.status,
        JSON.stringify(meta),
        Date.now(),
        turnId,
      );
    },

    listTurns(storyId: string, opts: { fromIndex?: number; limit?: number } = {}): Turn[] {
      const from = opts.fromIndex ?? 0;
      const limit = opts.limit ?? 200;
      return db
        .prepare(`SELECT * FROM turns WHERE story_id = ? AND idx >= ? ORDER BY idx ASC LIMIT ?`)
        .all<Row>(storyId, from, limit)
        .map(rowToTurn);
    },

    lastTurn(storyId: string): Turn | undefined {
      const r = db.prepare(`SELECT * FROM turns WHERE story_id = ? ORDER BY idx DESC LIMIT 1`).get<Row>(storyId);
      return r ? rowToTurn(r) : undefined;
    },

    deleteTurn(turnId: string): void {
      db.prepare(`DELETE FROM turns WHERE id = ?`).run(turnId);
    },

    recentTurns(storyId: string, k: number): Turn[] {
      // Last K completed/streaming turns in chronological order.
      const rows = db
        .prepare(`SELECT * FROM turns WHERE story_id = ? ORDER BY idx DESC LIMIT ?`)
        .all<Row>(storyId, k)
        .map(rowToTurn);
      return rows.reverse();
    },

    getScene(sceneId: string): Scene | undefined {
      const r = db.prepare(`SELECT * FROM scenes WHERE id = ?`).get<Row>(sceneId);
      return r ? rowToScene(r) : undefined;
    },

    openScene(storyId: string, seed: SceneSeed = {}): Scene {
      const now = Date.now();
      const sceneId = id();
      const idxRow = db.prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM scenes WHERE story_id = ?`).get<{ m: number }>(storyId);
      const idx = (idxRow?.m ?? -1) + 1;
      db.transaction(() => {
        db.prepare(
          `INSERT INTO scenes (id, story_id, idx, title, location_object_id, active_npc_ids, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        ).run(sceneId, storyId, idx, seed.title ?? `Scene ${idx + 1}`, seed.locationObjectId ?? null, JSON.stringify(seed.activeNpcIds ?? []), now, now);
        db.prepare(`UPDATE stories SET current_scene_id = ?, updated_at = ? WHERE id = ?`).run(sceneId, now, storyId);
      });
      return this.getScene(sceneId)!;
    },

    closeScene(sceneId: string): void {
      db.prepare(`UPDATE scenes SET status = 'closed', updated_at = ? WHERE id = ?`).run(Date.now(), sceneId);
    },

    setActiveNpcs(sceneId: string, npcIds: string[]): void {
      db.prepare(`UPDATE scenes SET active_npc_ids = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(Array.from(new Set(npcIds))), Date.now(), sceneId);
    },

    addActiveNpc(sceneId: string, npcObjectId: string): void {
      const scene = this.getScene(sceneId);
      if (!scene) return;
      if (scene.activeNpcIds.includes(npcObjectId)) return;
      this.setActiveNpcs(sceneId, [...scene.activeNpcIds, npcObjectId]);
    },

    removeActiveNpc(sceneId: string, npcObjectId: string): void {
      const scene = this.getScene(sceneId);
      if (!scene) return;
      this.setActiveNpcs(sceneId, scene.activeNpcIds.filter((n) => n !== npcObjectId));
    },
  };
}

export type StoryStore = ReturnType<typeof createStoryStore>;
