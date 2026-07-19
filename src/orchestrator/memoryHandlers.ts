import type { Job } from '../db/stores/jobStore.ts';
import type { Row } from '../db/db.ts';
import type { HandlerDeps } from './handlers.ts';
import type { JobHandler } from './postTurn.ts';
import { ScribeMemory } from '../agents/scribeMemory.ts';
import type { MemoryDelta } from '../agents/scribeMemory.ts';
import { renderObjectView } from '../memory/model.ts';
import { findNearDuplicate, isNearDuplicate } from '../memory/similarity.ts';
import { normalizeName } from '../db/stores/memoryStore.ts';
import { logger } from '../util/logger.ts';

const MAX_NEW_FACTS_PER_TURN = 20; // doc 05 budget
const MAINTENANCE_EVERY = 10; // M turns (doc 04/05)

function scribeMemoryAgent(deps: HandlerDeps, storyId: string): ScribeMemory {
  const profileName = deps.stories.getStory(storyId)?.settings.roles.scribe_memory ?? deps.registry.getForRole('scribe_memory').name;
  const bound = deps.registry.getProfile(profileName);
  const session = deps.agents.ensureSession(storyId, 'scribe_memory', profileName);
  return new ScribeMemory({ session, bound, threadLog: deps.threadLog, storyId });
}

/**
 * Dossier writing is creative characterization, not extraction — bind it to
 * the npc-role model (storyteller-caliber) rather than the cheap scribe model.
 * The session stays under scribe_memory (it's still memory-writing work).
 */
function dossierAgent(deps: HandlerDeps, storyId: string): ScribeMemory {
  const profileName = deps.stories.getStory(storyId)?.settings.roles.npc ?? deps.registry.getForRole('npc').name;
  const bound = deps.registry.getProfile(profileName);
  const session = deps.agents.ensureSession(storyId, 'scribe_memory', profileName);
  return new ScribeMemory({ session, bound, threadLog: deps.threadLog, storyId });
}

/** Build a storyteller-scope snapshot of objects whose names/aliases appear in the turn. */
function buildSnapshot(deps: HandlerDeps, storyId: string, text: string): { snapshot: string; mentionedIds: string[] } {
  const norm = ` ${normalizeName(text)} `;
  const mentioned = deps.memory.listObjects(storyId).filter((o) => [o.name, ...o.aliases].some((n) => n.length > 1 && norm.includes(` ${normalizeName(n)} `)));
  const blocks = mentioned.map((o) => {
    const view = deps.memory.getObjectView(o.id, { kind: 'storyteller' }, { maxTokens: 300 });
    return `id=${o.id}\n${view ? renderObjectView(view) : o.name}`;
  });
  return { snapshot: blocks.join('\n\n'), mentionedIds: mentioned.map((o) => o.id) };
}

const ROSTER_MAX_OBJECTS = 120;

/**
 * A compact roster of ALL the story's objects (id, type, name, aliases, one
 * line of summary). The scribe needs this to recognize an entity referred to
 * by a NEW name ("the woman" who is already recorded as Kate) — the mention
 * snapshot alone only covers literal name matches, which is exactly how the
 * same character used to end up as three different objects.
 */
function buildRoster(deps: HandlerDeps, storyId: string): string {
  const objects = deps.memory.listObjects(storyId).slice(0, ROSTER_MAX_OBJECTS); // salience-ordered
  return objects
    .map((o) => {
      const aka = o.aliases.length ? ` (aka ${o.aliases.join(', ')})` : '';
      const summary = o.summary ? ` — ${o.summary.split('\n')[0].slice(0, 120)}` : '';
      return `- id=${o.id} [${o.type}] ${o.name}${aka}${summary}`;
    })
    .join('\n');
}

/**
 * scribe_memory handler (Layer 3b). Extract a MemoryDelta and apply it with
 * post-processing the LLM is not trusted to do: tempId resolution, alias
 * auto-merge, supersede, clamps, and knowledge links from `knownBy`.
 */
