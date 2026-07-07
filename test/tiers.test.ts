import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createMemoryStore } from '../src/db/stores/memoryStore.ts';
import type { MemoryStore } from '../src/db/stores/memoryStore.ts';
import { searchFacts } from '../src/memory/retrieval.ts';

describe('fact tiers (feature 2)', () => {
  let db: Db;
  let memory: MemoryStore;
  const storyId = 's1';

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO stories (id, title, settings_json, status, created_at, updated_at) VALUES (?, 'T', '{}', 'active', 0, 0)`).run(storyId);
    memory = createMemoryStore(db);
  });
  afterEach(() => db.close());

  function seedGuard() {
    const guard = memory.createObject({ storyId, type: 'character', name: 'Guard', aliases: [], summary: 'A tower guard.', salience: 0.8, status: 'active' });
    memory.addFact({ objectId: guard.id, category: 'appearance', detailLevel: 'visible', tier: 'minor', content: 'a faint scar under the chin', confidence: 1 });
    memory.addFact({ objectId: guard.id, category: 'appearance', detailLevel: 'visible', tier: 'major', content: 'towering, in gleaming plate armor', confidence: 1 });
    memory.addFact({ objectId: guard.id, category: 'personality', detailLevel: 'visible', tier: 'mid', content: 'wary of strangers', confidence: 1 });
    return guard;
  }

  it('defaults to mid and persists explicit tiers', () => {
    const guard = seedGuard();
    const f = memory.addFact({ objectId: guard.id, category: 'state', detailLevel: 'visible', content: 'on duty', confidence: 1 });
    expect(f.tier).toBe('mid');
    expect(memory.listFacts(guard.id).find((x) => x.content.includes('scar'))?.tier).toBe('minor');
  });

  it('ranks views major-first and renders the tier', () => {
    const guard = seedGuard();
    const view = memory.getObjectView(guard.id, { kind: 'player' })!;
    expect(view.facts.map((f) => f.tier)).toEqual(['major', 'mid', 'minor']);
  });

  it('filters views by maxTier depth', () => {
    const guard = seedGuard();
    const majorOnly = memory.getObjectView(guard.id, { kind: 'player' }, { maxTier: 'major' })!;
    expect(majorOnly.facts).toHaveLength(1);
    expect(majorOnly.facts[0].content).toContain('plate armor');
    const majorMid = memory.getObjectView(guard.id, { kind: 'player' }, { maxTier: 'mid' })!;
    expect(majorMid.facts).toHaveLength(2);
    const all = memory.getObjectView(guard.id, { kind: 'player' }, { maxTier: 'minor' })!;
    expect(all.facts).toHaveLength(3);
  });

  it('retrieval respects maxTier and reports tiers', () => {
    seedGuard();
    // FTS pass (query does not name the object, so facts come back individually).
    const all = searchFacts(memory, storyId, { kind: 'player' }, 'scar armor strangers', {});
    expect(all.facts.some((f) => f.tier === 'minor')).toBe(true);

    const shallow = searchFacts(memory, storyId, { kind: 'player' }, 'scar armor strangers', { maxTier: 'mid' });
    expect(shallow.facts.every((f) => f.tier !== 'minor')).toBe(true);
    expect(shallow.facts.some((f) => f.content.includes('plate armor'))).toBe(true);
  });

  it('factsByCategory returns live goal facts across the story', () => {
    const guard = seedGuard();
    memory.addFact({ objectId: guard.id, category: 'goals', detailLevel: 'known', tier: 'major', content: 'wants a transfer to the capital', confidence: 1 });
    const goals = memory.factsByCategory(storyId, ['goals', 'goal']);
    expect(goals).toHaveLength(1);
    expect(goals[0].objectName).toBe('Guard');
    expect(goals[0].fact.content).toContain('transfer');
  });
});
