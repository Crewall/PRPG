import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { normalizeAwareness } from '../src/minds/presence.ts';

// Who is here, and who can perceive (docs/10 §5.1f).

describe('awareness: asleep or unconscious characters perceive nothing', () => {
  let h: MindsHarness;
  afterEach(() => h.close());
  const marta = () => h.idOf('Marta');
  const pending = (oid: string) => h.app.threads.pending(h.sessionOf(oid)).map((m) => m.content);
  const called = () => (h.app.stories.lastTurn(h.storyId)!.meta.gate as { called: string[] }).called;

  /** Round 2: Marta falls asleep at the end of it. */
  const marthaFallsAsleep = async () => {
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'I am so tired.' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Marta nods off behind the counter.', { briefs: { '#marta': 'The fire is warm; your eyes close.', '#tom': 'Marta nods off.' }, awareness: { '#marta': 'sleeping' } }));
    await h.play('"Long day?"');
  };

  it('falling asleep: that round still reaches her, then "Then you fall asleep."', async () => {
    h = mindsHarness();
    await marthaFallsAsleep();
    expect(h.app.sheets.get(marta())!.awareness).toBe('asleep');
    expect(pending(marta()).at(-1)).toBe('The fire is warm; your eyes close.\nThen you fall asleep.');
  });

  it('while asleep: never called (not even spoken to or forced), hears nothing, no brief; others see it', async () => {
    h = mindsHarness();
    await marthaFallsAsleep();
    const before = pending(marta()).length;
    h.script.director.push(JSON.stringify({ to: [], all: true, react: [] }));
    h.script.characters['Tom'] = [JSON.stringify({ say: 'Let her sleep.' })];
    h.script.narrator.push(round('Tom shrugs.', { briefs: { '#marta': 'You hear voices.', '#tom': 'The stranger speaks.' } }));
    await h.play('"Is she always like this, Marta? Tom?"', { force: [marta()] });
    expect(called()).toEqual([h.idOf('Tom')]);
    expect(pending(marta())).toHaveLength(before); // nothing reached her
    // The narrator sees she is asleep, and is told the brief was dropped.
    const nar = h.requests('narrator').at(-1)!.messages.at(-1)!.content;
    expect(nar).toContain('  Asleep: perceives nothing and can\'t act.');
    expect(nar).toContain('#marta (Marta');
    expect(h.app.threads.pending(h.narratorSession()).at(-1)!.content).toContain('Note: #marta is not awake, so your brief was dropped');
    // Tom sees her asleep in his Here: line.
    expect(h.requests('character:Tom').at(-1)!.messages.at(-1)!.content).toMatch(/#marta Marta \(asleep\)/);
    // A conversation can't start with her.
    const talk = await h.play('"Psst."', { dialogue: { partner: marta() } });
    expect(talk.errors.join(' ')).toContain('Marta is asleep: wake them first');
  });

  it('woken by the block: she slept through what was said, and notices her brief as she wakes', async () => {
    h = mindsHarness();
    await marthaFallsAsleep();
    h.script.characters['Tom'] = [JSON.stringify({ say: 'Marta! Wake up!' })];
    h.script.narrator.push(round('Tom shakes her.', { briefs: { '#marta': 'Someone shakes your shoulder; #tom is shouting.', '#tom': 'She stirs.' }, awareness: { '#marta': 'awake' }, spotlight: ['#marta'] }));
    await h.play('"Wake her, Tom."');
    expect(h.app.sheets.get(marta())!.awareness).toBe('awake');
    expect(pending(marta()).at(-1)).toBe('You wake up.\nSomeone shakes your shoulder; #tom is shouting.');
    // Next round she can act again.
    h.script.characters['Marta'] = [JSON.stringify({ say: 'What? What is it?' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Marta blinks.', { briefs: {} }));
    await h.play('"Morning."');
    expect(called()).toContain(marta());
  });

});

describe('awareness words', () => {
  it('are read leniently', () => {
    expect(['sleeping', 'knocked out', 'fainted', 'woken', 'comes to', 'banana'].map(normalizeAwareness)).toEqual(['asleep', 'unconscious', 'unconscious', 'awake', 'awake', undefined]);
  });
});

describe('here and awareness by hand', () => {
  let h: MindsHarness;
  let server: FastifyInstance;
  afterEach(() => h.close());
  const marta = () => h.idOf('Marta');
  const pending = (oid: string) => h.app.threads.pending(h.sessionOf(oid)).map((m) => m.content);
  const scene = () => h.app.stories.getScene(h.app.stories.getStory(h.storyId)!.currentSceneId!)!;
  const patch = (oid: string, payload: object) => server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/minds/${oid}`, payload });
  const start = async () => {
    h = mindsHarness();
    server = Fastify();
    await registerHttpRoutes(server, h.app);
    await h.opening();
  };

  it('the Here switch moves a character out of the scene and back in, telling them and the narrator', async () => {
    await start();
    expect((await patch(marta(), { here: false })).statusCode).toBe(200);
    expect(scene().activeNpcIds).not.toContain(marta());
    expect(pending(marta()).at(-1)).toBe('You are no longer at broken wheel: you have gone elsewhere.');
    expect(h.app.threads.pending(h.narratorSession()).at(-1)!.content).toContain('#marta is no longer here');

    expect((await patch(marta(), { here: true })).statusCode).toBe(200);
    expect(scene().activeNpcIds).toContain(marta());
    expect(pending(marta()).at(-1)).toBe('You have just arrived at broken wheel.');
    expect(h.app.threads.pending(h.narratorSession()).at(-1)!.content).toContain('#marta (Marta) is here now');

    // The player's character is always here.
    const kael = h.app.sheets.player(h.storyId)!.objectId;
    expect((await patch(kael, { here: false })).statusCode).toBe(400);
  });

  it('awareness by hand: told to them and to the narrator, and shown in the view', async () => {
    await start();
    await patch(marta(), { awareness: 'unconscious' });
    expect(pending(marta()).at(-1)).toBe('You lose consciousness.');
    expect(h.app.threads.pending(h.narratorSession()).at(-1)!.content).toBe('Note: #marta is now unconscious (set by the player).');
    const view = (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/minds` })).json();
    expect(view.characters.find((c: { objectId: string }) => c.objectId === marta()).awareness).toBe('unconscious');
    await patch(marta(), { awareness: 'awake' });
    expect(pending(marta()).at(-1)).toBe('You come to.');
  });
});
