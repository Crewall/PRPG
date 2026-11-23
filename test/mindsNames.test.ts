import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { createCharacter } from '../src/minds/service.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { maskUnknownNames } from '../src/minds/names.ts';

// Names: who knows whom (docs/11 §2.5).

describe('names are learned, not given away', () => {
  let h: MindsHarness;
  let rin: string;
  beforeEach(() => {
    h = mindsHarness({ player: false });
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, nameKnowledge: true } } });
    rin = createCharacter(h.deps, h.storyId, { name: 'Rin', isPlayer: true, knownAs: 'the tall stranger', pronouns: 'she/her', appearance: 'Tall, grey cloak.' }).objectId;
  });
  afterEach(() => h.close());

  const handleOf = (oid: string) => h.app.memory.getObject(oid)!.handle;
  const lastAsk = (name: string) => h.requests(`character:${name}`).at(-1)!.messages.at(-1)!.content;
  const opening = () => {
    h.script.narrator.push(
      round('A crowded lantern market. An elf girl in green pushes towards you; a wary woman watches.', {
        cast: {
          enter: [
            { name: 'Liraelen', knownAs: 'the elf girl in green', pronouns: 'she/her', appearance: 'An elf girl in a green cloak.' },
            { name: 'Briony', knownAs: 'the wary woman', pronouns: 'she/her', appearance: 'A wary woman, sleeve in her fist.', knows: ['Liraelen'] },
          ],
        },
        briefs: { '#elf-girl-in-green': 'The tall stranger is right there.', '#wary-woman': 'Rin, the tall stranger, looks lost.' },
      }),
    );
    return h.play('');
  };

  it('handles come from how people look; a stranger is shown without a name', async () => {
    await opening();
    const lira = h.idOf('Liraelen');
    const briony = h.idOf('Briony');
    expect(handleOf(rin)).toBe('tall-stranger');
    expect(handleOf(lira)).toBe('elf-girl-in-green');
    expect(handleOf(briony)).toBe('wary-woman');

    // Briony's brief named Rin, whom she doesn't know: the name became the handle.
    expect(h.app.threads.pending(h.sessionOf(briony)).at(-1)!.content).toBe('#tall-stranger, the tall stranger, looks lost.');
    // `knows` worked: Briony knows Liraelen's name; Liraelen doesn't know Briony's.
    expect(h.app.names.knows(briony, lira)).toBe(true);
    expect(h.app.names.knows(lira, briony)).toBe(false);

    h.script.characters['Liraelen'] = [JSON.stringify({ say: "I'm Liraelen. Have you seen my brother?", to: '#tall-stranger' })];
    h.script.characters['Briony'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('The girl grabs your sleeve.', { briefs: {}, names: { '#wary-woman': ['#tall-stranger'] } }));
    await h.play('"Hello?"');
    const ask = lastAsk('Liraelen');
    expect(ask).toContain('- #tall-stranger, name unknown to you (she/her) — Tall, grey cloak.');
    expect(ask).toContain('- #wary-woman, name unknown to you (she/her)');
    expect(ask).toContain('Right now:\n#tall-stranger: "Hello?"');
    expect(ask).not.toContain('Briony');
    expect(ask).not.toContain('Rin');
    expect(lastAsk('Briony')).toContain('- #elf-girl-in-green Liraelen (she/her)'); // she knows her

    // Heard: everyone who heard "I'm Liraelen" learned it; the narrator's "names" taught Briony Rin's.
    expect(h.app.names.knows(rin, lira)).toBe(true);
    expect(h.app.names.knows(briony, rin)).toBe(true);
    expect(h.app.names.knows(lira, rin)).toBe(false);
  });

  it("the player's view shows a name only once the player knows it; rewind forgets what was learned", async () => {
    await opening();
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const view = async () => (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/minds` })).json().characters as { name: string; nameKnown: boolean }[];
    expect((await view()).map((c) => `${c.name}:${c.nameKnown}`)).toEqual(['Rin:true', 'the elf girl in green:false', 'the wary woman:false']);

    h.script.characters['Liraelen'] = [JSON.stringify({ say: "I'm Liraelen." })];
    h.script.characters['Briony'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She smiles.', { briefs: {} }));
    await h.play('"Who are you?"');
    expect((await view()).map((c) => c.name)).toEqual(['Rin', 'Liraelen', 'the wary woman']);

    await h.app.pipeline.rewind(h.storyId);
    expect((await view()).map((c) => c.name)).toEqual(['Rin', 'the elf girl in green', 'the wary woman']);

    // Advanced mode marks the name as known by hand.
    const briony = h.idOf('Briony');
    await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/minds/${briony}`, payload: { playerKnowsName: true } });
    expect((await view()).map((c) => c.name)).toEqual(['Rin', 'the elf girl in green', 'Briony']);
    await server.close();
  });

  it('in a conversation, the partner hears the player as it knows them, and the player reads the partner the same way', async () => {
    await opening();
    const lira = h.idOf('Liraelen');
    h.script.characters['Liraelen'] = [JSON.stringify({ say: 'Please help me.' }), JSON.stringify({ say: 'Call me Liraelen.' }), JSON.stringify({ say: 'Thank you, Rin.' })];
    const c = await h.play('"What is wrong?"', { dialogue: { partner: lira } });
    expect(c.final?.narration).toBe('The elf girl in green: "Please help me."');
    expect(lastAsk('Liraelen')).toContain('#tall-stranger: "What is wrong?"');
    // The line that says the name is still spoken by a stranger; from then on she has a name.
    const c2 = await h.play('"I\'m Rin. And you?"', { dialogue: { partner: lira } });
    expect(c2.final?.narration).toBe('The elf girl in green: "Call me Liraelen."');
    expect(h.app.names.knows(lira, rin)).toBe(true);
    expect(h.app.names.knows(rin, lira)).toBe(true);
    const c3 = await h.play('"Let\'s find him."', { dialogue: { partner: lira } });
    expect(c3.final?.narration).toBe('Liraelen: "Thank you, Rin."');
    expect(lastAsk('Liraelen')).toContain('#tall-stranger Rin: "Let\'s find him."');
  });

  it('masking leaves speech alone and stops at the reader', () => {
    const lira = createCharacter(h.deps, h.storyId, { name: 'Liraelen', knownAs: 'the elf girl' }).objectId;
    expect(maskUnknownNames(h.deps, h.storyId, lira, 'Rin and Liraelen walk on; Rindle stays.')).toBe('#tall-stranger and Liraelen walk on; Rindle stays.');
  });
});
