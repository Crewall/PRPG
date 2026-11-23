import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mindsHarness, round, fail } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { createCharacter } from '../src/minds/service.ts';

// Who the player's words are meant for (docs/10 §5.1b).

describe('the director: talk has a direction', () => {
  let h: MindsHarness;
  let lira: string, briony: string, tamsin: string;
  beforeEach(async () => {
    h = mindsHarness({ player: false });
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, nameKnowledge: true } } });
    createCharacter(h.deps, h.storyId, { name: 'Rin', isPlayer: true, knownAs: 'the tall stranger', appearance: 'Tall.' });
    h.script.narrator.push(
      round('A lantern market. A frantic elf girl, a wary woman, a shy girl with a wooden bird.', {
        cast: {
          enter: [
            { name: 'Liraelen', knownAs: 'the elf girl in green', appearance: 'An elf girl in green.' },
            { name: 'Briony', knownAs: 'the wary woman', appearance: 'A wary woman.' },
            { name: 'Tamsin', knownAs: 'the shy girl', appearance: 'A shy girl with a wooden bird.' },
          ],
        },
        briefs: {},
      }),
    );
    await h.play('');
    [lira, briony, tamsin] = ['Liraelen', 'Briony', 'Tamsin'].map((n) => h.idOf(n));
    // Round 2: only the elf girl speaks — to the player.
    h.script.director.push(JSON.stringify({ to: [], all: true, react: [] }));
    h.script.characters['Liraelen'] = [JSON.stringify({ say: 'Please — have you seen my little brother?', to: '#tall-stranger' })];
    h.script.characters['Briony'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tamsin'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('The elf girl grabs your sleeve.', { briefs: {} }));
    await h.play('"Hello?"');
  });
  afterEach(() => h.close());

  const called = () => (h.app.stories.listTurns(h.storyId).at(-1)!.meta.gate as { called: string[] }).called;
  const asks = (name: string) => h.requests(`character:${name}`).length;

  it('the reported case: asking the one who just spoke to you — only she answers', async () => {
    const before = { b: asks('Briony'), t: asks('Tamsin'), d: h.requests('director').length };
    h.script.characters['Liraelen'].push(JSON.stringify({ say: "I'm Liraelen. He's Tomi.", to: '#tall-stranger' }));
    h.script.narrator.push(round('She swallows.', { briefs: {} }));
    await h.play('"What is your name? And your brother\'s?"');
    expect(called()).toEqual([lira]);
    expect(asks('Briony')).toBe(before.b);
    expect(asks('Tamsin')).toBe(before.t);
    expect(h.requests('director')).toHaveLength(before.d); // settled by a rule: a reply to who spoke last
    const meta = h.app.stories.listTurns(h.storyId).at(-1)!.meta;
    expect(meta.direction).toMatchObject({ to: [lira], source: 'rule' });
    // Everyone hears where the words went; the narrator too.
    expect(h.requests('character:Liraelen').at(-1)!.messages.at(-1)!.content).toContain('#tall-stranger: "What is your name? And your brother\'s?" (to #elf-girl-in-green)');
    expect(h.app.threads.pending(h.sessionOf(briony)).at(-1)!.content).toContain('(to #elf-girl-in-green): "What is your name?');
    expect(h.requests('narrator').at(-1)!.messages.at(-1)!.content).toContain('to #elf-girl-in-green');
  });

  it('naming someone by how they look sends the words to them', async () => {
    h.script.characters['Briony'].push(JSON.stringify({ say: 'Not my business.' }));
    h.script.narrator.push(round('She shrugs.', { briefs: {} }));
    await h.play('I turn to the wary woman. "Do you know her?"');
    expect(called()).toEqual([briony]);
  });

  it('an ambiguous line goes to the director; whom it names answers, plus who would react', async () => {
    h.script.director.push(JSON.stringify({ to: ['#shy-girl'], react: ['#elf-girl-in-green'], all: false, why: 'the bird' }));
    h.script.characters['Tamsin'].push(JSON.stringify({ say: 'He is just a bird.' }));
    h.script.characters['Liraelen'].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('The girl hugs her bird.', { briefs: {} }));
    await h.play('I crouch down. "What a lovely bird."');
    expect(called()).toEqual([tamsin, lira]);
    expect(h.app.stories.listTurns(h.storyId).at(-1)!.meta.direction).toMatchObject({ to: [tamsin], react: [lira], source: 'director' });
    const ask = h.requests('director').at(-1)!.messages[0].content;
    expect(ask).toContain('- #shy-girl (the shy girl): A shy girl with a wooden bird.');
    expect(ask).toContain('- #elf-girl-in-green to #tall-stranger: "Please — have you seen my little brother?"');
    expect(ask).not.toContain('Tamsin'); // the director sees people as the player knows them
  });

  it('when the director fails, the round goes on as before (no direction)', async () => {
    h.script.director.push(fail('provider 502'));
    for (const n of ['Liraelen', 'Briony', 'Tamsin']) h.script.characters[n].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('Silence.', { briefs: {} }));
    const c = await h.play('I look around. "Anyone?"');
    expect(c.errors).toEqual([]);
    expect(h.app.stories.listTurns(h.storyId).at(-1)!.meta.direction).toBeUndefined();
  });
});
