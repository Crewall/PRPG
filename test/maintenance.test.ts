import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { LlmDriver } from '../src/llm/types.ts';
import { NewMemoryObject, NewFact } from '../src/memory/model.ts';

const obj = (o: Record<string, unknown>) => NewMemoryObject.parse(o);
const fact = (f: Record<string, unknown>) => NewFact.parse(f);

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

// Role-plays the cleanup scribe: a certain merge + a likely one on the unify
// pass, and a dedupe/rewrite/summary on the consolidation pass.
function cleanupDriver(ids: { kate: string; woman: string; tom: string; dupFact: string; fragFact: string }): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req) {
      const sys = req.system;
      let text: string;
      if (sys.includes('Identify entries that should be unified')) {
        text = JSON.stringify({
          merges: [
            { keepId: ids.kate, mergeId: ids.woman, certainty: 'certain', reason: 'same character, epithet vs name' },
            { keepId: ids.kate, mergeId: ids.tom, certainty: 'likely', reason: 'possibly the same? (should go to inbox)' },
          ],
        });
      } else if (sys.includes('ONE object\'s')) {
        text = JSON.stringify({
          removeFactIds: [ids.dupFact],
          rewrites: [{ factId: ids.fragFact, content: 'Kate wears a storm-grey cloak over travel leathers.' }],
          summary: 'Kate — a sharp-eyed traveler in a storm-grey cloak.',
        });
      } else {
        text = JSON.stringify({});
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('memory maintenance cleanup', () => {
  let dir: string;
  let app: App | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-maint-'));
  });
  afterEach(() => {
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('unifies duplicate entities and consolidates facts', async () => {
    const ids = { kate: '', woman: '', tom: '', dupFact: '', fragFact: '' };
    app = createApp(config, { driverFactory: () => cleanupDriver(ids), dbPath: join(dir, 'm.db'), startWorker: false });

    const story = app.stories.createStory({ title: 'T' });
    const kate = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'Kate' }));
    const woman = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'the woman' }));
    const tom = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'Old Tom' }));
    ids.kate = kate.id; ids.woman = woman.id; ids.tom = tom.id;

    // Enough facts on Kate to qualify for consolidation (≥8 live).
    const contents = ['Has green eyes.', 'Wears a grey cloak.', 'The cloak is storm-grey.', 'Travels light.', 'Sleeps with a knife.', 'Hums old sea songs.', 'Owes a debt in Port Callow.', 'Wears travel leathers.'];
    const facts = contents.map((c) => app!.memory.addFact(fact({ objectId: kate.id, category: 'appearance', detailLevel: 'visible', content: c })));
    ids.dupFact = facts[2].id; // "storm-grey" duplicate → removed
    ids.fragFact = facts[1].id; // rewritten into the unified statement

    app.jobs.enqueue('memory_maintenance', { storyId: story.id, payload: {} });
    await app.worker.drain();

    // Certain merge applied automatically…
    expect(app.memory.getObject(woman.id)).toBeUndefined();
    expect(app.memory.getObject(kate.id)!.aliases).toContain('the woman');
    // …the doubtful one landed in the inbox instead.
    expect(app.memory.getObject(tom.id)).toBeDefined();
    const pending = app.suggestions.listPending(story.id);
    expect(pending.some((s) => s.type === 'merge' && s.mergeId === tom.id)).toBe(true);

    // Consolidation: duplicate superseded, fragment rewritten, summary refreshed.
    const live = app.memory.listFacts(kate.id);
    expect(live.find((f) => f.id === ids.dupFact)).toBeUndefined();
    expect(live.find((f) => f.id === ids.fragFact)).toBeUndefined(); // superseded by rewrite
    expect(live.some((f) => f.content.includes('storm-grey cloak over travel leathers'))).toBe(true);
    expect(app.memory.getObject(kate.id)!.summary).toContain('sharp-eyed');
  });

  it('survives a failing cleanup model (decay still runs, job completes)', async () => {
    const failing: LlmDriver = { kind: 'anthropic', async chat() { throw new Error('model down'); } };
    app = createApp(config, { driverFactory: () => failing, dbPath: join(dir, 'f.db'), startWorker: false });
    const story = app.stories.createStory({ title: 'T' });
    app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'A' }));
    app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'B' }));
    app.jobs.enqueue('memory_maintenance', { storyId: story.id, payload: {} });
    await app.worker.drain();
    expect(app.jobs.listFailed(story.id)).toHaveLength(0);
  });
});
