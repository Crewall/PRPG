import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { seedContext, unescapeText } from '../src/minds/seed.ts';
import { cleanTieLabel } from '../src/minds/ties.ts';

// The narrator's hand-over and ties (docs/11 §2.3, §2.6), the seeder's inputs, and briefs that carry perception
// only (docs/10 §5.1c).

describe('who they are and who their people are', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const system = (name: string) => h.requests(`character:${name}`).at(-1)!.system;
  const narratorAsk = (i = -1) => h.requests('narrator').at(i)!.messages.at(-1)!.content;
  const tiesOf = (oid: string) => h.app.ties.of(oid).map((t) => `${h.app.memory.getObject(t.other)!.name}:${t.label}`);

  /** Round 1: Rin and her sister Mira come in together; Mira's hand-over says who she is. */
  const siblings = () => {
    h.script.narrator.push(
      round('The door bangs open: a tall girl, and a smaller one clinging to her arm.', {
        cast: {
          enter: [
            { name: 'Rin', appearance: 'Tall, scarred knuckles.', pronouns: 'she/her', who: 'A dockhand who keeps her little sister fed.', ties: { Mira: 'younger sister' } },
            { name: 'Mira', appearance: 'Fifteen, dark hair in a braid.', pronouns: 'she/her', who: "Rin's little sister; sharp-eyed, wants to prove she's no child.", ties: { Rin: 'older sister', '#kael': 'the stranger who owes Rin money' } },
          ],
        },
        briefs: { '#rin': '#kael is at the counter.', '#mira': 'Warm air, the smell of stew. #kael is at the counter; #rin pulls you in.' },
      }),
    );
    return h.play('');
  };

  it('the hand-over and ties land on the sheet, in the mind, and in the narrator’s view', async () => {
    h = mindsHarness();
    await siblings();
    const mira = h.idOf('Mira');
    const rin = h.idOf('Rin');
    expect(h.app.sheets.get(mira)!.concept).toBe("Rin's little sister; sharp-eyed, wants to prove she's no child.");
    // A newcomer can be tied to another newcomer of the same round.
    expect(tiesOf(mira).sort()).toEqual(['Kael:the stranger who owes Rin money', 'Rin:older sister']);
    expect(tiesOf(rin)).toEqual(['Mira:younger sister']);

    h.script.characters['Rin'] = [JSON.stringify({ say: '' })];
    h.script.characters['Mira'] = [JSON.stringify({ say: 'Is that him?', to: '#rin' })];
    h.script.narrator.push(round('The girls whisper.', { briefs: {} }));
    await h.play('I wait.');
    // Before the seeder writes a description, the hand-over is who she is; her people come with it.
    const sys = system('Mira');
    expect(sys).toContain("Rin's little sister; sharp-eyed, wants to prove she's no child.");
    expect(sys).toContain('More about you is still being written');
    expect(sys).toContain('Your people (how you know them):\n- #');
    expect(sys).toContain('- #rin Rin: older sister');
    expect(sys).toContain('- #kael Kael: the stranger who owes Rin money');
    // The narrator reads who she is and her ties.
    expect(narratorAsk()).toContain("  Who: Rin's little sister; sharp-eyed, wants to prove she's no child.");
    expect(narratorAsk()).toMatch(/ {2}Ties: .*#rin Rin \(older sister\)/);
  });

  it('a tie means both know each other’s name; the block’s ties change and remove them; rewind restores them', async () => {
    h = mindsHarness();
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, nameKnowledge: true } } });
    await siblings();
    const mira = h.idOf('Mira');
    const rin = h.idOf('Rin');
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    expect(h.app.names.knows(mira, rin) && h.app.names.knows(rin, mira)).toBe(true);
    expect(h.app.names.knows(mira, kael) && h.app.names.knows(kael, mira)).toBe(true);

    const rinHandle = `#${h.app.memory.getObject(rin)!.handle}`;
    const miraHandle = `#${h.app.memory.getObject(mira)!.handle}`;
    h.script.characters['Rin'] = [JSON.stringify({ say: '' })];
    h.script.characters['Mira'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Rin hires you on the spot.', { briefs: {}, ties: { [rinHandle]: { '#kael': 'my new employer.' }, [miraHandle]: { '#kael': '' } } }));
    await h.play('"I need a guide."');
    expect(tiesOf(rin).sort()).toEqual(['Kael:new employer', 'Mira:younger sister']);
    expect(tiesOf(mira)).toEqual(['Rin:older sister']);

    await h.app.pipeline.rewind(h.storyId);
    expect(tiesOf(rin)).toEqual(['Mira:younger sister']);
    expect(tiesOf(mira).sort()).toEqual(['Kael:the stranger who owes Rin money', 'Rin:older sister']);
  });

  it('the seeder is told who "you" is, the hand-over, the ties, what she perceived and who is around — not the secrets', async () => {
    h = mindsHarness();
    const st = h.app.stories.getStory(h.storyId)!.settings;
    h.app.stories.updateStory(h.storyId, { settings: { genre: 'low fantasy', tone: 'gritty', minds: { ...st.minds, narratorNotes: 'Rin stole the ledger.' } } });
    await siblings();
    const ctx = seedContext(h.app as never, h.storyId, h.idOf('Mira'));
    expect(ctx).toContain('The player character: #kael Kael — Tall, rain-soaked.');
    expect(ctx).toContain('in the story text, "you" is always #kael, never Mira.');
    expect(ctx).toContain("- Who they are (the narrator's hand-over; canon): Rin's little sister; sharp-eyed, wants to prove she's no child.");
    expect(ctx).toContain('- Their people (canon): ');
    expect(ctx).toContain('#rin Rin (older sister)');
    expect(ctx).toContain('Warm air, the smell of stew. #kael is at the counter; #rin pulls you in.');
    expect(ctx).toMatch(/Around Mira now, as Mira perceives it:\nHere: .*\n.*#kael Kael/);
    expect(ctx).toContain('Genre: low fantasy · Tone: gritty · Now: ');
    expect(ctx).toContain('Player (#kael): (scene opens)');
    expect(ctx).toContain('- suspicion (0–100; hidden: only the narrator knows it');
    expect(ctx).not.toContain('Rin stole the ledger');
  });

  it("the seeder's reply is cleaned: real line breaks, the description within its limit, ties added but never changed", async () => {
    h = mindsHarness();
    const st = h.app.stories.getStory(h.storyId)!.settings;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...st.minds, descriptionMaxWords: 12 } } });
    await siblings();
    h.script.seeder.push(
      JSON.stringify({ description: 'Rin works the docks.', thoughts: [] }),
      JSON.stringify({
        description: 'Mira is fifteen.\\nShe idolises her sister and hates being called a child, and she reads people fast.',
        state: 'Tense,\\nwatching the stranger.',
        thoughts: [{ text: 'Rin says\\nhe owes us.', tags: ['#kael'] }],
        ties: { '#rin': 'rival', '#kael': 'debtor', '#nobody': 'friend' },
      }),
    );
    await h.app.worker.drain();
    const mira = h.idOf('Mira');
    const sheet = h.app.sheets.get(mira)!;
    expect(sheet.description.startsWith('Mira is fifteen.\nShe idolises')).toBe(true);
    expect(sheet.description.split(/\s+/)).toHaveLength(12);
    expect(sheet.description.endsWith('called a')).toBe(true);
    expect(sheet.state).toBe('Tense, watching the stranger.');
    expect(h.app.thoughts.list(h.storyId, mira)[0].text).toBe('Rin says he owes us.');
    // The narrator's ties stand; nothing new to add here (Kael and Rin are already tied).
    expect(tiesOf(mira).sort()).toEqual(['Kael:the stranger who owes Rin money', 'Rin:older sister']);
    // Rin had no tie to Kael: none came from her seed either.
    expect(tiesOf(h.idOf('Rin'))).toEqual(['Mira:younger sister']);
    expect(unescapeText('a\\r\\nb\\tc')).toBe('a\nb c');
  });

  it('a seed adds a tie the narrator left out', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.seeder.push(
      JSON.stringify({ description: 'Marta runs the inn.', ties: { '#tom': 'nephew' } }),
      JSON.stringify({ description: 'Tom drinks.', thoughts: [] }),
    );
    await h.app.worker.drain();
    expect(tiesOf(h.idOf('Marta'))).toEqual(['Tom:nephew']);
  });

  it('a brief that tells its reader what it thinks is delivered, and the narrator is reminded', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She counts coins.', { briefs: { '#marta': "#kael pays. You're calculating how much he has left.", '#tom': '#kael pays Marta.' } }));
    const c = await h.play('I pay.');
    expect((c.final?.meta.blockProblems as string[]).join(' ')).toMatch(/told thoughts \(#marta Marta\)/);
    expect(h.app.threads.pending(h.sessionOf(h.idOf('Marta'))).at(-1)!.content).toContain("You're calculating");
    h.script.characters['Marta'].push(JSON.stringify({ say: '' }));
    h.script.characters['Tom'].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('Night.', { briefs: {} }));
    await h.play('I sleep.');
    expect(narratorAsk()).toContain('Note: your briefs for #marta Marta told them what they think or plan.');
  });

  it('the API shows your own ties (all of them in advanced mode) and edits the hand-over and ties', async () => {
    h = mindsHarness();
    await siblings();
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const mira = h.idOf('Mira');
    const rin = h.idOf('Rin');
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    const view = async (adv = false) =>
      (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/minds${adv ? '?advanced=1' : ''}` })).json().characters as { objectId: string; concept?: string; ties?: { other: string; label: string }[] }[];
    const normal = await view();
    expect(normal.find((c) => c.objectId === mira)!.ties).toBeUndefined();
    expect(normal.find((c) => c.objectId === mira)!.concept).toBeUndefined();
    expect(normal.find((c) => c.objectId === kael)!.ties).toEqual([]);
    expect((await view(true)).find((c) => c.objectId === mira)!.ties!.map((t) => t.label).sort()).toEqual(['older sister', 'the stranger who owes Rin money']);

    const res = await server.inject({
      method: 'PATCH',
      url: `/api/stories/${h.storyId}/minds/${mira}`,
      payload: { concept: '  A runaway apprentice.  ', ties: { [kael]: '', [`#${h.app.memory.getObject(rin)!.handle}`]: 'twin sister' } },
    });
    expect(res.statusCode).toBe(200);
    expect(h.app.sheets.get(mira)!.concept).toBe('A runaway apprentice.');
    expect(tiesOf(mira)).toEqual(['Rin:twin sister']);
    const long = await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/minds/${mira}`, payload: { concept: 'word '.repeat(90) } });
    expect(long.statusCode).toBe(400);

    // The player's own ties show in the normal view.
    await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/minds/${kael}`, payload: { ties: { [rin]: 'old friend' } } });
    expect((await view()).find((c) => c.objectId === kael)!.ties!.map((t) => t.label)).toEqual(['old friend']);
    await server.close();
  });
});