export function createScribeMemoryHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const turnId = job.payload.turnId as string;
    const story = deps.stories.getStory(storyId);
    const turn = deps.stories.getTurn(turnId);
    if (!story || !turn || turn.status !== 'complete') return;

    const scene = turn.sceneId ? deps.stories.getScene(turn.sceneId) : undefined;
    const presentNpcIds = scene?.activeNpcIds ?? [];
    const { snapshot } = buildSnapshot(deps, storyId, `${turn.playerInput} ${turn.narration}`);

    const agent = scribeMemoryAgent(deps, storyId);
    const delta: MemoryDelta = await agent.extract(
      { playerInput: turn.playerInput, narration: turn.narration, presentNpcIds, snapshot, roster: buildRoster(deps, storyId) },
      { turnId },
    );
    if (!deps.stories.getTurn(turnId)) return; // turn rewound while extracting — discard

    const affected = applyMemoryDelta(deps, storyId, turnId, delta);

    if (affected.length) deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });

    // Schedule maintenance every M turns.
    if ((turn.index + 1) % MAINTENANCE_EVERY === 0) {
      deps.jobs.enqueue('memory_maintenance', { storyId, payload: {} });
    }
  };
}

/** Apply a MemoryDelta with trust-but-verify post-processing. Returns affected object ids. */
export function applyMemoryDelta(deps: HandlerDeps, storyId: string, turnId: string | null, delta: MemoryDelta): string[] {
  // In-game clock stamp for this batch of facts: the clock as of the source
  // turn when known, else the story's current clock (archival passes).
  // (deps.stories is optional-chained: unit tests build partial deps.)
  const turn = turnId ? deps.stories?.getTurn(turnId) : undefined;
  const gameTimeMin = (turn?.meta.clockMin as number | undefined) ?? deps.stories?.getStory(storyId)?.clockMin;

  return deps.db.transaction(() => {
    const tempMap = new Map<string, string>(); // tempId -> real object id
    const affected = new Set<string>();

    // 1. Resolve new objects (alias auto-merge against existing).
    for (const no of delta.newObjects) {
      const match = deps.memory.findByName(storyId, no.name) ?? no.aliases.map((a) => deps.memory.findByName(storyId, a)).find(Boolean);
      if (match) {
        tempMap.set(no.tempId, match.id);
        // Fold in any new aliases.
        const merged = Array.from(new Set([...match.aliases, ...no.aliases])).filter((a) => normalizeName(a) !== normalizeName(match.name));
        if (merged.length !== match.aliases.length) deps.memory.updateObject(match.id, { aliases: merged });
        affected.add(match.id);
      } else {
        const created = deps.memory.createObject({ storyId, type: no.type, name: no.name, aliases: no.aliases, summary: no.summary, salience: 0.6, status: 'active' });
        tempMap.set(no.tempId, created.id);
        affected.add(created.id);
      }
    }

    // 2. New facts (clamped), resolving tempIds and superseding.
    let added = 0;
    for (const nf of delta.newFacts) {
      if (added >= MAX_NEW_FACTS_PER_TURN) break;
      const objectId = tempMap.get(nf.objectId) ?? (deps.memory.getObject(nf.objectId) ? nf.objectId : undefined);
      if (!objectId) continue; // unresolved reference — skip

      // Feature 6: dedupe — when this (or something very similar) is already
      // recorded on the object, don't add it again; just extend who knows it.
      if (!nf.supersedesFactId) {
        const dup = findNearDuplicate(deps.memory.listFacts(objectId), nf.content);
        if (dup) {
          if (nf.detailLevel !== 'hidden') {
            for (const knower of nf.knownBy) {
              if (knower === 'player') deps.memory.linkKnowledge(dup.id, { type: 'player' }, { learnedTurnId: turnId ?? undefined });
              else {
                const npcId = tempMap.get(knower) ?? (deps.memory.getObject(knower) ? knower : undefined);
                if (npcId) deps.memory.linkKnowledge(dup.id, { type: 'npc', npcObjectId: npcId }, { learnedTurnId: turnId ?? undefined });
              }
            }
          }
          continue;
        }
      }

      const factInput = {
        objectId,
        category: nf.category,
        subcategory: nf.subcategory,
        detailLevel: nf.detailLevel,
        tier: nf.tier,
        content: nf.content,
        confidence: nf.confidence,
        sourceTurnId: turnId ?? undefined,
        gameTimeMin,
      };
      const supersedeId = nf.supersedesFactId && deps.memory.getFact(nf.supersedesFactId) ? nf.supersedesFactId : undefined;
      const fact = supersedeId ? deps.memory.supersedeFact(supersedeId, factInput) : deps.memory.addFact(factInput);
      added++;
      affected.add(objectId);

      // 3. Knowledge links from knownBy (hidden facts get none).
      if (nf.detailLevel !== 'hidden') {
        for (const knower of nf.knownBy) {
          if (knower === 'player') {
            deps.memory.linkKnowledge(fact.id, { type: 'player' }, { learnedTurnId: turnId ?? undefined });
          } else {
            const npcId = tempMap.get(knower) ?? (deps.memory.getObject(knower) ? knower : undefined);
            if (npcId) deps.memory.linkKnowledge(fact.id, { type: 'npc', npcObjectId: npcId }, { learnedTurnId: turnId ?? undefined });
          }
        }
      }
    }

    // 4. Salience updates (clamped in updateObject). Skipped when the story
    // has the salience system turned off.
    const salienceOn = deps.stories?.getStory(storyId)?.settings.salience.enabled ?? true;
    for (const su of salienceOn ? delta.salienceUpdates : []) {
      const objId = tempMap.get(su.objectId) ?? su.objectId;
      if (deps.memory.getObject(objId)) {
        deps.memory.updateObject(objId, { salience: su.salience });
        affected.add(objId);
      }
    }

    // 5. Merge suggestions (fuzzy) → human review queue.
    for (const ms of delta.mergeSuggestions) {
      const keep = tempMap.get(ms.keepId) ?? ms.keepId;
      const merge = tempMap.get(ms.mergeId) ?? ms.mergeId;
      if (deps.memory.getObject(keep) && deps.memory.getObject(merge) && keep !== merge) {
        deps.suggestions.add({ storyId, type: 'merge', keepId: keep, mergeId: merge, reason: ms.reason });
      }
    }

    return Array.from(affected);
  });
}

