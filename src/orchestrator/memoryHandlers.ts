import type { Job } from '../db/stores/jobStore.ts';
import type { HandlerDeps } from './handlers.ts';
import type { JobHandler } from './postTurn.ts';
import { ScribeMemory } from '../agents/scribeMemory.ts';
import type { MemoryDelta } from '../agents/scribeMemory.ts';
import { renderObjectView } from '../memory/model.ts';
import { normalizeName } from '../db/stores/memoryStore.ts';

const MAX_NEW_FACTS_PER_TURN = 20; // doc 05 budget
const MAINTENANCE_EVERY = 10; // M turns (doc 04/05)

function scribeMemoryAgent(deps: HandlerDeps, storyId: string): ScribeMemory {
  const profileName = deps.stories.getStory(storyId)?.settings.roles.scribe_memory ?? deps.registry.getForRole('scribe_memory').name;
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
      { playerInput: turn.playerInput, narration: turn.narration, presentNpcIds, snapshot },
      { turnId },
    );

    const affected = applyMemoryDelta(deps, storyId, turnId, delta);

    if (affected.length) deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });

    // Schedule maintenance every M turns.
    if ((turn.index + 1) % MAINTENANCE_EVERY === 0) {
      deps.jobs.enqueue('memory_maintenance', { storyId, payload: {} });
    }
  };
}

/** Apply a MemoryDelta with trust-but-verify post-processing. Returns affected object ids. */
export function applyMemoryDelta(deps: HandlerDeps, storyId: string, turnId: string, delta: MemoryDelta): string[] {
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
      const factInput = {
        objectId,
        category: nf.category,
        subcategory: nf.subcategory,
        detailLevel: nf.detailLevel,
        content: nf.content,
        confidence: nf.confidence,
        sourceTurnId: turnId,
      };
      const supersedeId = nf.supersedesFactId && deps.memory.getFact(nf.supersedesFactId) ? nf.supersedesFactId : undefined;
      const fact = supersedeId ? deps.memory.supersedeFact(supersedeId, factInput) : deps.memory.addFact(factInput);
      added++;
      affected.add(objectId);

      // 3. Knowledge links from knownBy (hidden facts get none).
      if (nf.detailLevel !== 'hidden') {
        for (const knower of nf.knownBy) {
          if (knower === 'player') {
            deps.memory.linkKnowledge(fact.id, { type: 'player' }, { learnedTurnId: turnId });
          } else {
            const npcId = tempMap.get(knower) ?? (deps.memory.getObject(knower) ? knower : undefined);
            if (npcId) deps.memory.linkKnowledge(fact.id, { type: 'npc', npcObjectId: npcId }, { learnedTurnId: turnId });
          }
        }
      }
    }

    // 4. Salience updates (clamped in updateObject).
    for (const su of delta.salienceUpdates) {
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
 * Maintenance job (Layer 3b): salience decay for long-unmentioned objects and a
 * summary refresh. Runs on the M-turn cadence. (Dedup/consolidation via the
 * scribe is a later enhancement; decay + summary keep memory tidy for now.)
 */
export function createMemoryMaintenanceHandler(deps: HandlerDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const objects = deps.memory.listObjects(storyId);
    const affected: string[] = [];
    for (const obj of objects) {
      // Decay salience of objects not touched recently (×0.95, floor 0.1).
      const stale = Date.now() - obj.updatedAt > 60_000; // "unmentioned" proxy within a session
      if (stale) {
        const decayed = Math.max(0.1, obj.salience * 0.95);
        if (decayed !== obj.salience) {
          deps.memory.updateObject(obj.id, { salience: decayed });
          affected.push(obj.id);
        }
      }
    }
    if (affected.length) deps.events.emit({ t: 'memory.updated', storyId, objectIds: affected });
  };
}
