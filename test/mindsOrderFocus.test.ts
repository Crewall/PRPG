import { describe, it, expect, afterEach } from 'vitest';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { beatsOf, spokenLines } from '../src/minds/contracts.ts';
import { clampSentences, focusFor, holdToLimits, limitsFor } from '../src/minds/focus.ts';

// Event order (docs/10 §6) and how much each character says (focus tiers, docs/10 §5.1e).

describe('event order', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const narratorAsk = () => h.requests('narrator').at(-1)!.messages.at(-1)!.content;
  const ask = (name: string) => h.requests(`character:${name}`).at(-1)!.messages.at(-1)!.content;

  it("the narrator gets the player's words and actions in the order typed; characters hear the lines apart", async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She takes the coin.', { briefs: {} }));
    await h.play('I set a coin on the counter. "A room, please." I watch her hands. "And a meal."');
    expect(narratorAsk()).toContain(
      'The player (#kael), in this order:\n1. tries: I set a coin on the counter.\n2. says "A room, please."\n3. tries: I watch her hands.\n4. says "And a meal."',
    );
    expect(ask('Marta')).toContain('Right now:\n#kael Kael: "A room, please." … "And a meal."');
  });

  it("a character's beats keep their order for the narrator, and others hear its lines apart", async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ beats: [{ do: 'slams the ledger shut' }, { say: 'We are closed.' }, { do: 'points at the door' }, { say: 'Out.' }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('The ledger slams.', { briefs: {} }));
    await h.play('"Is the kitchen open?"');
    expect(narratorAsk()).toContain('This round, in this order: tries: slams the ledger shut → says "We are closed." → tries: points at the door → says "Out."');
    expect(h.app.threads.pending(h.sessionOf(h.idOf('Tom'))).at(-1)!.content).toContain('#marta Marta: "We are closed." … "Out."');
  });

});

describe('focus tiers', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const ask = (name: string) => h.requests(`character:${name}`).at(-1)!.messages.at(-1)!.content;
  const long = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('spoken to while someone else is spotlighted: both lead, held to it; alone, she has the floor', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Fine.' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: 'Hm.' })];
    h.script.narrator.push(round('They nod.', { briefs: {}, spotlight: ['#tom'] }));
    await h.play('I wait.'); // the narrator spotlights Tom for the next round

    h.script.characters['Marta'] = [JSON.stringify({ say: long(300) })];
    h.script.characters['Tom'] = [JSON.stringify({ say: long(60) })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    const c = await h.play('"Marta, tell me everything about the smugglers."');
    expect(ask('Marta')).toContain('You are at the centre of this moment');
    const meta = c.final!.meta.declarations as { objectId: string; say?: string; focus?: string }[];
    const marta = meta.find((d) => d.objectId === h.idOf('Marta'))!;
    expect(marta.focus).toBe('lead'); // Tom was spotlighted too, so Marta shares the centre
    expect(marta.say!.split(/\s+/).length).toBeLessThanOrEqual(121);
    expect(meta.find((d) => d.objectId === h.idOf('Tom'))!.focus).toBe('lead');

    h.script.characters['Marta'].push(JSON.stringify({ say: long(300) }));
    h.script.narrator.push(round('She talks.', { briefs: {} }));
    const c2 = await h.play('"Marta, go on."');
    expect(ask('Marta')).toContain('This moment is yours: you have the floor.');
    const m2 = (c2.final!.meta.declarations as { objectId: string; say?: string; focus?: string }[]).find((d) => d.objectId === h.idOf('Marta'))!;
    expect(m2.focus).toBe('sole');
    expect(m2.say!.split(/\s+/).length).toBeLessThanOrEqual(241);
  });

  it('⚡⚡ gives a character the floor; ⚡ makes one act at lead', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: long(300) })];
    h.script.characters['Tom'] = [JSON.stringify({ say: long(300) })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    const c = await h.play('I look around.', { floor: [h.idOf('Tom')], force: [h.idOf('Marta')] });
    const decls = c.final!.meta.declarations as { objectId: string; say?: string; focus?: string }[];
    const tom = decls.find((d) => d.objectId === h.idOf('Tom'))!;
    const marta = decls.find((d) => d.objectId === h.idOf('Marta'))!;
    expect([tom.focus, marta.focus]).toEqual(['sole', 'lead']);
    expect(tom.say!.split(/\s+/).length).toBeLessThanOrEqual(241);
    expect(marta.say!.split(/\s+/).length).toBeLessThanOrEqual(121);
    expect(ask('Tom')).toContain('This moment is yours');
    expect(ask('Marta')).toContain('You are at the centre of this moment');
  });

  it('character verbosity scales every tier', async () => {
    h = mindsHarness();
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, characterVerbosity: 1 } } });
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: long(300) })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    const c = await h.play('I wait.', { force: [h.idOf('Marta')] });
    const marta = (c.final!.meta.declarations as { objectId: string; say?: string }[]).find((d) => d.objectId === h.idOf('Marta'))!;
    expect(marta.say!.split(/\s+/).length).toBeLessThanOrEqual(61); // lead at ×0.5
    expect(ask('Marta')).toContain('up to about 60 words of speech');
  });

  it('a conversation partner has the floor', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Ask, then.' })];
    await h.play('"A word?"', { dialogue: { partner: h.idOf('Marta') } });
    expect(ask('Marta')).toContain('This moment is yours: you have the floor.');
  });

});

describe('order and focus helpers', () => {
  it('beats and spoken lines', () => {
    expect(beatsOf('I nod. "Fine." "Really fine." Then I leave.').map((b) => `${b.kind}:${b.text}`)).toEqual(['do:I nod.', 'say:Fine.', 'say:Really fine.', 'do:Then I leave.']);
    expect(spokenLines(beatsOf('"A." I wait. "B." "C."'), 'A. B. C.')).toBe('"A." … "B." "C."');
    expect(spokenLines(undefined, 'Hello.')).toBe('"Hello."');
  });
  it('the rules', () => {
    const base = { called: ['a', 'b'], reasons: { a: 'spoken to', b: 'would react' } as Record<string, string>, direction: { to: ['a'], all: false }, floor: new Set<string>() };
    expect(focusFor('a', base)).toBe('sole');
    expect(focusFor('b', base)).toBe('background');
    expect(focusFor('a', { ...base, reasons: { a: 'spoken to', b: 'forced' } })).toBe('lead');
    expect(focusFor('b', { ...base, direction: { to: [], all: true }, reasons: { a: 'spoken to', b: 'spoken to' } })).toBe('part');
    expect(focusFor('b', { ...base, reasons: { a: 'spoken to', b: 'first appearance' } })).toBe('part');
    expect(limitsFor('sole', 5)).toEqual({ say: 480, intent: 100 });
    expect(clampSentences('One. Two. Three four five six.', 4)).toBe('One. Two.');
    const held = holdToLimits({ say: 'a b c d e f', intent: 'x y z', beats: [{ kind: 'say', text: 'a b c' }, { kind: 'do', text: 'x y z' }, { kind: 'say', text: 'd e f' }] }, { say: 4, intent: 2 });
    expect(held.beats.map((b) => b.text)).toEqual(['a b c', 'x y…', 'd…']);
  });
});
