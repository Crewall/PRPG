import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { collector, mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';

// Review before applying (docs/10 §10c): the round stops after the narrator writes; nothing reaches the minds,
// threads or variables until the player accepts the reply, edited or not.

describe('reviewing a reply before it is applied', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  const reviewOn = (on = true) => {
    const s = h.app.stories.getStory(h.storyId)!.settings;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s.minds, reviewReplies: on } } });
  };
  const roundTwo = () => {
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.', remember: [{ text: 'He paid in silver.', tags: ['#kael'] }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('You pay. Marta pockets the coins.', { briefs: { '#marta': '#kael pays you two silver.', '#tom': '#kael pays Marta.' }, vars: [{ who: '#marta', key: 'suspicion', delta: 5 }] }));
  };
  const server = async () => {
    const s = Fastify();
    await registerHttpRoutes(s, h.app);
    return s;
  };
  const accept = async (s: Awaited<ReturnType<typeof server>>, turnId: string, payload: Record<string, unknown> = {}) =>
    s.inject({ method: 'POST', url: `/api/stories/${h.storyId}/turns/${turnId}/accept`, payload });

  it('the round waits: nobody learns it until it is accepted, then it is applied as written', async () => {
    h = mindsHarness();
    await h.opening();
    reviewOn();
    roundTwo();
    const narratorLogBefore = h.app.threads.log(h.narratorSession()).length;
    const c = await h.play('"A room." I pay.', { review: true });
    const t = c.final!;
    expect(t.status).toBe('review');
    expect(t.narration).toBe('You pay. Marta pockets the coins.');
    // Nothing committed: no thought, no variable change, no brief, nothing in the threads.
    expect(h.app.thoughts.list(h.storyId, marta())).toEqual([]);
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta()) ?? 20).toBe(20);
    expect(h.app.threads.log(h.narratorSession())).toHaveLength(narratorLogBefore);
    expect(h.app.threads.pending(h.sessionOf(marta())).map((m) => m.content).join('\n')).not.toContain('two silver');

    // A new message is refused while the reply waits.
    const blocked = await h.play('"And a meal."', { review: true });
    expect(blocked.errors[0]).toMatch(/accept the last reply first/);
    expect(h.app.stories.lastTurn(h.storyId)!.id).toBe(t.id);

    const s = await server();
    const r = (await accept(s, t.id)).json();
    expect(r.ok).toBe(true);
    const last = h.app.stories.lastTurn(h.storyId)!;
    expect(last.status).toBe('complete');
    expect(last.narration).toBe('You pay. Marta pockets the coins.');
    expect(last.playerInput).toBe('"A room." I pay.');
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta())).toBe(25);
    expect(h.app.thoughts.list(h.storyId, marta()).map((x) => x.text)).toEqual(['He paid in silver.']);
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael pays you two silver.');
    // Nobody was asked again, and an unedited reply needs no revision.
    expect(h.requests('character:Marta')).toHaveLength(1);
    expect(h.requests('narrator')).toHaveLength(2);
    expect(h.requests('reviser')).toHaveLength(0);
    // The story moves on.
    roundTwo();
    expect((await h.play('"A meal."')).final!.status).toBe('complete');
    await s.close();
  });

  it('an edit before accepting is what everyone learns', async () => {
    h = mindsHarness();
    await h.opening();
    reviewOn();
    roundTwo();
    const t = (await h.play('"A room."', { review: true })).final!;
    const s = await server();
    // ✎ on a waiting reply only changes its text (nothing to revert).
    await s.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/turns/${t.id}`, payload: { narration: 'You slap a gold coin on the counter.' } });
    expect(h.app.stories.getTurn(t.id)!.status).toBe('review');
    expect(h.app.snapshots.undoInfo(h.storyId)).toBeUndefined();
    h.script.reviser!.push(JSON.stringify({ briefs: { '#marta': '#kael slaps a gold coin on the counter.', '#tom': '#kael pays in gold.' }, vars: [{ who: '#marta', key: 'suspicion', delta: 15 }] }));
    expect((await accept(s, t.id)).json().ok).toBe(true);
    const last = h.app.stories.lastTurn(h.storyId)!;
    expect(last.narration).toBe('You slap a gold coin on the counter.');
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta())).toBe(35);
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael slaps a gold coin on the counter.');
    expect(h.app.threads.log(h.narratorSession()).at(-1)!.content).toMatch(/^You slap a gold coin on the counter\.\n\n```round\n/);
    expect(h.requests('character:Marta')).toHaveLength(1);
    await s.close();
  });

  it('accept can carry the edit itself', async () => {
    h = mindsHarness();
    await h.opening();
    reviewOn();
    roundTwo();
    const t = (await h.play('"A room."', { review: true })).final!;
    const s = await server();
    expect((await accept(s, t.id, { narration: 'You pay in copper.' })).json().ok).toBe(true);
    expect(h.app.stories.lastTurn(h.storyId)!.narration).toBe('You pay in copper.');
    expect(h.requests('reviser')).toHaveLength(1);
    await s.close();
  });

  it('with no block from the narrator, the distributor writes one from the accepted prose', async () => {
    h = mindsHarness();
    await h.opening();
    reviewOn();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push('You pay. Marta pockets the coins.');
    const t = (await h.play('"A room."', { review: true })).final!;
    expect(h.requests('distributor')).toHaveLength(0);
    h.script.distributor.push(JSON.stringify({ briefs: { '#marta': '#kael pays in copper.' } }));
    const s = await server();
    expect((await accept(s, t.id, { narration: 'You pay in copper.' })).json().ok).toBe(true);
    expect(h.requests('distributor')).toHaveLength(1);
    expect(h.requests('reviser')).toHaveLength(0);
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael pays in copper.');
    await s.close();
  });

  it('↻ on a waiting reply writes it again, waiting again; × takes it back', async () => {
    h = mindsHarness();
    await h.opening();
    reviewOn();
    roundTwo();
    const t = (await h.play('"A room."', { review: true })).final!;
    roundTwo();
    h.script.narrator[0] = round('You pay twice over.', { briefs: { '#marta': '#kael overpays.' } });
    const c = collector();
    await h.app.pipeline.retry(h.storyId, c.emitter, { turnId: t.id, expectTurnId: t.id, review: true });
    expect(c.final!.status).toBe('review');
    expect(c.final!.narration).toBe('You pay twice over.');
    await h.app.pipeline.rewind(h.storyId, { expectTurnId: c.final!.id, action: 'remove' });
    expect(h.app.stories.lastTurn(h.storyId)!.status).toBe('complete');
    expect(h.app.snapshots.undoInfo(h.storyId)).toBeUndefined(); // nothing had been applied
    expect(h.app.thoughts.list(h.storyId, marta())).toEqual([]);
  });

  it('the setting off (or the client not asking) applies the round at once', async () => {
    h = mindsHarness();
    await h.opening();
    roundTwo();
    expect((await h.play('"A room."', { review: true })).final!.status).toBe('complete'); // setting off
    reviewOn();
    roundTwo();
    expect((await h.play('"A meal."')).final!.status).toBe('complete'); // advanced mode off: the client doesn't ask
  });

  it('accept refuses a reply that is not waiting', async () => {
    h = mindsHarness();
    await h.opening();
    const s = await server();
    const t = h.app.stories.lastTurn(h.storyId)!;
    expect((await accept(s, t.id)).statusCode).toBe(409);
    await s.close();
  });
});
