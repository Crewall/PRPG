import type { MemoryStore } from '../db/stores/memoryStore.ts';
import { normalizeName } from '../db/stores/memoryStore.ts';
import { discloseFact } from './knowledge.ts';
import { renderObjectView, tierWithin } from './model.ts';
import type { FactTier, KnowledgeScope, ObjectView } from './model.ts';
import { estimateTokens } from '../util/tokens.ts';

export interface RankedFact {
  factId: string;
  objectId: string;
  objectName: string;
  category: string;
  content: string;
  tier: FactTier;
  score: number;
}

export interface RetrievalResult {
  entities: ObjectView[]; // whole views of objects named in the query
  facts: RankedFact[]; // additional FTS hits, scope-filtered
}

export interface RetrievalOpts {
  maxTokens?: number; // total budget for the retrieved block
  perObjectTokens?: number; // budget for each entity view
  scoreWeights?: { bm25: number; salience: number; recency: number };
  /** Deepest tier to include: 'major' → majors only; 'mid' → major+mid; 'minor' → all. */
  maxTier?: FactTier;
}

// Weights for the lexical score (doc 05): bm25·w1 + salience·w2 + recency·w3.
const DEFAULT_WEIGHTS = { bm25: 1.0, salience: 0.6, recency: 0.4 };

// Tier bonus on top of the lexical score — conspicuous facts surface first.
const TIER_BONUS: Record<FactTier, number> = { major: 0.3, mid: 0.15, minor: 0 };

/**
 * searchFacts (doc 05): find the facts an agent needs for the turn about to be
 * generated. Entity pass (named objects → whole scoped views), then FTS pass
 * (remaining terms → candidate facts), scope-filtered and scored, within budget.
 * No embeddings — ranked lexical retrieval, phone-cheap.
 */
export function searchFacts(memory: MemoryStore, storyId: string, scope: KnowledgeScope, queryText: string, opts: RetrievalOpts = {}): RetrievalResult {
  const maxTokens = opts.maxTokens ?? 1500;
  const perObjectTokens = opts.perObjectTokens ?? 400;
  const weights = opts.scoreWeights ?? DEFAULT_WEIGHTS;
  const normQuery = ` ${normalizeName(queryText)} `;

  // --- 1. Entity pass: objects whose name/alias appears in the query. ---
  const entities: ObjectView[] = [];
  const entityIds = new Set<string>();
  const objects = memory.listObjects(storyId);
  for (const obj of objects) {
    const names = [obj.name, ...obj.aliases].map(normalizeName).filter((n) => n.length > 1);
    const hit = names.some((n) => normQuery.includes(` ${n} `));
    if (hit) {
      const view = memory.getObjectView(obj.id, scope, { maxTokens: perObjectTokens, maxTier: opts.maxTier });
      if (view && (view.facts.length > 0 || view.summary)) {
        entities.push(view);
        entityIds.add(obj.id);
      }
    }
  }

  // --- 2. FTS pass over remaining terms. ---
  const now = Date.now();
  const ftsHits = memory.ftsSearch(storyId, queryText, 60);
  const ranked: RankedFact[] = [];
  const objById = new Map(objects.map((o) => [o.id, o]));
  const worstBm25 = ftsHits.reduce((m, h) => Math.max(m, Math.abs(h.rank)), 1);

  for (const hit of ftsHits) {
    if (entityIds.has(hit.objectId)) continue; // already included whole
    const obj = objById.get(hit.objectId);
    const fact = memory.getFact(hit.factId);
    if (!obj || !fact) continue;
    if (opts.maxTier && !tierWithin(fact.tier, opts.maxTier)) continue;

    // 3. Scope filter — same rules as views.
    const links = memory.linksForFacts([fact.id]).get(fact.id) ?? [];
    const disc = discloseFact(fact, links, scope);
    if (!disc.visible) continue;

    // 4. Score: normalized bm25 (invert: lower rank = better) + salience + recency.
    const bm25Norm = 1 - Math.abs(hit.rank) / (worstBm25 + 1e-6);
    const ageDays = fact.sourceTurnId ? (now - fact.updatedAt) / 86_400_000 : (now - fact.updatedAt) / 86_400_000;
    const recency = 1 / (1 + ageDays);
    const score = weights.bm25 * bm25Norm + weights.salience * obj.salience + weights.recency * recency + TIER_BONUS[fact.tier];

    ranked.push({ factId: fact.id, objectId: obj.id, objectName: obj.name, category: fact.category, content: disc.distortion ?? fact.content, tier: fact.tier, score });
  }

  ranked.sort((a, b) => b.score - a.score);

  // 5. Budget: entities first, then top facts until the token budget is spent.
  let used = entities.reduce((n, v) => n + estimateTokens(renderObjectView(v)), 0);
  const keptFacts: RankedFact[] = [];
  for (const f of ranked) {
    const cost = estimateTokens(`${f.objectName}: ${f.content}`) + 4;
    if (used + cost > maxTokens && keptFacts.length) break;
    if (used + cost > maxTokens) break;
    used += cost;
    keptFacts.push(f);
  }

  return { entities, facts: keptFacts };
}

/** Render a retrieval result as a prompt block. */
export function renderRetrieval(result: RetrievalResult): string {
  const parts: string[] = [];
  for (const v of result.entities) parts.push(renderObjectView(v));
  if (result.facts.length) {
    parts.push(['Other relevant facts:', ...result.facts.map((f) => `- ${f.objectName}: ${f.content}`)].join('\n'));
  }
  return parts.join('\n\n');
}
