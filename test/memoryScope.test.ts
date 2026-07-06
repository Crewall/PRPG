import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createMemoryStore } from '../src/db/stores/memoryStore.ts';
import type { MemoryStore } from '../src/db/stores/memoryStore.ts';

// Builds the doc-05 "Hooded Stranger" scenario and asserts every scope sees
// exactly the right facts (visible/known/secret/hidden × player/npc/perception/
// storyteller), including distortions.
describe('getObjectView — the disclosure matrix (doc 05)', () => {
  let db: Db;
  let memory: MemoryStore;
  let strangerId: string;
  let martaId: string;
  let tomId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(`INSERT INTO stories (id,title,settings_json,status,created_at,updated_at) VALUES ('s','t','{}','active',?,?)`).run(now, now);
    memory = createMemoryStore(db);

    const stranger = memory.createObject({ storyId: 's', type: 'character', name: 'The Hooded Stranger', aliases: ['Corvin'], summary: 'A cloaked figure.', salience: 0.9, status: 'active' });
    const marta = memory.createObject({ storyId: 's', type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const tom = memory.createObject({ storyId: 's', type: 'character', name: 'Old Tom', aliases: [], summary: '', salience: 0.5, status: 'active' });
    strangerId = stranger.id;
    martaId = marta.id;
    tomId = tom.id;

    const fVis1 = memory.addFact({ objectId: strangerId, category: 'appearance', detailLevel: 'visible', content: 'Tall figure in a rain-soaked grey cloak, face shadowed.', confidence: 1 });
    memory.addFact({ objectId: strangerId, category: 'state', detailLevel: 'visible', content: 'Keeps the right hand under the cloak at all times.', confidence: 1 });
    const fKnown = memory.addFact({ objectId: strangerId, category: 'identity', detailLevel: 'known', content: "Calls himself 'Corvin', a spice merchant.", confidence: 0.9 });
    const fSecret = memory.addFact({ objectId: strangerId, category: 'identity', detailLevel: 'secret', content: 'Is actually Sera Voss, fugitive court mage.', confidence: 0.9 });
    memory.addFact({ objectId: strangerId, category: 'goals', detailLevel: 'hidden', content: 'Plans to burn the archive on the solstice.', confidence: 1 });
    void fVis1;

    // Known identity: player (with a distortion) + Marta (canonical). Secret: Marta only.
    memory.linkKnowledge(fKnown.id, { type: 'player' }, { distortion: 'A traveling bard named Piper.' });
    memory.linkKnowledge(fKnown.id, { type: 'npc', npcObjectId: martaId });
    memory.linkKnowledge(fSecret.id, { type: 'npc', npcObjectId: martaId });
  });

  afterEach(() => db.close());

  const contents = (facts: { content: string }[]) => facts.map((f) => f.content);

  it('storyteller sees everything, canonical (incl. hidden)', () => {
    const v = memory.getObjectView(strangerId, { kind: 'storyteller' })!;
    expect(v.facts).toHaveLength(5);
    expect(contents(v.facts)).toContain('Plans to burn the archive on the solstice.');
    expect(contents(v.facts)).toContain("Calls himself 'Corvin', a spice merchant."); // no distortion for storyteller
  });

  it('perception sees only visible facts', () => {
    const v = memory.getObjectView(strangerId, { kind: 'perception' })!;
    expect(v.facts).toHaveLength(2);
    expect(v.facts.every((f) => f.detailLevel === 'visible')).toBe(true);
  });

  it('player sees visible + linked known (distorted), never secret/hidden', () => {
    const v = memory.getObjectView(strangerId, { kind: 'player' })!;
    expect(v.facts).toHaveLength(3);
    const c = contents(v.facts);
    expect(c).toContain('A traveling bard named Piper.'); // distortion substituted
    expect(c).not.toContain("Calls himself 'Corvin', a spice merchant.");
    expect(c).not.toContain('Is actually Sera Voss, fugitive court mage.');
    expect(c.some((x) => x.includes('archive'))).toBe(false);
  });

  it('the knowing NPC (Marta) sees visible + known(canonical) + secret, never hidden', () => {
    const v = memory.getObjectView(strangerId, { kind: 'npc', npcObjectId: martaId })!;
    expect(v.facts).toHaveLength(4);
    const c = contents(v.facts);
    expect(c).toContain("Calls himself 'Corvin', a spice merchant."); // canonical, not player's distortion
    expect(c).toContain('Is actually Sera Voss, fugitive court mage.');
    expect(c.some((x) => x.includes('archive'))).toBe(false);
  });

  it('an unknowing NPC (Tom) sees only visible facts', () => {
    const v = memory.getObjectView(strangerId, { kind: 'npc', npcObjectId: tomId })!;
    expect(v.facts).toHaveLength(2);
    expect(v.facts.every((f) => f.detailLevel === 'visible')).toBe(true);
  });

  it('category filtering narrows a glance', () => {
    const v = memory.getObjectView(strangerId, { kind: 'storyteller' }, { categories: ['appearance'] })!;
    expect(v.facts).toHaveLength(1);
    expect(v.facts[0].category).toBe('appearance');
  });

  it('superseded facts drop out of views', () => {
    const original = memory.getObjectView(strangerId, { kind: 'perception' })!.facts.length;
    const app = memory.listFacts(strangerId).find((f) => f.category === 'appearance')!;
    memory.supersedeFact(app.id, { objectId: strangerId, category: 'appearance', detailLevel: 'visible', content: 'Now in a fine merchant coat.', confidence: 1 });
    const after = memory.getObjectView(strangerId, { kind: 'perception' })!;
    expect(after.facts).toHaveLength(original); // one replaced, not added
    expect(contents(after.facts)).toContain('Now in a fine merchant coat.');
    expect(contents(after.facts)).not.toContain('Tall figure in a rain-soaked grey cloak, face shadowed.');
  });
});