/**
 * archive_faded handler (feature 3). When the story scribe drops ("fades out")
 * details from a summary, they are handed here and objectified into long-term
 * memory via the memory scribe — nothing important (or unimportant) is lost,
 * it just moves from the summary into memory.
 */
export function createArchiveFadedHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    if (!deps.stories.getStory(storyId)) return;
    const items = ((job.payload.items as string[]) ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (!items.length) return;

    const text = items.map((s) => `- ${s}`).join('\n');
    const { snapshot } = buildSnapshot(deps, storyId, text);
    const agent = scribeMemoryAgent(deps, storyId);
    const delta: MemoryDelta = await agent.extract(
      {
        playerInput: '',
        narration:
          `(Archival pass — these past events/details are fading out of the story summary. ` +
          `Record anything durable as objects and facts so it is not lost. These already happened; the player witnessed them.)\n${text}`,
        presentNpcIds: [],
        snapshot,
        roster: buildRoster(deps, storyId),
      },
      {},
    );
    if (!deps.stories.getStory(storyId)) return;
    const affected = applyMemoryDelta(deps, storyId, null, delta);
    if (affected.length) deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });
  };
}

/**
 * npc_dossier handler. On first elevation, a promoted NPC gets a full
 * character sheet — persona, looks, belongings, skills, current state,
 * (possibly hidden) goals — recorded as memory facts on their object. The
 * per-turn memory scribe keeps those facts updated (supersede) afterwards;
 * dedupe drops anything already recorded.
 */
export function createNpcDossierHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const objectId = job.payload.objectId as string;
    const story = deps.stories.getStory(storyId);
    const obj = deps.memory.getObject(objectId);
    if (!story || !obj) return;

    const view = deps.memory.getObjectView(objectId, { kind: 'storyteller' }, { maxTokens: 600 });
    const recentTurns = deps.stories
      .recentTurns(storyId, 3)
      .filter((t) => t.status === 'complete')
      .map((t) => `Player: ${t.playerInput || '(scene opens)'}\nNarration: ${t.narration}`)
      .join('\n\n');

    const agent = dossierAgent(deps, storyId);
    const delta: MemoryDelta = await agent.dossier({
      name: obj.name,
      objectId,
      currentSheet: view ? renderObjectView(view) : obj.name,
      premise: story.settings.premise,
      digest: deps.summaries.getStoryDigest(storyId)?.content ?? '',
      sceneSummary: story.currentSceneId ? deps.summaries.getSceneSummary(story.currentSceneId)?.content ?? '' : '',
      recentTurns,
    });
    if (!deps.memory.getObject(objectId)) return; // deleted/rewound while generating

    const affected = applyMemoryDelta(deps, storyId, null, delta);
    if (affected.length) deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });
  };
}

