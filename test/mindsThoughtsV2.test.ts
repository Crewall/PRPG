import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { applyThoughtOps, thoughtLens } from '../src/minds/service.ts';
import { clampImportance, currentImportance, normalizeKind, renderThought } from '../src/minds/thoughts.ts';

// Thoughts v2 (docs/11 §5.6–5.10): kinds, importance, fading, revising, the agenda, and who sees what.

describe('thoughts v2', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  const tom = () => h.idOf('Tom');
  const active = (oid: string) => h.app.thoughts.list(h.storyId, oid);
  const quiet = (n = 1) => {
    for (let i = 0; i < n; i++) {
      h.script.characters['Marta'] = [...(h.script.characters['Marta'] ?? []), JSON.stringify({ say: '' })];
      h.script.characters['Tom'] = [...(h.script.characters['Tom'] ?? []), JSON.stringify({ say: '' })];
    }
  };

  it('a character notes an opinion with a subject and importance; kinds and importance are normalized', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [
      JSON.stringify({
        say: '',
        remember: [
          { kind: 'opinion', about: '#tom', importance: 7, text: 'Tom talks too much when he drinks.', tags: ['drink'] },
          { kind: 'Goal', importance: '8', text: 'Keep the ledger out of sight.', tags: ['ledger'] },
          { kind: 'opinion', about: '#nobody', importance: 40, text: 'Someone is watching the inn.' },
        ],
      }),
    ];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I wait.');
    const [op, goal, odd] = active(marta());
    expect([op.kind, op.importance, op.about, op.tags]).toEqual(['opinion', 7, tom(), ['#tom', 'drink']]);
    expect([goal.kind, goal.importance]).toEqual(['agenda', 8]);
    expect([odd.kind, odd.importance, odd.about]).toEqual(['note', 10, null]); // unknown subject: a note
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('no one/nothing is called #nobody');

    // Next round: the agenda has its own heading; the opinion reads with its subject.
    quiet();
    h.script.narrator.push(round('Rain.', { briefs: {} }));
    await h.play('I wait.');
    const ask = h.requests('character:Marta').at(-1)!.messages.at(-1)!.content;
    expect(ask).not.toContain('Your agenda:'); // she wrote it herself: already in her thread
    const lens = thoughtLens(h.app, h.storyId);
    expect(lens.render(op)).toMatch(/^t1 · Day 1, \d\d:\d\d · opinion of #tom, 7\/10 \[drink\] Tom talks too much when he drinks\.$/);
  });

  it('agenda items are capped at three; revising keeps the old one as history; restating renews', () => {
    h = mindsHarness();
    const oid = h.app.memory.createObject({ storyId: h.storyId, type: 'character', name: 'Ada', aliases: [], summary: '', salience: 0.5, status: 'active' }).id;
    h.app.sheets.upsert(h.storyId, oid, {});
    const goals = ['Find the map.', 'Pay the debt.', 'Leave town.', 'Learn to sail.'].map((text) => ({ kind: 'agenda', text, tags: [] }));
    const r = applyThoughtOps(h.app, h.storyId, oid, { remember: goals }, 'seed');
    expect(r.added).toHaveLength(3);
    expect(r.notes.join(' ')).toContain('already have 3 goals');

    const r2 = applyThoughtOps(h.app, h.storyId, oid, { revise: [{ id: 't2', text: 'Pay half the debt now.', importance: 6 }] }, 'self');
    expect(r2.revised[0].text).toBe('Pay half the debt now.');
    expect(r2.revised[0].kind).toBe('agenda');
    const all = h.app.thoughts.list(h.storyId, oid, { includeRevoked: true });
    expect(all.find((t) => t.seq === 2)!.status).toBe('revised');
    expect(all.at(-1)!.revises).toBe(all.find((t) => t.seq === 2)!.id);

    h.app.stories.advanceClock(h.storyId, 120);
    applyThoughtOps(h.app, h.storyId, oid, { remember: [{ text: 'Find the map.', tags: [] }] }, 'self');
    expect(h.app.thoughts.list(h.storyId, oid).find((t) => t.seq === 1)!.renewedClockMin).toBe(h.app.stories.getStory(h.storyId)!.clockMin);
  });

  it('thoughts fade by importance over in-story time; agenda, pinned and 8–10 never do; rewind brings them back', async () => {
    h = mindsHarness();
    await h.opening();
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, fadeHours: 1 } } });
    applyThoughtOps(
      h.app,
      h.storyId,
      marta(),
      {
        remember: [
          { kind: 'note', importance: 2, text: 'The roof leaks by the window.', tags: ['roof'] },
          { kind: 'feeling', importance: 8, text: 'I am afraid of the harbour men.', tags: ['harbour'] },
          { kind: 'agenda', importance: 3, text: 'Sell the inn before winter.', tags: ['inn'] },
          { kind: 'note', importance: 2, pin: true, text: 'Never open the cellar at night.', tags: ['cellar'] },
        ],
      },
      'seed',
    );
    const [roof] = active(marta());
    const clock0 = h.app.stories.getStory(h.storyId)!.clockMin;
    expect(currentImportance(roof, { clockMin: clock0 + 90, turnIndex: null, fadeHours: 1, fadeRounds: 12 })).toBe(1);
    quiet();
    h.script.narrator.push(round('Hours pass.', { briefs: {}, time: 150 }));
    await h.play('I sleep.');
    expect(active(marta()).map((t) => t.text)).toEqual(['I am afraid of the harbour men.', 'Sell the inn before winter.', 'Never open the cellar at night.']);
    const faded = h.app.thoughts.list(h.storyId, marta(), { includeRevoked: true }).find((t) => t.text.startsWith('The roof'))!;
    expect(faded.status).toBe('faded');

    await h.app.pipeline.rewind(h.storyId);
    expect(active(marta()).map((t) => t.text)).toContain('The roof leaks by the window.');
  });

  it('a thought renews when something touches it, not because its subject is in the room (docs/11 §5.7)', async () => {
    h = mindsHarness();
    await h.opening();
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, fadeHours: 1 } } });
    applyThoughtOps(
      h.app,
      h.storyId,
      marta(),
      {
        remember: [
          { kind: 'opinion', about: '#tom', importance: 2, text: 'Tom is harmless.', tags: [] },
          { kind: 'note', importance: 2, text: 'The ledger is behind the flour sacks.', tags: ['ledger'] },
        ],
      },
      'seed',
    );
    // Tom is in the room every round; the narrator brings up the ledger every round.
    for (let i = 0; i < 3; i++) {
      quiet();
      h.script.narrator.push(round('Time passes.', { briefs: {}, time: 50, spotlight: ['#marta'], tags: ['ledger'] }));
      await h.play('I wait.');
    }
    const texts = active(marta()).map((t) => t.text);
    expect(texts).toContain('The ledger is behind the flour sacks.');
    expect(texts).not.toContain('Tom is harmless.');
  });

  it('fading also counts rounds: a long talk cools down even though the clock barely moves', async () => {
    h = mindsHarness();
    await h.opening();
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, fadeRounds: 2 } } });
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 2, text: 'He seems shifty.', tags: [] }] }, 'self');
    for (let i = 0; i < 4; i++) {
      quiet();
      h.script.narrator.push(round('A minute passes.', { briefs: {}, time: 1 }));
      await h.play('"Go on."');
    }
    expect(active(marta()).map((t) => t.text)).not.toContain('He seems shifty.');
  });

  it('the narrator sees agendas and strong opinions of the characters present, nothing weaker', async () => {
    h = mindsHarness();
    await h.opening();
    applyThoughtOps(
      h.app,
      h.storyId,
      marta(),
      {
        remember: [
          { kind: 'agenda', importance: 7, text: 'Get the stranger out before the harbour men come.', tags: [] },
          { kind: 'opinion', about: '#tom', importance: 8, text: 'Tom would sell me out for a drink.', tags: [] },
          { kind: 'opinion', about: '#kael', importance: 4, text: 'The stranger seems tired.', tags: [] },
          { kind: 'note', importance: 9, text: 'The ledger is under the third board.', tags: ['ledger'] },
        ],
      },
      'seed',
    );
    quiet();
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I wait.');
    const ask = h.requests('narrator').at(-1)!.messages.at(-1)!.content;
    expect(ask).toContain('  Agenda: Get the stranger out before the harbour men come.');
    expect(ask).toContain('  Strongly: (opinion of #tom, 8/10) Tom would sell me out for a drink.');
    expect(ask).not.toContain('seems tired');
    expect(ask).not.toContain('third board'); // a note, not an opinion or feeling
  });

  it('the seeder writes kinds, subjects and importance', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.seeder.push(
      JSON.stringify({
        description: 'Marta runs the inn.',
        thoughts: [
          { kind: 'agenda', importance: 7, text: 'Keep the inn afloat.', tags: ['inn'] },
          { kind: 'opinion', about: '#tom', importance: 6, text: 'Tom is useful but loose-lipped.', tags: [] },
          { kind: 'feeling', importance: 9, text: 'I still grieve my husband.', tags: ['husband'] },
        ],
      }),
      JSON.stringify({ description: 'Tom drinks.', thoughts: [] }),
    );
    await h.app.worker.drain();
    expect(active(marta()).map((t) => `${t.kind}:${t.importance}:${t.about ? 'tom' : '-'}`)).toEqual(['agenda:7:-', 'opinion:6:tom', 'feeling:9:-']);
  });

  it('the API lists thoughts with current importance and subject, edits them, and restores faded ones', async () => {
    h = mindsHarness();
    await h.opening();
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const created = await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/thoughts`, payload: { owner: marta(), text: 'Tom owes me.', kind: 'opinion', about: tom(), importance: 3 } });
    expect(created.statusCode).toBe(201);
    const t = created.json().added[0];
    expect([t.kind, t.importance, t.about]).toEqual(['opinion', 3, tom()]);
    const list = async () => (await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/thoughts?owner=${marta()}&includeRevoked=1` })).json();
    expect((await list()).thoughts[0]).toMatchObject({ current: 3, aboutHandle: 'tom', aboutName: 'Tom', fades: true });

    await server.inject({ method: 'PATCH', url: `/api/thoughts/${t.id}`, payload: { importance: 9, text: 'Tom owes me three silver.', kind: 'feeling' } });
    expect((await list()).thoughts[0]).toMatchObject({ importance: 9, text: 'Tom owes me three silver.', kind: 'feeling', fades: false });

    h.app.thoughts.setStatus(t.id, 'faded', null);
    await server.inject({ method: 'PATCH', url: `/api/thoughts/${t.id}`, payload: { restore: true } });
    expect((await list()).thoughts[0].status).toBe('active');
    await server.close();
  });
});

describe('thought helpers', () => {
  it('normalize kinds and importance; render each kind', () => {
    expect(normalizeKind('Plan')).toBe('agenda');
    expect(normalizeKind('impression')).toBe('opinion');
    expect(normalizeKind('???')).toBe('note');
    expect(clampImportance('7.6')).toBe(8);
    expect(clampImportance(0)).toBe(1);
    expect(clampImportance('high')).toBe(5);
    const base = { seq: 3, tags: ['#agnes', 'file'], text: 'She reads the file, not me.', createdClockMin: null };
    expect(renderThought({ ...base, kind: 'opinion', importance: 7 }, { aboutHandle: 'agnes' })).toBe('t3 · opinion of #agnes, 7/10 [file] She reads the file, not me.');
    expect(renderThought({ ...base, kind: 'agenda', importance: 7 })).toBe('t3 · agenda [#agnes, file] She reads the file, not me.');
    expect(renderThought({ ...base, kind: 'note', importance: 4 }, { current: 2 })).toBe('t3 · 2/10 [#agnes, file] She reads the file, not me.');
  });
});
