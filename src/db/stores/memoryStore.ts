import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';
import { estimateTokens } from '../../util/tokens.ts';
import { discloseFact } from '../../memory/knowledge.ts';
import { tierRank, tierWithin } from '../../memory/model.ts';
import type { FactTier, KnowledgeScope, KnowledgeLink, Knower, MemoryFact, MemoryObject, NewFact, NewMemoryObject, ObjectView } from '../../memory/model.ts';

const DEFAULT_MAX_FACTS = 30; // facts per object per view (doc 05 budget)

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
}

function rowToObject(r: Row): MemoryObject {
  return {
    id: r.id as string,
    storyId: r.story_id as string,
    type: r.type as MemoryObject['type'],
    name: r.name as string,
    aliases: JSON.parse((r.aliases_json as string) || '[]'),
    summary: r.summary as string,
    salience: r.salience as number,
    status: r.status as MemoryObject['status'],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToFact(r: Row): MemoryFact {
  return {
    id: r.id as string,
    objectId: r.object_id as string,
    category: r.category as string,
    subcategory: (r.subcategory as string) ?? null,
    detailLevel: r.detail_level as MemoryFact['detailLevel'],
    tier: ((r.tier as string) || 'mid') as FactTier,
    content: r.content as string,
    sourceTurnId: (r.source_turn_id as string) ?? null,
    supersedesId: (r.supersedes_id as string) ?? null,
    superseded: !!(r.superseded as number),
    confidence: r.confidence as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToLink(r: Row): KnowledgeLink {
  return {
    id: r.id as string,
    factId: r.fact_id as string,
    knowerType: r.knower_type as 'player' | 'npc',
    knowerNpcObjectId: (r.knower_npc_object_id as string) ?? null,
    learnedTurnId: (r.learned_turn_id as string) ?? null,
    distortion: (r.distortion as string) ?? null,
  };
}

export function createMemoryStore(db: Db) {
  const store = {
    // ---- Objects ----
    createObject(o: NewMemoryObject): MemoryObject {
      const now = Date.now();
      const oid = id();
      db.prepare(
        `INSERT INTO memory_objects (id, story_id, type, name, aliases_json, summary, salience, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(oid, o.storyId, o.type, o.name, JSON.stringify(o.aliases ?? []), o.summary ?? '', o.salience ?? 0.5, o.status ?? 'active', now, now);
      return store.getObject(oid)!;
    },

    getObject(objectId: string): MemoryObject | undefined {
      const r = db.prepare(`SELECT * FROM memory_objects WHERE id = ?`).get<Row>(objectId);
      return r ? rowToObject(r) : undefined;
    },

    listObjects(storyId: string, opts: { type?: string } = {}): MemoryObject[] {
      const rows = opts.type
        ? db.prepare(`SELECT * FROM memory_objects WHERE story_id = ? AND type = ? ORDER BY salience DESC, name ASC`).all<Row>(storyId, opts.type)
        : db.prepare(`SELECT * FROM memory_objects WHERE story_id = ? ORDER BY salience DESC, name ASC`).all<Row>(storyId);
      return rows.map(rowToObject);
    },

    updateObject(objectId: string, patch: Partial<Pick<MemoryObject, 'name' | 'aliases' | 'summary' | 'salience' | 'status'>>): MemoryObject | undefined {
      const existing = store.getObject(objectId);
      if (!existing) return undefined;
      db.prepare(`UPDATE memory_objects SET name = ?, aliases_json = ?, summary = ?, salience = ?, status = ?, updated_at = ? WHERE id = ?`).run(
        patch.name ?? existing.name,
        JSON.stringify(patch.aliases ?? existing.aliases),
        patch.summary ?? existing.summary,
        Math.max(0, Math.min(1, patch.salience ?? existing.salience)),
        patch.status ?? existing.status,
        Date.now(),
        objectId,
      );
      return store.getObject(objectId);
    },

    deleteObject(objectId: string): void {
      db.prepare(`DELETE FROM memory_objects WHERE id = ?`).run(objectId);
    },

    /** Exact/normalized name-or-alias match within a story (for alias auto-merge). */
    findByName(storyId: string, name: string): MemoryObject | undefined {
      const target = normalizeName(name);
      for (const obj of store.listObjects(storyId)) {
        if (normalizeName(obj.name) === target) return obj;
        if (obj.aliases.some((a) => normalizeName(a) === target)) return obj;
      }
      return undefined;
    },

    // ---- Facts ----
    addFact(f: NewFact): MemoryFact {
      const now = Date.now();
      const fid = id();
      db.prepare(
        `INSERT INTO memory_facts (id, object_id, category, subcategory, detail_level, tier, content, source_turn_id, supersedes_id, superseded, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(fid, f.objectId, f.category, f.subcategory ?? null, f.detailLevel, f.tier ?? 'mid', f.content, f.sourceTurnId ?? null, f.supersedesId ?? null, f.confidence ?? 1, now, now);
      db.prepare(`UPDATE memory_objects SET updated_at = ? WHERE id = ?`).run(now, f.objectId);
      return store.getFact(fid)!;
    },

    getFact(factId: string): MemoryFact | undefined {
      const r = db.prepare(`SELECT * FROM memory_facts WHERE id = ?`).get<Row>(factId);
      return r ? rowToFact(r) : undefined;
    },

    listFacts(objectId: string, opts: { includeSuperseded?: boolean } = {}): MemoryFact[] {
      const rows = opts.includeSuperseded
        ? db.prepare(`SELECT * FROM memory_facts WHERE object_id = ? ORDER BY created_at ASC`).all<Row>(objectId)
        : db.prepare(`SELECT * FROM memory_facts WHERE object_id = ? AND superseded = 0 ORDER BY created_at ASC`).all<Row>(objectId);
      return rows.map(rowToFact);
    },

    updateFact(factId: string, patch: Partial<Pick<MemoryFact, 'category' | 'subcategory' | 'detailLevel' | 'tier' | 'content' | 'confidence' | 'superseded'>>): MemoryFact | undefined {
      const existing = store.getFact(factId);
      if (!existing) return undefined;
      db.prepare(`UPDATE memory_facts SET category = ?, subcategory = ?, detail_level = ?, tier = ?, content = ?, confidence = ?, superseded = ?, updated_at = ? WHERE id = ?`).run(
        patch.category ?? existing.category,
        patch.subcategory ?? existing.subcategory,
        patch.detailLevel ?? existing.detailLevel,
        patch.tier ?? existing.tier,
        patch.content ?? existing.content,
        patch.confidence ?? existing.confidence,
        patch.superseded !== undefined ? (patch.superseded ? 1 : 0) : existing.superseded ? 1 : 0,
        Date.now(),
        factId,
      );
      return store.getFact(factId);
    },

    /** Flag oldId superseded (kept for history) and insert the replacement. */
    supersedeFact(oldId: string, f: NewFact): MemoryFact {
      return db.transaction(() => {
        db.prepare(`UPDATE memory_facts SET superseded = 1, updated_at = ? WHERE id = ?`).run(Date.now(), oldId);
        return store.addFact({ ...f, supersedesId: oldId });
      });
    },

    // ---- Knowledge links ----
    linkKnowledge(factId: string, knower: Knower, opts: { learnedTurnId?: string; distortion?: string } = {}): KnowledgeLink {
      // Dedupe by (fact, knower).
      const existing = db
        .prepare(`SELECT * FROM knowledge_links WHERE fact_id = ? AND knower_type = ? AND IFNULL(knower_npc_object_id,'') = ?`)
        .get<Row>(factId, knower.type, knower.npcObjectId ?? '');
      const now = Date.now();
      if (existing) {
        if (opts.distortion !== undefined) {
          db.prepare(`UPDATE knowledge_links SET distortion = ?, updated_at = ? WHERE id = ?`).run(opts.distortion, now, existing.id as string);
        }
        return rowToLink(db.prepare(`SELECT * FROM knowledge_links WHERE id = ?`).get<Row>(existing.id as string)!);
      }
      const lid = id();
      db.prepare(
        `INSERT INTO knowledge_links (id, fact_id, knower_type, knower_npc_object_id, learned_turn_id, distortion, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(lid, factId, knower.type, knower.npcObjectId ?? null, opts.learnedTurnId ?? null, opts.distortion ?? null, now, now);
      return rowToLink(db.prepare(`SELECT * FROM knowledge_links WHERE id = ?`).get<Row>(lid)!);
    },

    unlinkKnowledge(factId: string, knower: Knower): void {
      db.prepare(`DELETE FROM knowledge_links WHERE fact_id = ? AND knower_type = ? AND IFNULL(knower_npc_object_id,'') = ?`).run(
        factId,
        knower.type,
        knower.npcObjectId ?? '',
      );
    },

    linksForFacts(factIds: string[]): Map<string, KnowledgeLink[]> {
      const map = new Map<string, KnowledgeLink[]>();
      if (factIds.length === 0) return map;
      const placeholders = factIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM knowledge_links WHERE fact_id IN (${placeholders})`).all<Row>(...factIds);
      for (const r of rows) {
        const link = rowToLink(r);
        const list = map.get(link.factId) ?? [];
        list.push(link);
        map.set(link.factId, list);
      }
      return map;
    },

    // ---- The scoped view: the single choke point for detail-level filtering ----
    getObjectView(objectId: string, scope: KnowledgeScope, opts: { categories?: string[]; maxTokens?: number; maxFacts?: number; maxTier?: FactTier } = {}): ObjectView | undefined {
      const obj = store.getObject(objectId);
      if (!obj) return undefined;

      const facts = store.listFacts(objectId);
      const links = store.linksForFacts(facts.map((f) => f.id));

      let disclosed = facts
        .map((f) => {
          const disc = discloseFact(f, links.get(f.id) ?? [], scope);
          if (!disc.visible) return null;
          if (opts.categories && !opts.categories.includes(f.category)) return null;
          if (opts.maxTier && !tierWithin(f.tier, opts.maxTier)) return null;
          return {
            id: f.id,
            category: f.category,
            subcategory: f.subcategory ?? undefined,
            content: disc.distortion ?? f.content,
            detailLevel: f.detailLevel,
            tier: f.tier,
            confidence: f.confidence,
            updatedAt: f.updatedAt,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Rank (tier — major first, then confidence, then recency) and cap facts per view.
      disclosed.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || b.confidence - a.confidence || b.updatedAt - a.updatedAt);
      const maxFacts = opts.maxFacts ?? DEFAULT_MAX_FACTS;
      disclosed = disclosed.slice(0, maxFacts);

      // Token budget.
      if (opts.maxTokens) {
        let used = estimateTokens(obj.summary);
        const kept: typeof disclosed = [];
        for (const f of disclosed) {
          const cost = estimateTokens(f.content) + 6;
          if (used + cost > opts.maxTokens && kept.length) break;
          used += cost;
          kept.push(f);
        }
        disclosed = kept;
      }

      return {
        id: obj.id,
        type: obj.type,
        name: obj.name,
        aliases: obj.aliases,
        summary: obj.summary,
        facts: disclosed.map((f) => ({ id: f.id, category: f.category, subcategory: f.subcategory, content: f.content, detailLevel: f.detailLevel, tier: f.tier })),
      };
    },

    /**
     * All live facts in a category across a story (e.g. 'goals' for the
     * summary-driven context's "current goals" block). Storyteller scope —
     * callers that need player/NPC scoping should go through views instead.
     */
    factsByCategory(storyId: string, categories: string[]): { objectId: string; objectName: string; fact: MemoryFact }[] {
      if (categories.length === 0) return [];
      const placeholders = categories.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT mf.*, mo.name AS obj_name
           FROM memory_facts mf JOIN memory_objects mo ON mo.id = mf.object_id
           WHERE mo.story_id = ? AND mf.category IN (${placeholders}) AND mf.superseded = 0
           ORDER BY mo.salience DESC, mf.updated_at DESC`,
        )
        .all<Row>(storyId, ...categories);
      return rows.map((r) => ({ objectId: r.object_id as string, objectName: r.obj_name as string, fact: rowToFact(r) }));
    },

    /**
     * Everything a given NPC knows about the *world* — facts on any object that
     * are linked to this NPC via knowledge_links (distortions substituted). This
     * is the cross-object knowledge that getObjectView(self) does not cover, and
     * it is the other half of the NPC persona (doc 04).
     */
    npcKnowledge(storyId: string, npcObjectId: string): { objectId: string; objectName: string; fact: MemoryFact; content: string }[] {
      const rows = db
        .prepare(
          `SELECT mf.*, kl.distortion AS kl_distortion, mo.name AS obj_name, mo.id AS obj_id
           FROM knowledge_links kl
           JOIN memory_facts mf ON mf.id = kl.fact_id
           JOIN memory_objects mo ON mo.id = mf.object_id
           WHERE kl.knower_type = 'npc' AND kl.knower_npc_object_id = ? AND mo.story_id = ? AND mf.superseded = 0`,
        )
        .all<Row>(npcObjectId, storyId);
      return rows.map((r) => ({
        objectId: r.obj_id as string,
        objectName: r.obj_name as string,
        fact: rowToFact(r),
        content: (r.kl_distortion as string) ?? (r.content as string),
      }));
    },

    // ---- FTS (used by retrieval.ts) ----
    ftsSearch(storyId: string, query: string, limit = 40): { factId: string; objectId: string; rank: number }[] {
      const cleaned = query.replace(/["*]/g, ' ').trim();
      if (!cleaned) return [];
      // OR the terms so partial matches still hit; rank by bm25 (lower is better).
      const terms = cleaned.split(/\s+/).filter((t) => t.length > 1);
      if (terms.length === 0) return [];
      const match = terms.map((t) => `"${t}"`).join(' OR ');
      try {
        const rows = db
          .prepare(
            `SELECT f.fact_id AS factId, f.object_id AS objectId, bm25(memory_fts) AS rank
             FROM memory_fts f
             JOIN memory_facts mf ON mf.id = f.fact_id
             JOIN memory_objects mo ON mo.id = mf.object_id
             WHERE memory_fts MATCH ? AND mo.story_id = ? AND mf.superseded = 0
             ORDER BY rank ASC LIMIT ?`,
          )
          .all<{ factId: string; objectId: string; rank: number }>(match, storyId, limit);
        return rows;
      } catch {
        return [];
      }
    },
  };

  return store;
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
export { normalizeName };
