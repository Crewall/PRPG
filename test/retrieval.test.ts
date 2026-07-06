import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createMemoryStore } from '../src/db/stores/memoryStore.ts';
import type { MemoryStore } from '../src/db/stores/memoryStore.ts';
import { searchFacts } from '../src/memory/retrieval.ts';

describe('searchFacts retrieval (Layer 3c)', () => {
  let db: Db;
  let memory: MemoryStore;
  let archiveId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(`INSERT INTO stories (id,title,settings_json,status,created_at,updated_at) VALUES ('s','t','{}','active',?,?)`).run(now, now);
    memory = createMemoryStore(db);

    const archive = memory.createObject({ storyId: 's', type: 'location', name: 'The Grand Archive', aliases: ['the archive'], summary: 'A vast library.', salience: 0.8, status: 'active' });
    archiveId = archive.id;
    memory.addFact({ objectId: archiveId, category: 'contents', detailLevel: 'known', content: 'The forbidden solstice scrolls are kept in the sealed east wing.', confidence: 1 });
    // A secret fact about a different object, only the storyteller/knowers see it.
    const cult = memory.createObject({ storyId: 's', type: 'faction', name: 'Ashen Hand', aliases: [], summary: '', salience: 0.6, status: 'active' });
    const secret = memory.addFact({ objectId: cult.id, category: 'goals', detailLevel: 'secret', content: 'The Ashen Hand plans to torch the solstice scrolls.', confidence: 1 });
    // No player link on the secret.
    void secret;
  });
  afterEach(() => db.close());

  it('entity pass returns a whole scoped view for a named object', () => {
    const res = searchFacts(memory, 's', { kind: 'player' }, 'I walk toward the archive', {});
    expect(res.entities.some((e) => e.id === archiveId)).toBe(true);
  });

  it('FTS pass surfaces a fact by content term even when the object is not named', () => {
    // "solstice scrolls" is not an object name; it lives in fact content.
    const res = searchFacts(memory, 's', { kind: 'storyteller' }, 'tell me about the solstice scrolls', {});
    const allText = [...res.entities.flatMap((e) => e.facts.map((f) => f.content)), ...res.facts.map((f) => f.content)].join(' | ');
    expect(allText).toContain('solstice scrolls');
  });

  it('scope filtering hides a secret fact from the player but not the storyteller', () => {
    const asPlayer = searchFacts(memory, 's', { kind: 'player' }, 'what about torching the solstice scrolls', {});
    const asStory = searchFacts(memory, 's', { kind: 'storyteller' }, 'what about torching the solstice scrolls', {});
    const playerText = asPlayer.facts.map((f) => f.content).join(' ');
    const storyText = asStory.facts.map((f) => f.content).join(' ');
    expect(playerText).not.toContain('Ashen Hand plans to torch');
    expect(storyText).toContain('Ashen Hand plans to torch');
  });

  it('an old fact absent from summaries is still retrievable when relevant', () => {
    // Simulates a fact established 80 turns ago: it lives only in memory, not in
    // any summary. A query about it retrieves it.
    const res = searchFacts(memory, 's', { kind: 'storyteller' }, 'is anything stored in the sealed east wing?', {});
    const text = [...res.entities.flatMap((e) => e.facts.map((f) => f.content)), ...res.facts.map((f) => f.content)].join(' ');
    expect(text).toContain('east wing');
  });

  it('respects the token budget', () => {
    for (let i = 0; i < 50; i++) {
      memory.addFact({ objectId: archiveId, category: 'history', detailLevel: 'visible', content: `Historical note number ${i} about the archive and its long dusty past.`, confidence: 1 });
    }
    const res = searchFacts(memory, 's', { kind: 'storyteller' }, 'the archive', { maxTokens: 200, perObjectTokens: 150 });
    const totalChars = res.entities.flatMap((e) => e.facts).length + res.facts.length;
    expect(totalChars).toBeLessThan(50); // budget kept it well under the full set
  });
});
