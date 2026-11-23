import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { VariableDef, relationHolder, validateDefs } from '../src/minds/variables.ts';
import { applyChanges, holdersFor } from '../src/minds/service.ts';

// Relation variables (docs/11 §4.9): a value per pair of characters who have met.

const TRUST = VariableDef.parse({ key: 'trust', label: 'Trust', type: 'number', min: 0, max: 10, default: 5, scope: 'relation', visibility: 'self', changedBy: ['narrator', 'self'], description: 'how much they trust that person' });
const RIVALRY = VariableDef.parse({ key: 'rivalry', label: 'Rivalry', type: 'number', min: 0, max: 10, default: 0, scope: 'relation', mutual: true, visibility: 'public', changedBy: ['narrator'] });

describe('relation variables', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const kael = () => h.app.sheets.player(h.storyId)!.objectId;
  const marta = () => h.idOf('Marta');
  const tom = () => h.idOf('Tom');
  const withDefs = (...defs: VariableDef[]) => h.app.variables.replaceDefs(h.storyId, [...h.app.variables.listDefs(h.storyId), ...defs]);
  const quiet = () => {
    h.script.characters['Marta'] = [...(h.script.characters['Marta'] ?? []), JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [...(h.script.characters['Tom'] ?? []), JSON.stringify({ say: '' })];
  };

  it('pairs exist once characters have shared a round; the narrator changes one side with "to"', async () => {
    h = mindsHarness();
    withDefs(TRUST);
    await h.opening();
    expect(h.app.met.met(marta(), kael())).toBe(true);
    expect(h.app.met.met(marta(), tom())).toBe(true);
    const holders = holdersFor(h.app, h.storyId);
    expect(holders.has(`${marta()}>${kael()}`) && holders.has(`${kael()}>${marta()}`)).toBe(true);

    quiet();
    h.script.narrator.push(round('Marta eyes you.', { briefs: {}, vars: [{ who: '#marta', to: '#kael', key: 'trust', delta: -2, why: 'he lied' }, { who: '#tom', key: 'trust', set: 1 }] }));
    const c = await h.play('"I am a merchant."');
    expect(h.app.variables.getValue(h.storyId, 'trust', `${marta()}>${kael()}`)).toBe(3);
    expect(h.app.variables.getValue(h.storyId, 'trust', `${kael()}>${marta()}`)).toBeUndefined(); // one-way
    expect((c.final?.meta.blockProblems as string[]).join(' ')).toContain(`'trust' needs "to"`);

    // Next round: Marta sees her own side toward those present; the narrator sees everyone's.
    h.script.characters['Marta'] = [JSON.stringify({ say: '', vars: [{ key: 'trust', to: '#tom', delta: 1 }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {}, spotlight: ['#marta'] }));
    await h.play('I wait.');
    const ask = h.requests('character:Marta').at(-1)!.messages.at(-1)!.content;
    expect(ask).toContain('Toward others: trust → #kael 3/10, #tom 5/10');
    const sys = h.requests('character:Marta').at(-1)!.system;
    expect(sys).toContain('- trust (0–10), yours toward each person you have met: how much they trust that person. YOU may change your own (with "to": their #handle).');
    const nar = h.requests('narrator').at(-1)!.messages.at(-1)!.content;
    expect(nar).toMatch(/#marta \(Marta[^\n]*\n(?:[^\n]*\n)*? {2}Toward others: trust → #kael 3\/10, #tom 5\/10/);
    expect(h.app.variables.getValue(h.storyId, 'trust', `${marta()}>${tom()}`)).toBe(6); // her own change
  });

  it('a character changes only its own side; a pair that never met has no value', async () => {
    h = mindsHarness();
    withDefs(TRUST);
    await h.opening();
    const stranger = h.app.memory.createObject({ storyId: h.storyId, type: 'character', name: 'Held', aliases: [], summary: '', salience: 0.5, status: 'active' }).id;
    h.app.sheets.upsert(h.storyId, stranger, {});
    const out = applyChanges(h.app, h.storyId, [
      { change: { holder: `${tom()}>${marta()}`, key: 'trust', op: 'set', value: 9 }, by: 'self', proposer: marta() },
      { change: { holder: `${marta()}>${stranger}`, key: 'trust', op: 'set', value: 9 }, by: 'narrator' },
    ]);
    expect(out.map((o) => `${o.result}: ${o.reason}`)).toEqual([
      "rejected: you can only change your own 'trust'",
      "rejected: 'trust' does not apply to this pair (have they met?)",
    ]);
  });

  it('a mutual variable is one shared value; rewind forgets who met', async () => {
    h = mindsHarness();
    withDefs(RIVALRY);
    await h.opening();
    quiet();
    h.script.narrator.push(round('Tom glares at Marta.', { briefs: {}, vars: [{ who: '#tom', to: '#marta', key: 'rivalry', set: 4 }] }));
    await h.play('I watch.');
    const hid = relationHolder(RIVALRY, marta(), tom());
    expect(hid).toBe(relationHolder(RIVALRY, tom(), marta()));
    expect(h.app.variables.getValue(h.storyId, 'rivalry', hid)).toBe(4);

    expect(h.app.met.pairs(h.storyId).length).toBe(3);
    await h.app.pipeline.rewind(h.storyId);
    await h.app.pipeline.rewind(h.storyId);
    expect(h.app.met.pairs(h.storyId).length).toBe(0);
  });

  it('the API shows relations on a sheet and edits them; the change log names the pair', async () => {
    h = mindsHarness();
    withDefs(TRUST);
    await h.opening();
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const view = async (adv: boolean) => (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/minds${adv ? '?advanced=1' : ''}` })).json().characters as { objectId: string; relations?: { other: string; values: { holder: string; value: unknown }[] }[] }[];
    const m = (await view(true)).find((c) => c.objectId === marta())!;
    expect(m.relations!.map((r) => r.other).sort()).toEqual([kael(), tom()].sort());
    expect((await view(false)).find((c) => c.objectId === marta())!.relations).toBeUndefined(); // not the player's own
    expect((await view(false)).find((c) => c.objectId === kael())!.relations!.length).toBe(2); // the player's own side

    const holder = m.relations!.find((r) => r.other === kael())!.values[0].holder;
    const res = await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/variables/values`, payload: { changes: [{ holder, key: 'trust', value: 8 }] } });
    expect(res.json()[0].result).toBe('applied');
    const log = (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/variables/changes` })).json() as { holderName: string }[];
    expect(log[0].holderName).toBe('Marta → Kael');
    await server.close();
  });

  it('the seeder sets values toward people it names', async () => {
    h = mindsHarness();
    withDefs(TRUST);
    await h.opening();
    h.script.seeder.push(JSON.stringify({ description: 'Marta.', values: { trust: { '#tom': 2, '#kael': 4 } } }), JSON.stringify({ description: 'Tom.' }));
    await h.app.worker.drain();
    expect(h.app.variables.getValue(h.storyId, 'trust', `${marta()}>${tom()}`)).toBe(2);
    expect(h.app.variables.getValue(h.storyId, 'trust', `${marta()}>${kael()}`)).toBe(4);
    expect(h.requests('seeder')[0].messages[0].content).toContain('- trust (0–10; toward each person they have met, as { "#handle": value }');
  });
});

describe('relation definitions', () => {
  it('only a relation variable can be mutual', () => {
    expect(() => validateDefs([VariableDef.parse({ key: 'x', label: 'X', type: 'flag', mutual: true })])).toThrow(/only a relation variable can be mutual/);
  });
});
