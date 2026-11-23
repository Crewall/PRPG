import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { VariableDef, STATE_KEY } from '../src/minds/variables.ts';
import { applyChanges, applyThoughtOps, createCharacter } from '../src/minds/service.ts';
import {
  buildCharacterCall,
  buildNarratorCall,
  commitCall,
  queueForCharacter,
  mergeAdjacent,
  NARRATOR_OWNER,
} from '../src/minds/builders.ts';
import type { ThreadDeps, HereInfo, PreparedCall } from '../src/minds/builders.ts';
import { scriptedDriver } from './fixtures/drivers.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

const defs = [
  { key: 'health', label: 'Health', type: 'number', min: 0, max: 10, default: 10, bands: [{ upTo: 5, label: 'hurt' }, { upTo: 10, label: 'fine' }], visibility: 'self', changedBy: ['narrator'] },
  { key: 'resolve', label: 'Resolve', type: 'number', min: 0, max: 10, default: 6, maxStep: 2, visibility: 'self', changedBy: ['self', 'narrator'], description: 'Will to keep going', changeGuide: 'Change when shaken or steadied.' },
  { key: 'trust_in_player', label: 'Trust', type: 'number', min: 0, max: 100, default: 50, appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'] },
  { key: 'rank', label: 'Rank', type: 'choice', options: ['innkeeper', 'informant'], default: 'innkeeper', visibility: 'public', changedBy: ['narrator'] },
  { key: 'alarm', label: 'Alarm', type: 'number', min: 0, max: 5, scope: 'world', visibility: 'public', changedBy: ['narrator'] },
  { key: 'plot_clock', label: 'Plot clock', type: 'number', min: 0, max: 8, scope: 'world', visibility: 'hidden', changedBy: ['narrator'] },
].map((d) => VariableDef.parse(d));

/** The test is `earlier` a byte-exact prefix of `later` (system identical, messages a prefix). */
function expectPrefix(earlier: PreparedCall, later: PreparedCall) {
  expect(later.ctx.system).toBe(earlier.ctx.system);
  const n = earlier.ctx.messages.length;
  expect(later.ctx.messages.slice(0, n)).toEqual(earlier.ctx.messages);
  const a = JSON.stringify(earlier.ctx.messages).slice(0, -1); // drop the closing ']'
  expect(JSON.stringify(later.ctx.messages).startsWith(a)).toBe(true);
}

describe('mergeAdjacent', () => {
  it('joins same-role neighbours with one fixed rule', () => {
    expect(
      mergeAdjacent([
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
        { role: 'user', content: 'd' },
      ]),
    ).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ]);
  });
});

