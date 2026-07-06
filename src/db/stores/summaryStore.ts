import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';

export interface StorySummary {
  id: string;
  storyId: string;
  scope: 'scene' | 'story';
  sceneId: string | null;
  content: string;
  coversToTurnIndex: number;
  updatedAt: number;
}

function rowToSummary(r: Row): StorySummary {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    scope: r.scope as 'scene' | 'story',
    sceneId: (r.scene_id as string) ?? null,
    content: r.content as string,
    coversToTurnIndex: r.covers_to_turn_index as number,
    updatedAt: r.updated_at as number,
  };
}

// story_summaries: one rolling 'story' digest per story, and one 'scene' summary
// per scene. Upserts are keyed by (story, scope, scene) so scribe jobs overwrite
// rather than append (04-agents.md: "it rewrites the summary, it does not append").
export function createSummaryStore(db: Db) {
  return {
    getStoryDigest(storyId: string): StorySummary | undefined {
      const r = db.prepare(`SELECT * FROM story_summaries WHERE story_id = ? AND scope = 'story'`).get<Row>(storyId);
      return r ? rowToSummary(r) : undefined;
    },

    getSceneSummary(sceneId: string): StorySummary | undefined {
      const r = db.prepare(`SELECT * FROM story_summaries WHERE scope = 'scene' AND scene_id = ?`).get<Row>(sceneId);
      return r ? rowToSummary(r) : undefined;
    },

    upsertStoryDigest(storyId: string, content: string, coversToTurnIndex: number): StorySummary {
      const existing = this.getStoryDigest(storyId);
      const now = Date.now();
      if (existing) {
        db.prepare(`UPDATE story_summaries SET content = ?, covers_to_turn_index = ?, updated_at = ? WHERE id = ?`).run(
          content,
          coversToTurnIndex,
          now,
          existing.id,
        );
        return this.getStoryDigest(storyId)!;
      }
      const sid = id();
      db.prepare(
        `INSERT INTO story_summaries (id, story_id, scope, scene_id, content, covers_to_turn_index, created_at, updated_at)
         VALUES (?, ?, 'story', NULL, ?, ?, ?, ?)`,
      ).run(sid, storyId, content, coversToTurnIndex, now, now);
      return this.getStoryDigest(storyId)!;
    },

    upsertSceneSummary(storyId: string, sceneId: string, content: string, coversToTurnIndex: number): StorySummary {
      const existing = this.getSceneSummary(sceneId);
      const now = Date.now();
      if (existing) {
        db.prepare(`UPDATE story_summaries SET content = ?, covers_to_turn_index = ?, updated_at = ? WHERE id = ?`).run(
          content,
          coversToTurnIndex,
          now,
          existing.id,
        );
        return this.getSceneSummary(sceneId)!;
      }
      const sid = id();
      db.prepare(
        `INSERT INTO story_summaries (id, story_id, scope, scene_id, content, covers_to_turn_index, created_at, updated_at)
         VALUES (?, ?, 'scene', ?, ?, ?, ?, ?)`,
      ).run(sid, storyId, sceneId, content, coversToTurnIndex, now, now);
      return this.getSceneSummary(sceneId)!;
    },

    listForStory(storyId: string): StorySummary[] {
      return db.prepare(`SELECT * FROM story_summaries WHERE story_id = ? ORDER BY scope, updated_at DESC`).all<Row>(storyId).map(rowToSummary);
    },
  };
}

export type SummaryStore = ReturnType<typeof createSummaryStore>;
