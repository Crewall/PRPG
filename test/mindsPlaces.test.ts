import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { looseKey, matchObject } from '../src/minds/places.ts';

// Places and things (docs/10 §5.1d): the narrator sees what exists, and its block reuses it.

describe('places and things', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const things = () => h.app.memory.listObjects(h.storyId).filter((o) => o.type !== 'character');
  const narratorAsk = () => h.requests('narrator').at(-1)!.messages.at(-1)!.content;
  const quiet = () => {
    h.script.characters['Marta'] = [...(h.script.characters['Marta'] ?? []), JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [...(h.script.characters['Tom'] ?? []), JSON.stringify({ say: '' })];
  };

  it('the narrator is shown the places and things that exist, with their #handles', async () => {
    h = mindsHarness();
    await h.opening(); // location #broken-wheel, items #ledger
    h.app.memory.updateObject(h.app.memory.findByHandle(h.storyId, 'ledger')!.id, { summary: "Marta's book of debts" });
    quiet();
    h.script.narrator.push(round('Rain.', { briefs: {} }));
    await h.play('I look around.');
    const ask = narratorAsk();
    expect(ask).toContain('Places and things (reuse these #handles):');
    expect(ask).toContain('Here: #broken-wheel (broken wheel)');
    expect(ask).toContain("In view: #ledger (ledger) — Marta's book of debts");
  });

  it('the block matches what exists: an alias in brackets, a possessive spelled differently, a removal', async () => {
    h = mindsHarness();
    await h.opening();
    quiet();
    h.script.narrator.push(
      round('Tom hugs a toy.', {
        briefs: {},
        objects: [
          { name: "Agnes's stuffed rabbit", type: 'item', line: 'worn grey plush' },
          { name: "Caseworker's clipboard", type: 'item', line: 'a thick file' },
        ],
        scene: { items: ["Agnes's stuffed rabbit", "Caseworker's clipboard"] },
      }),
    );
    await h.play('I wait.');
    expect(things().map((o) => o.name).sort()).toEqual(["Agnes's stuffed rabbit", "Caseworker's clipboard", 'broken wheel', 'ledger']);

    quiet();
    h.script.narrator.push(
      round('The caseworker leaves with her clipboard.', {
        briefs: {},
        objects: [
          { name: "Agnes' stuffed rabbit (Bun)", type: 'item', line: 'worn grey plush, one ear stitched back on' },
          { name: "Caseworker's clipboard (removed)", type: 'item', line: '' },
          { name: 'old lantern (gone)', type: 'item', line: '' },
        ],
      }),
    );
    await h.play('I wait.');
    const rabbit = h.app.memory.findByName(h.storyId, "Agnes's stuffed rabbit")!;
    expect(rabbit.aliases).toEqual(['Bun']);
    expect(rabbit.summary).toBe('worn grey plush, one ear stitched back on');
    const clipboard = h.app.memory.findByName(h.storyId, "Caseworker's clipboard")!;
    expect(clipboard.status).toBe('destroyed');
    expect(things()).toHaveLength(4); // nothing new: no "(Bun)" copy, no "(removed)" copy, no lantern
    // Gone things leave the scene and the narrator's list.
    const scene = h.app.stories.getScene(h.app.stories.getStory(h.storyId)!.currentSceneId!)!;
    expect(scene.itemHandles).toEqual([rabbit.handle]);
    quiet();
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I wait.');
    expect(narratorAsk()).not.toContain('clipboard');
  });

  it('"gone": true by #handle', async () => {
    h = mindsHarness();
    await h.opening();
    quiet();
    h.script.narrator.push(round('The ledger burns.', { briefs: {}, objects: [{ name: '#ledger', gone: true }] }));
    await h.play('I burn the ledger.');
    expect(h.app.memory.findByHandle(h.storyId, 'ledger')!.status).toBe('destroyed');
    const scene = h.app.stories.getScene(h.app.stories.getStory(h.storyId)!.currentSceneId!)!;
    expect(scene.itemHandles).toEqual([]);
  });

  it('loose keys and matching', () => {
    h = mindsHarness();
    expect(looseKey("Agnes's stuffed rabbit")).toBe(looseKey("Agnes' Stuffed Rabbit"));
    expect(looseKey('The old mill')).toBe(looseKey('old mill'));
    h.app.memory.createObject({ storyId: h.storyId, type: 'item', name: 'silver locket', aliases: [], summary: '', salience: 0.5, status: 'active' });
    expect(matchObject(h.app, h.storyId, 'Silver Locket (tarnished)').obj?.name).toBe('silver locket');
    expect(matchObject(h.app, h.storyId, 'silver locket (lost)').gone).toBe(true);
    expect(matchObject(h.app, h.storyId, 'brass key').obj).toBeUndefined();
  });

  it('the places API lists things with where they are; a merge moves the scene and the thoughts that mention it', async () => {
    h = mindsHarness();
    await h.opening();
    const dupe = h.app.memory.createObject({ storyId: h.storyId, type: 'item', name: 'debt book', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const marta = h.idOf('Marta');
    h.app.thoughts.insert(h.storyId, marta, { text: 'The debt book is hidden.', tags: [`#${dupe.handle}`], pinned: false, source: 'self' }, null);
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const list = async () => (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/minds/places?advanced=1` })).json() as { name: string; here: boolean; inView: boolean; mentions: number; objectId: string }[];
    const before = await list();
    expect(before.find((p) => p.name === 'broken wheel')!.here).toBe(true);
    expect(before.find((p) => p.name === 'ledger')!.inView).toBe(true);
    expect(before.find((p) => p.name === 'debt book')!.mentions).toBe(1);
    const ledger = before.find((p) => p.name === 'ledger')!;
    const res = await server.inject({ method: 'POST', url: `/api/memory/objects/${ledger.objectId}/merge`, payload: { mergeId: dupe.id } });
    expect(res.statusCode).toBe(200);
    const after = await list();
    expect(after.map((p) => p.name).sort()).toEqual(['broken wheel', 'ledger']);
    expect(after.find((p) => p.name === 'ledger')!.mentions).toBe(1);
    await server.close();
  });
});