describe('Minds thread builders', () => {
  let dir: string;
  let app: App;
  let deps: ThreadDeps;
  let storyId: string;
  let pc: string, marta: string, tom: string;
  let here: (oid: string) => HereInfo;
  const turn = () => app.stories.appendTurn({ storyId, playerInput: 'x', status: 'complete' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-threads-'));
    app = createApp(config, { driverFactory: () => scriptedDriver([]), dbPath: join(dir, 't.db'), startWorker: false });
    deps = {
      stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts,
      db: app.db, agents: app.agents, threads: app.threads,
    };
    storyId = app.stories.createStory({ title: 'Inn', settings: { engine: 'minds', premise: 'A tavern on a smugglers’ road.', minds: { narratorNotes: 'Tom is the real informant.' } } as never }).id;
    app.variables.replaceDefs(storyId, defs);
    pc = createCharacter(deps, storyId, { name: 'Hero', isPlayer: true, appearance: 'Tall, travel-worn.', description: 'A sellsword.' }).objectId;
    marta = createCharacter(deps, storyId, { name: 'Marta', appearance: 'Stout, flour on her apron.', description: 'Innkeeper. Keeps the smugglers’ ledger. MARTA-SECRET.' }).objectId;
    tom = createCharacter(deps, storyId, { name: 'Tom', appearance: 'Thin, nervous.', description: 'A regular. TOM-SECRET.' }).objectId;
    const people = { [pc]: ['hero', 'Hero', 'Tall, travel-worn.'], [marta]: ['marta', 'Marta', 'Stout, flour on her apron.'], [tom]: ['tom', 'Tom', 'Thin, nervous.'] };
    here = (oid) => ({
      location: { handle: 'tavern', name: 'The Broken Wheel' },
      present: Object.entries(people).filter(([id]) => id !== oid).map(([, [handle, name, appearance]]) => ({ handle, name, appearance })),
      items: [{ handle: 'ledger', name: 'ledger' }],
    });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a character thread only appends: each request is a byte-exact prefix of the next', () => {
    const t1 = turn();
    queueForCharacter(deps, storyId, marta, 'You see a tall stranger shake rain from his cloak.\nHeard: Hero: "A room, and a word about a ledger."', t1.id);
    const r1 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    expect(r1.ctx.messages).toHaveLength(1);
    expect(r1.roundMessage).toContain('Since you last acted:');
    commitCall(deps, r1, '{"say":"Rooms are upstairs.","intent":"slide the ledger under the counter"}', t1.id);

    const t2 = turn();
    queueForCharacter(deps, storyId, marta, 'The stranger leans closer.', t2.id);
    const r2 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    expectPrefix(r1, r2);
    expect(r2.ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r2.roundMessage).toContain('The stranger leans closer.');
    expect(r2.roundMessage).not.toContain('shake rain'); // delivered once, never again
    commitCall(deps, r2, '{"say":"No ledgers here."}', t2.id);

    const r3 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    expectPrefix(r2, r3);
  });

  it('the narrator thread only appends too', () => {
    const t1 = turn();
    const n1 = buildNarratorCall(deps, { storyId, player: { say: 'A room, please.' }, presentIds: [marta, tom], declarations: [{ objectId: marta, status: 'acted', say: 'Upstairs.' }] });
    commitCall(deps, n1, 'She points upstairs.\n```round\n{"briefs":{}}\n```', t1.id);
    const n2 = buildNarratorCall(deps, { storyId, player: { do: 'climb the stairs' }, presentIds: [marta, tom], declarations: [] });
    expectPrefix(n1, n2);
    expect(n2.ctx.system).toContain('Tom is the real informant.');
  });

  it('isolation: each mind sees its own sheet and visible variables only; the narrator sees everything', () => {
    applyChanges(deps, storyId, [
      { change: { holder: marta, key: STATE_KEY, op: 'set', value: 'Nervous, wiping the same mug.' }, by: 'narrator' },
      { change: { holder: marta, key: 'trust_in_player', op: 'set', value: 35 }, by: 'narrator' },
      { change: { holder: tom, key: 'resolve', op: 'set', value: 3 }, by: 'narrator' },
      { change: { holder: 'world', key: 'plot_clock', op: 'set', value: 4 }, by: 'narrator' },
    ]);
    const m = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    const mText = m.ctx.system + '\n' + m.roundMessage;
    expect(m.ctx.system).toContain('MARTA-SECRET'); // her own description, in her frozen system prompt
    expect(mText).not.toContain('TOM-SECRET');
    expect(mText).toContain('"Nervous, wiping the same mug."'); // her state
    expect(mText).toContain('health 10/10 (fine)');
    expect(m.ctx.system).toContain('resolve (0–10): Will to keep going. YOU may change it, by at most 2 per round. Change when shaken or steadied.');
    expect(mText).not.toContain('trust_in_player'); // hidden even from its holder
    expect(mText).not.toContain('plot_clock'); // hidden world variable
    expect(mText).not.toContain('resolve 4'); // Tom's private value
    expect(m.roundMessage).toContain('#tom Tom — Thin, nervous.'); // others: appearance only
    expect(m.roundMessage).toContain('The world: alarm 0/5');

    const n = buildNarratorCall(deps, { storyId, player: {}, presentIds: [marta, tom], declarations: [] });
    const nText = n.ctx.system + '\n' + n.roundMessage;
    // Tom's resolve: the narrator asked for 3, maxStep 2 per round clamped it to 6 - 2 = 4.
    for (const s of ['MARTA-SECRET', 'TOM-SECRET', 'hidden: trust_in_player 35/100', 'resolve 4/10', 'hidden: plot_clock 4/8', 'Nervous, wiping the same mug.']) {
      expect(nText).toContain(s);
    }
    expect(n.ctx.system).toContain('trust_in_player (0–100; every non-player character; hidden from its holder; changed by you)');
  });

  it('recall: unseen pinned thoughts once, tagged thoughts when evoked, own fresh thoughts never repeated', () => {
    const seedTurn = turn();
    applyThoughtOps(deps, storyId, marta, { remember: [
      { text: 'I keep the smugglers’ ledger under the counter.', tags: [], pin: false }, // untagged → pinned
      { text: 'Tom owes me three silver.', tags: ['#tom', 'debt'], pin: false },
      { text: 'The old mill is where the crates go.', tags: ['old-mill'], pin: false },
    ] }, 'seed', seedTurn.id);

    const t1 = turn();
    queueForCharacter(deps, storyId, marta, 'Someone mentions the old mill in passing.', t1.id);
    const r1 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    expect(r1.roundMessage).toContain('Always on your mind:\nt1 · Day 1, 08:00 · 5/10 I keep the smugglers’ ledger under the counter.');
    expect(r1.roundMessage).toContain('t2 · Day 1, 08:00 · 5/10 [#tom, debt] Tom owes me three silver.'); // #tom is present
    expect(r1.roundMessage).toContain('t3 · Day 1, 08:00 · 5/10 [old-mill] The old mill'); // mentioned in what she perceived
    commitCall(deps, r1, '{"say":"","remember":[{"text":"The stranger wants the ledger.","tags":["ledger"]}]}', t1.id);
    applyThoughtOps(deps, storyId, marta, { remember: [{ text: 'The stranger wants the ledger.', tags: ['ledger'], pin: false }] }, 'self', t1.id);

    const t2 = turn();
    queueForCharacter(deps, storyId, marta, 'The ledger is mentioned again, and the old mill.', t2.id);
    const r2 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta), situationTags: ['debt'] });
    expect(r2.roundMessage).not.toContain('Always on your mind'); // t1 already in her thread
    expect(r2.roundMessage).not.toContain('You recall'); // t2, t3 shown; t4 is in her own reply
  });

  it('reports the character’s rejected or adjusted proposals in its next round message', () => {
    const t1 = turn();
    const r1 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    commitCall(deps, r1, '{"say":"","vars":[{"key":"health","set":2},{"key":"resolve","set":10}]}', t1.id);
    applyChanges(deps, storyId, [
      { change: { holder: marta, key: 'health', op: 'set', value: 2 }, by: 'self', proposer: marta },
      { change: { holder: marta, key: 'resolve', op: 'set', value: 10 }, by: 'self', proposer: marta },
    ], t1.id);
    const r2 = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    expect(r2.roundMessage).toContain("Not applied: you can't change 'health'.");
    expect(r2.roundMessage).toContain('Adjusted: resolve became 8 (limits).');
    expect(r2.roundMessage).toContain('resolve 8/10');
  });

  it('preview equals the real call, and building has no side effects', () => {
    const t1 = turn();
    queueForCharacter(deps, storyId, tom, 'Marta glares at you.', t1.id);
    applyThoughtOps(deps, storyId, tom, { remember: [{ text: 'Marta suspects me.', tags: [], pin: false }] }, 'seed', t1.id);
    const a = buildCharacterCall(deps, { storyId, objectId: tom, here: here(tom) });
    const b = buildCharacterCall(deps, { storyId, objectId: tom, here: here(tom) });
    expect(b).toEqual(a);
    expect(app.threads.pending(a.sessionId)).toHaveLength(1);
    expect(app.thoughts.list(storyId, tom)[0].lastRecalledTurnId).toBeNull();
  });

  it('rewind undoes a committed round: log rows, deliveries and recall marks', () => {
    const t0 = turn();
    queueForCharacter(deps, storyId, marta, 'Brief from before.', t0.id);
    applyThoughtOps(deps, storyId, marta, { remember: [{ text: 'Pinned before.', tags: [], pin: false }] }, 'seed', t0.id);
    const t1 = turn();
    app.snapshots.capture(storyId, t1.id, t1.index);
    const r = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    commitCall(deps, r, '{"say":"hm"}', t1.id);
    expect(app.threads.pending(r.sessionId)).toHaveLength(0);

    expect(app.snapshots.restore(storyId, t1.id)).toBe(true);
    expect(app.threads.log(r.sessionId)).toHaveLength(0);
    expect(app.threads.pending(r.sessionId).map((p) => p.content)).toEqual(['Brief from before.']);
    expect(app.thoughts.list(storyId, marta)[0].lastRecalledTurnId).toBeNull();
    expect(buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) })).toEqual(r); // same call again
  });

  it('POV endpoints: the thread as experienced, and the next prompt equal to the builder', async () => {
    const server = Fastify();
    await registerHttpRoutes(server, app);
    const t1 = turn();
    queueForCharacter(deps, storyId, marta, 'A stranger enters.', t1.id);
    const call = buildCharacterCall(deps, { storyId, objectId: marta, here: here(marta) });
    commitCall(deps, call, '{"say":"Welcome."}', t1.id);

    const pov = (await server.inject({ method: 'GET', url: `/api/stories/${storyId}/pov/${marta}` })).json();
    expect(pov.log.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(pov.log[1].content).toBe('{"say":"Welcome."}');

    const next = (await server.inject({ method: 'GET', url: `/api/stories/${storyId}/pov/${NARRATOR_OWNER}/prompt?which=next` })).json();
    expect(next.system).toContain('You are the **Narrator**');
    expect((await server.inject({ method: 'GET', url: `/api/stories/${storyId}/pov/nobody/prompt` })).statusCode).toBe(404);
    await server.close();
  });
});
