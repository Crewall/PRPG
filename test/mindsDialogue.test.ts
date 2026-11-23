import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mindsHarness, round, textOf } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { renderDialogueLine } from '../src/minds/dialogue.ts';
import { parseDialogueReply } from '../src/minds/contracts.ts';

// Dialogue mode (docs/10 §7): each exchange is its own turn that calls only the
// partner; the next normal round is the narrator's wrap-up.

describe('dialogue contracts', () => {
  it('renders a reply as one chat line', () => {
    expect(renderDialogueLine('Marta', { say: 'Two silver.', gesture: 'wipes the counter' })).toBe('Marta: "Two silver." (wipes the counter)');
    expect(renderDialogueLine('Marta', { say: '', gesture: '(shrugs)' })).toBe('Marta: (shrugs)');
    expect(renderDialogueLine('Marta', { say: ' ', gesture: '' })).toBe('Marta says nothing.');
  });

  it('parses replies leniently and clamps them', () => {
    const r = parseDialogueReply({ say: 'word '.repeat(600), gesture: null, act: '  ', remember: [{ text: 'x', tags: ['a'] }], state: 7 });
    expect(r.say.split(' ')).toHaveLength(480); // the exchange holds it to the floor's limit
    expect(r.gesture).toBe('');
    expect(r.act).toBeUndefined(); // blank = no act
    expect(r.state).toBeUndefined();
    expect(r.problems.join(' ')).toMatch(/state/);
    expect(r.remember).toEqual([{ text: 'x', tags: ['a'], pin: false }]);
  });
});