/**
 * Merge one memory object into another, losslessly (feature: entity merge).
 * Unlike the old suggestion-accept path (which copied fact TEXT and dropped
 * everything else), this re-points every reference to the merged object:
 *  - facts move to the kept object (near-duplicates superseded, their knowledge
 *    links copied to the surviving fact),
 *  - knowledge links where the merged object is the KNOWER follow it,
 *  - scene rosters, NPC agent sessions and the player-character setting follow,
 *  - name + aliases fold into the kept object's aliases.
 * Returns false when either object is missing or they don't belong together.
 */
export function mergeMemoryObjects(deps: HandlerDeps, keepId: string, mergeId: string): boolean {
  const keep = deps.memory.getObject(keepId);
  const merge = deps.memory.getObject(mergeId);
  if (!keep || !merge || keep.id === merge.id || keep.storyId !== merge.storyId) return false;
  const storyId = keep.storyId;
  const now = Date.now();

  deps.db.transaction(() => {
    // 1. Facts move over (the FTS sync trigger fires on UPDATE).
    deps.db.prepare(`UPDATE memory_facts SET object_id = ?, updated_at = ? WHERE object_id = ?`).run(keepId, now, mergeId);

    // 2. Knowledge links where the merged object was the knower.
    deps.db.prepare(`UPDATE knowledge_links SET knower_npc_object_id = ?, updated_at = ? WHERE knower_npc_object_id = ?`).run(keepId, now, mergeId);
    // De-dupe (fact, knower) pairs that now collide.
    deps.db
      .prepare(
        `DELETE FROM knowledge_links WHERE id NOT IN (
           SELECT MIN(id) FROM knowledge_links GROUP BY fact_id, knower_type, IFNULL(knower_npc_object_id, '')
         )`,
      )
      .run();

    // 3. Near-duplicate facts (both objects said the same thing): supersede the
    // newer copy, but first copy its knowledge links to the survivor.
    const live = deps.memory.listFacts(keepId);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        if (a.superseded || b.superseded) continue;
        if (a.category !== b.category || !isNearDuplicate(a.content, b.content)) continue;
        const [survivor, dupe] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
        const links = deps.memory.linksForFacts([dupe.id]).get(dupe.id) ?? [];
        for (const l of links) {
          deps.memory.linkKnowledge(
            survivor.id,
            { type: l.knowerType, npcObjectId: l.knowerNpcObjectId ?? undefined },
            { learnedTurnId: l.learnedTurnId ?? undefined, distortion: l.distortion ?? undefined },
          );
        }
        deps.memory.updateFact(dupe.id, { superseded: true });
        dupe.superseded = true;
      }
    }

    // 4. Scene rosters.
    for (const r of deps.db.prepare(`SELECT id, active_npc_ids FROM scenes WHERE story_id = ?`).all<Row>(storyId)) {
      const ids = JSON.parse((r.active_npc_ids as string) || '[]') as string[];
      if (!ids.includes(mergeId)) continue;
      const next = Array.from(new Set(ids.map((x) => (x === mergeId ? keepId : x))));
      deps.db.prepare(`UPDATE scenes SET active_npc_ids = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(next), now, r.id);
    }

    // 5. NPC agent sessions: follow the merge unless the kept object already
    // has one (then the merged object's session is dropped — thread_log keeps
    // its history).
    const keepHasSession = !!deps.db.prepare(`SELECT id FROM agent_sessions WHERE story_id = ? AND role = 'npc' AND npc_object_id = ?`).get(storyId, keepId);
    if (keepHasSession) deps.db.prepare(`DELETE FROM agent_sessions WHERE story_id = ? AND role = 'npc' AND npc_object_id = ?`).run(storyId, mergeId);
    else deps.db.prepare(`UPDATE agent_sessions SET npc_object_id = ?, updated_at = ? WHERE story_id = ? AND npc_object_id = ?`).run(keepId, now, storyId, mergeId);

    // 6. The player character setting.
    const story = deps.stories.getStory(storyId);
    if (story?.settings.playerObjectId === mergeId) {
      deps.stories.updateStory(storyId, { settings: { playerObjectId: keepId } });
    }

    // 7. Stale pending suggestions that reference the merged object.
    deps.db.prepare(`DELETE FROM memory_suggestions WHERE story_id = ? AND status = 'pending' AND (keep_id = ? OR merge_id = ?)`).run(storyId, mergeId, mergeId);

    // 8. Fold identity into the kept object, then delete the merged one.
    const aliases = Array.from(new Set([...keep.aliases, merge.name, ...merge.aliases])).filter((a) => normalizeName(a) !== normalizeName(keep.name));
    deps.memory.updateObject(keepId, {
      aliases,
      salience: Math.max(keep.salience, merge.salience),
      summary: keep.summary || merge.summary,
    });
    deps.memory.deleteObject(mergeId);
  });

  logger.info('memory objects merged', { storyId, keepId, mergeId, mergedName: merge.name });
  deps.events.emit({ t: 'memory.updated', storyId, objectIds: [keepId] });
  return true;
}

// Cleanup pass limits: keep a maintenance run bounded on a phone.
const UNIFY_MAX_MERGES = 8;
const CONSOLIDATE_MIN_FACTS = 8; // objects with fewer live facts are left alone
const CONSOLIDATE_MAX_OBJECTS = 4; // per maintenance run
const CONSOLIDATE_MAX_OPS = 15; // removals and rewrites, each

/** One object's live facts with ids, rendered for the consolidation pass. */
function renderForConsolidation(deps: HandlerDeps, objectId: string): string | undefined {
  const obj = deps.memory.getObject(objectId);
  if (!obj) return undefined;
  const facts = deps.memory.listFacts(objectId);
  const lines = [
    `## ${obj.name}${obj.aliases.length ? ` (aka ${obj.aliases.join(', ')})` : ''} — ${obj.type}`,
    `Summary: ${obj.summary || '(none)'}`,
    '',
    '## Live facts',
    ...facts.map((f) => `- (${f.id}) [${f.category}${f.subcategory ? '/' + f.subcategory : ''} · ${f.tier} · ${f.detailLevel}] ${f.content}`),
  ];
  return lines.join('\n');
}

/**
 * Maintenance job (Layer 3b), every M turns or on demand from the UI:
 *  1. salience decay for long-unmentioned objects (when salience is enabled),
 *  2. entity unification — the scribe scans the roster for the same entity
 *     recorded under different names; certain merges apply automatically,
 *     doubtful ones land in the suggestion inbox,
 *  3. fact consolidation — for the fattest objects, the scribe deduplicates
 *     and unifies facts (superseded, never hard-deleted) and refreshes the
 *     object summary.
 */
export function createMemoryMaintenanceHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const story = deps.stories.getStory(storyId);
    if (!story) return;
    const affected = new Set<string>();

    // --- 1. Salience decay (only when the salience system is on). ---
    if (story.settings.salience.enabled) {
      for (const obj of deps.memory.listObjects(storyId)) {
        // Decay salience of objects not touched recently (×0.95, floor 0.1).
        const stale = Date.now() - obj.updatedAt > 60_000; // "unmentioned" proxy within a session
        if (stale) {
          const decayed = Math.max(0.1, obj.salience * 0.95);
          if (decayed !== obj.salience) {
            deps.memory.updateObject(obj.id, { salience: decayed });
            affected.add(obj.id);
          }
        }
      }
    }

    const agent = scribeMemoryAgent(deps, storyId);

    // --- 2. Entity unification over the roster. ---
    if (deps.memory.listObjects(storyId).length >= 2) {
      try {
        const reply = await agent.unify({ roster: buildRoster(deps, storyId) });
        for (const m of reply.merges.slice(0, UNIFY_MAX_MERGES)) {
          if (m.certainty === 'certain') {
            if (mergeMemoryObjects(deps, m.keepId, m.mergeId)) affected.add(m.keepId);
          } else if (deps.memory.getObject(m.keepId) && deps.memory.getObject(m.mergeId) && m.keepId !== m.mergeId) {
            deps.suggestions.add({ storyId, type: 'merge', keepId: m.keepId, mergeId: m.mergeId, reason: m.reason || 'possible duplicate (maintenance)' });
          }
        }
      } catch (err) {
        logger.warn('maintenance: unify pass failed — skipping', { storyId, err: (err as Error).message });
      }
    }

    // --- 3. Fact consolidation for the fattest objects. ---
    const fat = deps.memory
      .listObjects(storyId)
      .map((o) => ({ obj: o, live: deps.memory.listFacts(o.id).length }))
      .filter((x) => x.live >= CONSOLIDATE_MIN_FACTS)
      .sort((a, b) => b.obj.updatedAt - a.obj.updatedAt)
      .slice(0, CONSOLIDATE_MAX_OBJECTS);
    for (const { obj } of fat) {
      const block = renderForConsolidation(deps, obj.id);
      if (!block) continue;
      try {
        const reply = await agent.consolidate({ objectBlock: block });
        if (!deps.memory.getObject(obj.id)) continue; // merged/deleted meanwhile
        const liveIds = new Set(deps.memory.listFacts(obj.id).map((f) => f.id));
        deps.db.transaction(() => {
          for (const r of reply.rewrites.slice(0, CONSOLIDATE_MAX_OPS)) {
            const old = deps.memory.getFact(r.factId);
            if (!old || !liveIds.has(old.id) || !r.content.trim()) continue;
            const fresh = deps.memory.supersedeFact(old.id, {
              objectId: old.objectId,
              category: r.category ?? old.category,
              subcategory: r.subcategory ?? old.subcategory ?? undefined,
              detailLevel: old.detailLevel,
              tier: r.tier ?? old.tier,
              content: r.content.trim(),
              confidence: old.confidence,
              sourceTurnId: old.sourceTurnId ?? undefined,
              gameTimeMin: old.gameTimeMin ?? undefined,
            });
            // Who-knows-this carries over to the rewritten fact.
            for (const l of deps.memory.linksForFacts([old.id]).get(old.id) ?? []) {
              deps.memory.linkKnowledge(fresh.id, { type: l.knowerType, npcObjectId: l.knowerNpcObjectId ?? undefined }, { learnedTurnId: l.learnedTurnId ?? undefined, distortion: l.distortion ?? undefined });
            }
          }
          for (const fid of reply.removeFactIds.slice(0, CONSOLIDATE_MAX_OPS)) {
            if (liveIds.has(fid)) deps.memory.updateFact(fid, { superseded: true });
          }
          if (reply.summary?.trim()) deps.memory.updateObject(obj.id, { summary: reply.summary.trim() });
        });
        affected.add(obj.id);
      } catch (err) {
        logger.warn('maintenance: consolidation failed — skipping object', { storyId, objectId: obj.id, err: (err as Error).message });
      }
    }

    if (affected.size) deps.events.emit({ t: 'memory.updated', storyId, objectIds: Array.from(affected) });
  };
}

/**
 * Manual memory re-scan (UI "re-scan turns" button): re-run the memory scribe
 * over the last few completed exchanges. For when a pass missed something —
 * the near-duplicate filter in applyMemoryDelta makes re-runs safe (already
 * captured facts are skipped, missed ones land). Returns how many turn jobs
 * were enqueued.
 */
export function enqueueMemoryRescan(deps: Pick<HandlerDeps, 'stories' | 'jobs'>, storyId: string, turns = 5): number {
  const n = Math.min(Math.max(Math.floor(turns) || 1, 1), 20);
  const completed = deps.stories
    .recentTurns(storyId, n + 4)
    .filter((t) => t.status === 'complete')
    .slice(-n);
  for (const t of completed) {
    deps.jobs.enqueue('scribe_memory', { storyId, turnId: t.id, payload: { turnId: t.id } });
  }
  return completed.length;
}
