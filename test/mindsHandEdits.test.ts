import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mindsHarness, round, collector } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';

// Your hand edits of a mind (advanced mode, docs/11 §5.10c): a thought you forget stays forgotten, the mind is told,
// and a rewind (↻, Edit, Revert) doesn't undo what you changed by hand.

describe('hand edits of thoughts', () => {
  let h: MindsHarness;
  let server: FastifyInstance;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  const all = () => h.app.thoughts.list(h.storyId, marta(), { includeRevoked: true });
  const active = () => h.app.thoughts.list(h.storyId, marta()).map((t) => t.text);
  const byText = (text: string) => all().find((t) => t.text === text)!;
  const patch = (tid: string, payload: object) => server.inject({ method: 'PATCH', url: `/api/thoughts/${tid}`, payload });
  const goal = 'Find out who the stranger really is.';
  /** A round in which Marta (re)states the goal. */
  const roundWithGoal = (tag: string) => {
    h.script.characters['Marta'] = [JSON.stringify({ say: `Hm (${tag}).`, remember: [{ kind: 'agenda', text: goal }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round(`She watches you (${tag}).`, { briefs: {}, spotlight: ['#marta'] }));
  };
  const start = async () => {
    h = mindsHarness();
    server = Fastify();
    await registerHttpRoutes(server, h.app);
    await h.opening();
  };

  it('a thought you forget is not taken up again word for word, and the mind is told', async () => {
    await start();
    roundWithGoal('A');
    await h.play('"Evening."');
    const t = byText(goal);
    expect(t.status).toBe('active');

    await patch(t.id, { revoked: true });
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toBe(
      `You have let go of t${t.seq} (agenda): "${goal}" It is no longer on your mind; don't take it up again unless something new brings it back.`,
    );

    // She restates it word for word (it is still in her thread): it stays forgotten.
    roundWithGoal('B');
    await h.play('"A room, please."');
    expect(active()).not.toContain(goal);
    expect(all().filter((x) => x.text === goal)).toHaveLength(1);
    const ask = h.requests('character:Marta').at(-1)!.messages.at(-1)!.content;
    expect(ask).toContain(`You have let go of t${t.seq} (agenda)`);
    expect(h.app.threads.pending(h.sessionOf(marta())).map((m) => m.content).join('\n')).toContain(`You let go of "${goal}"; it stays forgotten.`);

    // You can bring it back by hand, and then she is told that too.
    await patch(t.id, { restore: true });
    expect(active()).toContain(goal);
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain(`t${t.seq} is on your mind again`);
  });

  it('an edit reaches the mind: the new wording replaces the old one in her thread', async () => {
    await start();
    roundWithGoal('A');
    await h.play('"Evening."');
    const t = byText(goal);
    await patch(t.id, { text: 'Get the stranger to pay up front.', importance: 7 });
    const note = h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content;
    expect(note).toContain(`Your thought t${t.seq} has changed (it said: "${goal}"). It now reads: t${t.seq}`);
    expect(note).toMatch(/agenda.* Get the stranger to pay up front\.$/);
    // Saving the form without changing anything tells her nothing.
    const before = h.app.threads.pending(h.sessionOf(marta())).length;
    await patch(t.id, { text: 'Get the stranger to pay up front.', importance: 7 });
    expect(h.app.threads.pending(h.sessionOf(marta()))).toHaveLength(before);
    // Restating the old wording doesn't bring the old thought back as a second goal.
    roundWithGoal('B');
    await h.play('"A room, please."');
    expect(active()).toEqual(['Get the stranger to pay up front.']);
  });

  it('↻ regenerate and Revert keep what you changed by hand after the turn', async () => {
    await start();
    h.app.thoughts.insert(h.storyId, marta(), { text: 'The roof leaks.', tags: [], pinned: false, source: 'seed', clockMin: 0, kind: 'note', importance: 4 }, null);
    roundWithGoal('A');
    await h.play('"Evening."');

    await patch(byText(goal).id, { revoked: true }); // made in this turn, forgotten by hand
    await patch(byText('The roof leaks.').id, { text: 'The roof leaks over room three.' }); // older, edited by hand
    await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/thoughts`, payload: { owner: marta(), kind: 'feeling', text: 'I miss my brother.' } });

    // Regenerate: the turn runs again from its start, and she states the goal again.
    roundWithGoal('A2');
    await h.app.pipeline.retry(h.storyId, collector().emitter);
    expect(active()).toEqual(['The roof leaks over room three.', 'I miss my brother.']);
    expect(byText(goal).status).toBe('revoked');

    // Revert brings back the replaced reply; your edits stay.
    await h.app.pipeline.undo(h.storyId);
    expect(active()).toEqual(['The roof leaks over room three.', 'I miss my brother.']);
    expect(h.app.stories.lastTurn(h.storyId)!.narration).toContain('She watches you (A).');
  });
});
