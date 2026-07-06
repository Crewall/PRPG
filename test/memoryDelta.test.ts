import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createMemoryStore } from '../src/db/stores/memoryStore.ts';
import { createSuggestionStore } from '../src/db/stores/suggestionStore.ts';
import { applyMemoryDelta } from '../src/orchestrator/memoryHandlers.ts';
import { MemoryDelta } from '../src/agents/scribeMemory.ts';
import type { HandlerDeps } from '../src/orchestrator/handlers.ts';

// applyMemoryDelta only touches db/memory/suggestions; build a partial deps.
function makeDeps(db: Db): HandlerDeps {
  return { db, memory: createMemoryStore(db), suggestions: createSuggestionStore(db) } as unknown as HandlerDeps;
}

describe('applyMemoryDelta post-processing (Layer 3b)', () => {
  let db: Db;
  let deps: HandlerDeps;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(`INSERT INTO stories (id,title,settings_json,status,created_at,updated_at) VALUES ('s','t','{}','active',?,?)`).run(now, now);
    deps = makeDeps(db);
  });
  afterEach(() => db.close());

  it('resolves tempIds and links knownBy=player', () => {
    const delta = MemoryDelta.parse({
      newObjects: [{ tempId: 't1', type: 'character', name: 'Marta', aliases: ['the innkeeper'] }],
      newFacts: [
        { objectId: 't1', category: 'appearance', detailLevel: 'visible', content: 'A stout woman with grey hair.', knownBy: ['player'] },
        { objectId: 't1', category: 'history', detailLevel: 'secret', content: 'She hid the ledger.', knownBy: ['player'] },
      ],
    });
    applyMemoryDelta(deps, 's', 'turn1', delta);

    const marta = deps.memory.findByName('s', 'the innkeeper')!;
    expect(marta.name).toBe('Marta');
    const facts = deps.memory.listFacts(marta.id);
    expect(facts).toHaveLength(2);
    // Secret fact is disclosed to the player because knownBy included 'player'.
    const playerView = deps.memory.getObjectView(marta.id, { kind: 'player' })!;
    expect(playerView.facts.map((f) => f.content)).toContain('She hid the ledger.');
  });

  it('auto-merges an aliased mention instead of creating a duplicate', () => {
    deps.memory.createObject({ storyId: 's', type: 'character', name: 'Marta', aliases: ['Old Marta'], summary: '', salience: 0.5, status: 'active' });
    const delta = MemoryDelta.parse({
      newObjects: [{ tempId: 't1', type: 'character', name: 'Old Marta' }], // alias of the existing object
      newFacts: [{ objectId: 't1', category: 'state', detailLevel: 'visible', content: 'Looks tired.' }],
    });
    applyMemoryDelta(deps, 's', 'turn2', delta);
    expect(deps.memory.listObjects('s')).toHaveLength(1); // no duplicate
    const marta = deps.memory.findByName('s', 'Marta')!;
    expect(deps.memory.listFacts(marta.id).map((f) => f.content)).toContain('Looks tired.');
  });

  it('supersedes an old fact (clothes change)', () => {
    const marta = deps.memory.createObject({ storyId: 's', type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const old = deps.memory.addFact({ objectId: marta.id, category: 'appearance', detailLevel: 'visible', content: 'Wears a plain apron.', confidence: 1 });
    const delta = MemoryDelta.parse({
      newFacts: [{ objectId: marta.id, category: 'appearance', detailLevel: 'visible', content: 'Now in travelling leathers.', supersedesFactId: old.id }],
    });
    applyMemoryDelta(deps, 's', 'turn3', delta);
    const visible = deps.memory.getObjectView(marta.id, { kind: 'perception' })!;
    expect(visible.facts.map((f) => f.content)).toEqual(['Now in travelling leathers.']);
    expect(deps.memory.getFact(old.id)!.superseded).toBe(true);
  });

  it('clamps to at most 20 new facts per turn', () => {
    const marta = deps.memory.createObject({ storyId: 's', type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const delta = MemoryDelta.parse({
      newFacts: Array.from({ length: 25 }, (_, i) => ({ objectId: marta.id, category: 'history', detailLevel: 'known' as const, content: `fact ${i}`, knownBy: [] })),
    });
    applyMemoryDelta(deps, 's', 'turn4', delta);
    expect(deps.memory.listFacts(marta.id)).toHaveLength(20);
  });

  it('never links a knower to a hidden fact', () => {
    const marta = deps.memory.createObject({ storyId: 's', type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const delta = MemoryDelta.parse({
      newFacts: [{ objectId: marta.id, category: 'goals', detailLevel: 'hidden', content: 'Secret authorial twist.', knownBy: ['player'] }],
    });
    applyMemoryDelta(deps, 's', 'turn5', delta);
    // Player must not see a hidden fact even though the scribe wrongly listed them.
    const playerView = deps.memory.getObjectView(marta.id, { kind: 'player' })!;
    expect(playerView.facts).toHaveLength(0);
    const stView = deps.memory.getObjectView(marta.id, { kind: 'storyteller' })!;
    expect(stView.facts).toHaveLength(1);
  });

  it('queues fuzzy merge suggestions for review', () => {
    const a = deps.memory.createObject({ storyId: 's', type: 'character', name: 'Guard', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const b = deps.memory.createObject({ storyId: 's', type: 'character', name: 'The Guardsman', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const delta = MemoryDelta.parse({ mergeSuggestions: [{ keepId: a.id, mergeId: b.id, reason: 'likely the same person' }] });
    applyMemoryDelta(deps, 's', 'turn6', delta);
    const pending = deps.suggestions.listPending('s');
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toContain('same person');
  });
});
