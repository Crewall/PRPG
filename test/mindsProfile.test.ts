import { describe, it, expect, afterEach } from 'vitest';
import { mindsHarness, round, fail } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { VariableDef } from '../src/minds/variables.ts';
import { listCalls } from '../src/api/callsView.ts';

// The public profile and the player character (docs/11 §2.1, §2.4), plus the
// Threads view of calls and the Minds scene break.

describe('the public profile and the player character', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  const martaAsk = () => h.requests('character:Marta').at(-1)!.messages.at(-1)!.content;
  const narratorAsk = (i = -1) => h.requests('narrator').at(i)!.messages.at(-1)!.content;

  it('others see name, pronouns, appearance and public values; places and things show their lines', async () => {
    h = mindsHarness();
    h.app.variables.replaceDefs(h.storyId, [
      ...h.app.variables.listDefs(h.storyId),
      VariableDef.parse({ key: 'armed', label: 'Armed', type: 'flag', default: false, visibility: 'public', changedBy: ['narrator'] }),
    ]);
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    h.app.sheets.upsert(h.storyId, kael, { pronouns: 'he/him' });
    h.script.narrator.push(
      round('Rain. A stout woman behind the counter.', {
        cast: { enter: [{ name: 'Marta', pronouns: 'she/her', appearance: 'Stout, flour on her apron.' }] },
        objects: [{ name: 'Broken Wheel', type: 'location', line: 'a smugglers’ inn on the coast road' }, { name: 'ledger', type: 'item', line: 'Marta’s book of debts' }],
        scene: { location: '#broken-wheel', items: ['#ledger'] },
        vars: [{ who: '#kael', key: 'armed', set: true }],
        briefs: { '#marta': '#kael walks in.' },
      }),
    );
    await h.play('');
    expect(h.app.sheets.get(marta())!.pronouns).toBe('she/her');

    h.script.characters['Marta'] = [JSON.stringify({ say: 'Evening.' })];
    h.script.narrator.push(round('She nods.', { briefs: {}, objects: [{ name: '#ledger', line: 'Marta’s book of debts, now hidden' }] }));
    await h.play('"Evening."');
    expect(martaAsk()).toContain(
      'Here: #broken-wheel (Broken Wheel) — a smugglers’ inn on the coast road\n- #kael Kael (he/him) — Tall, rain-soaked. Visibly: armed yes\nIn view: #ledger (ledger — Marta’s book of debts)',
    );
    // The narrator sees the pronouns on every sheet header.
    expect(narratorAsk()).toContain('#marta (Marta, she/her) — Stout, flour on her apron.');
    // An existing object's line is updated by the narrator.
    expect(h.app.memory.findByName(h.storyId, 'ledger')!.summary).toBe('Marta’s book of debts, now hidden');
    // Marta's own system prompt carries her pronouns with her look.
    expect(h.requests('character:Marta')[0].system).toContain('Pronouns: she/her. Stout, flour on her apron.');
  });

  it('a story without a player character: the narrator is asked for one, and everyone sees it from then on', async () => {
    h = mindsHarness({ player: false });
    h.script.narrator.push(
      round('You step out of the rain. Behind the counter, a stout woman.', {
        player: { name: 'Rin', pronouns: 'she/her', appearance: 'Short, sea-green coat, a scar on the chin.' },
        cast: { enter: [{ name: 'Marta', pronouns: 'she/her', appearance: 'Stout.' }] },
        briefs: { '#marta': '#rin steps in out of the rain.' },
      }),
    );
    const c = await h.play('');
    expect(narratorAsk(0)).toContain('The player has no character yet. In the block, add "player"');
    const rin = h.app.sheets.player(h.storyId)!;
    expect(h.app.memory.getObject(rin.objectId)!.name).toBe('Rin');
    expect(rin).toMatchObject({ isPlayer: true, pronouns: 'she/her', appearance: 'Short, sea-green coat, a scar on the chin.' });
    expect(h.app.stories.getStory(h.storyId)!.settings.playerObjectId).toBe(rin.objectId);
    expect(c.final?.meta.blockProblems).toBeUndefined();

    h.script.characters['Marta'] = [JSON.stringify({ say: 'Room?' })];
    h.script.narrator.push(round('She looks you over.', { briefs: {} }));
    await h.play('"Hello."');
    expect(martaAsk()).toContain('- #rin Rin (she/her) — Short, sea-green coat, a scar on the chin.');
    expect(martaAsk()).toContain('Right now:\n#rin Rin: "Hello."'); // the player has a name and a handle now
    expect(narratorAsk()).not.toContain('no character yet');
  });

  it('the narrator only fills what is empty, and cannot turn a present character into the player', async () => {
    h = mindsHarness();
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    h.script.narrator.push(round('Rain.', { player: { pronouns: 'he/him', appearance: 'A different look.' }, cast: { enter: [{ name: 'Marta', appearance: 'Stout.' }] }, briefs: {} }));
    await h.play('');
    expect(narratorAsk(0)).toContain("The player character's sheet lacks pronouns: add it in the block's \"player\" field");
    expect(h.app.sheets.get(kael)).toMatchObject({ pronouns: 'he/him', appearance: 'Tall, rain-soaked.' }); // the user's look stays

    // A story without a player: the narrator may not make Marta the player.
    const h2 = mindsHarness({ player: false });
    try {
      h2.script.narrator.push(round('Rain.', { cast: { enter: [{ name: 'Marta', appearance: 'Stout.' }] }, briefs: {} }));
      await h2.play('');
      h2.script.characters['Marta'] = [JSON.stringify({ say: '' })];
      h2.script.narrator.push(round('Quiet.', { player: { name: 'Marta' }, briefs: {} }));
      const c = await h2.play('I wait.');
      expect(h2.app.sheets.player(h2.storyId)).toBeUndefined();
      expect((c.final?.meta.blockProblems as string[]).join(' ')).toMatch(/player: 'Marta' is already someone else/);
    } finally {
      h2.close();
    }
  });

  it('the seeder fills pronouns only when empty', async () => {
    h = mindsHarness();
    h.script.narrator.push(round('Rain.', { cast: { enter: [{ name: 'Marta', appearance: 'Stout.' }, { name: 'Tom', pronouns: 'he/him', appearance: 'Thin.' }] }, briefs: {} }));
    await h.play('');
    h.script.seeder.push(JSON.stringify({ description: 'Marta runs the inn.', pronouns: 'she/her' }), JSON.stringify({ description: 'Tom drinks.', pronouns: 'they/them' }));
    await h.app.worker.drain();
    expect(h.app.sheets.get(h.idOf('Marta'))!.pronouns).toBe('she/her');
    expect(h.app.sheets.get(h.idOf('Tom'))!.pronouns).toBe('he/him');
  });

  it('a brief that says he/she without a #handle reaches its reader, and the narrator gets a reminder', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('He goes upstairs.', { briefs: { '#tom': 'He goes upstairs to her room.', '#marta': '#kael goes upstairs.' } }));
    const c = await h.play('I go upstairs.');
    expect(h.app.threads.pending(h.sessionOf(h.idOf('Tom'))).at(-1)!.content).toBe('He goes upstairs to her room.');
    expect((c.final?.meta.blockProblems as string[]).join(' ')).toMatch(/he\/she without a #handle \(#tom Tom\)/);
    h.script.characters['Marta'].push(JSON.stringify({ say: '' }));
    h.script.characters['Tom'].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('Night.', { briefs: {} }));
    await h.play('I sleep.');
    expect(narratorAsk()).toContain('Note: your briefs for #tom Tom said he/she without naming anyone by #handle.');
  });

  it('thoughts carry the in-story time they were written', async () => {
    h = mindsHarness();
    await h.opening(); // the clock moves to 08:15
    h.script.characters['Marta'] = [JSON.stringify({ say: '', remember: [{ text: 'Kael watches my hands.', tags: ['#kael'] }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I watch her.');
    const t = h.app.thoughts.list(h.storyId, marta())[0];
    expect(t.createdClockMin).toBe(8 * 60 + 15);
  });
});

describe('the Threads view and Minds scenes', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  it('lists each call once: whose mind, turn and game time, request with response, and why it failed', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Yes?' })];
    h.script.characters['Tom'] = [fail('model timeout')];
    h.script.narrator.push(round('Marta looks up.', { briefs: {} }));
    await h.play('"Hello."');
    const calls = listCalls(h.app, h.storyId);
    const turn2 = calls.filter((c) => c.turnIndex === 1);
    expect(turn2.map((c) => `${c.mind}:${c.status}`).sort()).toEqual(['Marta:done', 'Narrator:done', 'Tom:failed']);
    const tom = turn2.find((c) => c.mind === 'Tom')!;
    expect(tom.error).toMatch(/model timeout/);
    expect(tom.response).not.toBeNull();
    const narrator = turn2.find((c) => c.mind === 'Narrator')!;
    expect(narrator.gameTime).toBe('Day 1, 08:20');
    expect(narrator.request.direction).toBe('request');
    expect(narrator.response!.direction).toBe('response');
    expect(calls[0].startedAt).toBeGreaterThanOrEqual(calls.at(-1)!.startedAt); // newest first
  });

  it('a Minds scene break queues no classic summary job', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Later, upstairs.', { briefs: {}, scene: { break: true, title: 'Upstairs' } }));
    await h.play('I go to my room.');
    const scribe = h.app.db.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'scribe_story'`).get<{ n: number }>()!.n;
    expect(scribe).toBe(0);
  });
});