describe('tie labels', () => {
  it('are cleaned: no "my", no trailing period, no placeholders, at most 8 words', () => {
    expect(cleanTieLabel('My older brother.')).toBe('older brother');
    expect(cleanTieLabel('<what that person is to them>')).toBe('');
    expect(cleanTieLabel('one two three four five six seven eight nine ten').split(' ')).toHaveLength(8);
  });
});

describe('adding a character by hand', () => {
  it('joins the scene, is announced to the narrator, gets a mind written, ties both ways', async () => {
    const h = mindsHarness();
    try {
      await h.opening();
      const server = Fastify();
      await registerHttpRoutes(server, h.app);
      const kael = h.app.sheets.player(h.storyId)!.objectId;
      const res = await server.inject({
        method: 'POST',
        url: `/api/stories/${h.storyId}/minds`,
        payload: { name: 'Brenna', pronouns: 'she/her', appearance: 'Red hair, soot on her arms.', concept: 'The village smith; owes Kael a favour.', nature: 'blunt, plain-spoken', here: true, playerKnowsName: true, ties: { [kael]: 'old friend' } },
      });
      expect(res.statusCode).toBe(201);
      const brenna = res.json().objectId as string;
      const scene = h.app.stories.getScene(h.app.stories.getStory(h.storyId)!.currentSceneId!)!;
      expect(scene.activeNpcIds).toContain(brenna);
      expect(h.app.sheets.get(brenna)!.nature).toBe('blunt, plain-spoken');
      expect(h.app.names.knows(kael, brenna)).toBe(true);
      expect(h.app.ties.of(brenna).map((t) => t.label)).toEqual(['old friend']);
      expect(h.app.db.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'minds_seed' AND json_extract(payload_json, '$.objectId') = ?`).get<{ n: number }>(brenna)!.n).toBe(1);

      // Next round: she is called (first appearance) and the narrator is asked to bring her in.
      h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
      h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
      h.script.characters['Brenna'] = [JSON.stringify({ say: 'Kael! Still owe you that drink.' })];
      h.script.narrator.push(round('Brenna shoulders in from the rain.', { briefs: {} }));
      await h.play('I wait.');
      const nar = h.requests('narrator').at(-1)!.messages.at(-1)!.content;
      expect(nar).toContain('Note: the player added a character who is here now: #brenna Brenna (she/her) — Red hair, soot on her arms.');
      expect(nar).toContain('Who they are: The village smith; owes Kael a favour.');
      expect(h.requests('character:Brenna').at(-1)!.messages.at(-1)!.content).toContain('You have just arrived');

      const dup = await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/minds`, payload: { name: 'Brenna' } });
      expect(dup.statusCode).toBe(409);
      await server.close();
    } finally {
      h.close();
    }
  });
});