describe('dialogue mode through the pipeline', () => {
  let h: MindsHarness;
  beforeEach(() => {
    h = mindsHarness();
  });
  afterEach(() => h.close());

  const talk = (input: string, partner: string) => h.play(input, { dialogue: { partner } });

  it('an exchange calls only the partner, streams its line, and stores it in its thread', async () => {
    await h.opening();
    const marta = h.idOf('Marta');
    const tom = h.idOf('Tom');
    const clock = h.app.stories.getStory(h.storyId)!.clockMin;
    const before = h.seen.length;
    h.script.characters['Marta'] = [
      JSON.stringify({ say: 'Two silver.', gesture: 'wipes the counter', state: 'Wary.', remember: [{ text: 'He wants a room.', tags: ['#kael'] }] }),
    ];
    const c = await talk('"Got a room?" I lean on the counter. ((keep it short))', marta);
    expect(c.errors).toEqual([]);

    // Nobody but Marta was asked: no narrator, no Tom.
    expect(h.seen.slice(before).map((s) => s.agent)).toEqual(['character:Marta']);
    const ask = h.requests('character:Marta')[0].messages.at(-1)!.content;
    expect(ask).toContain('A tall stranger walks in out of the rain.'); // her waiting brief is delivered too
    expect(ask).toContain('#kael Kael: "Got a room?" (I lean on the counter.)');
    expect(ask).not.toContain('keep it short'); // the OOC note is for the narrator only
    expect(ask).toContain('You are in a direct conversation with #kael Kael.');

    // The player reads the line; the turn records the exchange.
    expect(c.final?.narration).toBe('Marta: "Two silver." (wipes the counter)');
    expect(c.deltas.join('')).toBe(c.final?.narration);
    expect(c.final?.meta).toMatchObject({ engine: 'minds', mode: 'dialogue', partner: marta, reply: { say: 'Two silver.', gesture: 'wipes the counter', state: 'Wary.' } });
    expect(h.app.stories.getStory(h.storyId)!.clockMin).toBe(clock + 1);

    // Her mind: state, thought, thread (stored byte-exact), pending cleared.
    expect(h.app.sheets.get(marta)!.state).toBe('Wary.');
    expect(h.app.thoughts.list(h.storyId, marta).map((t) => t.text)).toEqual(['He wants a room.']);
    const log = h.app.threads.log(h.sessionOf(marta));
    expect(log).toHaveLength(2);
    expect(log[1].content).toBe(JSON.stringify({ say: 'Two silver.', gesture: 'wipes the counter', state: 'Wary.', remember: [{ text: 'He wants a room.', tags: ['#kael'] }] }));
    expect(h.app.threads.pending(h.sessionOf(marta))).toHaveLength(0);
    // Tom is untouched.
    expect(h.app.threads.pending(h.sessionOf(tom)).map((p) => p.content)).toEqual(['A tall stranger walks in; Marta stiffens.']);
  });

  it('exchanges append to the partner thread; the next normal round wraps the conversation up', async () => {
    await h.opening();
    const marta = h.idOf('Marta');
    const tom = h.idOf('Tom');
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.', gesture: 'wipes the counter' }), JSON.stringify({ say: 'Coin first.' })];
    await talk('"Got a room?"', marta);
    await talk('"Here." I set down two coins.', marta);
    const [r1, r2] = h.requests('character:Marta');
    expect(r2.system).toBe(r1.system);
    expect(r2.messages.slice(0, r1.messages.length)).toEqual(r1.messages); // append-only: a cache hit
    expect(h.requests('narrator')).toHaveLength(1); // only the opening

    // Ending = an empty normal message. The narrator alone wraps it up.
    h.script.narrator.push(
      round('Marta pockets the coins and slides a key across. By the fire, Tom has heard every word.', {
        briefs: { '#marta': 'Kael takes the key.', '#tom': 'You overheard Kael pay Marta for a room.' },
      }),
    );
    const c = await h.play('');
    expect(c.errors).toEqual([]);
    expect(h.requests('character:Marta')).toHaveLength(2);
    expect(h.requests('character:Tom')).toHaveLength(0);
    expect(c.final?.meta).toMatchObject({ mode: 'wrapup', partner: marta, gate: { called: [], idle: [marta, tom], reasons: {} } });

    const nAsk = h.requests('narrator')[1].messages.at(-1)!.content;
    expect(nAsk).toContain('A direct conversation between #kael Kael and #marta Marta just ended:');
    expect(nAsk).toContain('- #kael Kael: "Got a room?"\n- #marta Marta: "Two silver." (wipes the counter)\n- #kael Kael: "Here." (I set down two coins.)\n- #marta Marta: "Coin first."');
    expect(nAsk).toContain('give every other present character a brief of what they overheard');
    expect(h.app.threads.pending(h.sessionOf(tom)).at(-1)!.content).toBe('You overheard Kael pay Marta for a room.');
    expect(h.app.threads.pending(h.sessionOf(marta)).map((p) => p.content)).toEqual(['Kael takes the key.']);

    // After the wrap-up, rounds are normal again.
    h.script.characters['Marta'].push(JSON.stringify({ say: 'Stairs are on the left.' }));
    h.script.characters['Tom'] = [JSON.stringify({ say: '', intent: 'finish his drink' })];
    h.script.narrator.push(round('You climb the stairs.', { briefs: {} }));
    const c2 = await h.play('"Thanks." I head upstairs.');
    expect(c2.final?.meta.mode).toBe('round');
    expect((c2.final?.meta.gate as { called: string[] }).called.length).toBeGreaterThan(0);
    expect(h.requests('narrator')[2].messages.at(-1)!.content).not.toContain('direct conversation');
  });

  it('when the partner acts, the act is its declaration in the wrap-up', async () => {
    await h.opening();
    const marta = h.idOf('Marta');
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Out. Now.', act: 'shove the stranger toward the door' })];
    const c = await talk('"What is in the ledger?"', marta);
    expect((c.final?.meta.reply as { act?: string }).act).toBe('shove the stranger toward the door');

    h.script.narrator.push(round('She shoves you hard; you stumble into the rain.', { briefs: { '#marta': 'He is outside.' } }));
    await h.play('');
    const nText = textOf(h.requests('narrator')[1]);
    expect(nText).toContain('tries: shove the stranger toward the door');
    expect(nText).toContain('resolve what the player and Marta now try');
  });

  it('refuses a partner who is not here, and commits nothing', async () => {
    await h.opening();
    const clock = h.app.stories.getStory(h.storyId)!.clockMin;
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    const c = await talk('"Hello?"', kael);
    expect(c.errors[0]).toMatch(/not here to talk to/);
    const c2 = await talk('"Hello?"', 'no-such-id');
    expect(c2.errors[0]).toMatch(/not here to talk to/);
    expect(h.app.stories.getStory(h.storyId)!.clockMin).toBe(clock);
    expect(h.seen.filter((s) => s.agent.startsWith('character:'))).toHaveLength(0);
  });

  it('rewind undoes an exchange: thread, state, thoughts, clock — and the conversation is gone', async () => {
    await h.opening();
    const marta = h.idOf('Marta');
    const clock = h.app.stories.getStory(h.storyId)!.clockMin;
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.', state: 'Wary.', remember: [{ text: 'He wants a room.', tags: [] }] })];
    await talk('"Got a room?"', marta);
    await h.app.pipeline.rewind(h.storyId);
    expect(h.app.sheets.get(marta)!.state).toBe('');
    expect(h.app.thoughts.list(h.storyId, marta)).toEqual([]);
    expect(h.app.threads.log(h.sessionOf(marta))).toHaveLength(0);
    expect(h.app.threads.pending(h.sessionOf(marta)).map((p) => p.content)).toEqual(['A tall stranger walks in out of the rain.']);
    expect(h.app.stories.getStory(h.storyId)!.clockMin).toBe(clock);

    // No open conversation remains, so the next round is a normal one.
    h.script.characters['Marta'].push(JSON.stringify({ say: 'Yes?' }));
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She looks up.', { briefs: {} }));
    const c = await h.play('"Evening."');
    expect(c.final?.meta.mode).toBe('round');
  });
});
