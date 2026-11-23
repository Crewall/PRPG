import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';

// ✎ on the last reply (docs/10 §10a): everyone learns the edited version; Revert brings back the original.

describe('editing the last reply', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  const roundTwo = () => {
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Two silver.', remember: [{ text: 'He paid in silver.', tags: ['#kael'] }] })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('You pay. Marta pockets the coins.', { briefs: { '#marta': '#kael pays you two silver.', '#tom': '#kael pays Marta.' }, vars: [{ who: '#marta', key: 'suspicion', delta: 5 }] }));
  };
  const patch = async (server: ReturnType<typeof Fastify>, turnId: string, narration: string) =>
    (await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/turns/${turnId}`, payload: { narration } })).json();

  it('the round is committed again with the edited prose and a revised block; the characters keep their replies', async () => {
    h = mindsHarness();
    await h.opening();
    roundTwo();
    const t = (await h.play('"A room." I pay.')).final!;
    const martaReply = h.app.threads.log(h.sessionOf(marta())).filter((m) => m.role === 'assistant').at(-1)!.content;
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta())).toBe(25);
    const server = Fastify();
    await registerHttpRoutes(server, h.app);

    h.script.reviser!.push(JSON.stringify({ briefs: { '#marta': '#kael slaps a gold coin on the counter.', '#tom': '#kael pays Marta in gold.' }, vars: [{ who: '#marta', key: 'suspicion', delta: 15 }] }));
    const r = await patch(server, t.id, 'You slap a gold coin on the counter. Marta stares at it.');
    expect(r).toMatchObject({ ok: true, recommitted: true });
    const last = h.app.stories.lastTurn(h.storyId)!;
    expect(last.narration).toBe('You slap a gold coin on the counter. Marta stares at it.');
    expect(last.playerInput).toBe('"A room." I pay.');
    // Everyone follows the edit: briefs, variables, the narrator's own memory.
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael slaps a gold coin on the counter.');
    expect(h.app.threads.pending(h.sessionOf(h.idOf('Tom'))).at(-1)!.content).toContain('#kael pays Marta in gold.');
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta())).toBe(35);
    expect(h.app.threads.log(h.narratorSession()).at(-1)!.content).toMatch(/^You slap a gold coin on the counter\. Marta stares at it\.\n\n```round\n/);
    // The characters' replies are kept byte-exact, and no character was asked again.
    expect(h.app.threads.log(h.sessionOf(marta())).filter((m) => m.role === 'assistant').at(-1)!.content).toBe(martaReply);
    expect(h.requests('character:Marta')).toHaveLength(1);
    expect(h.app.thoughts.list(h.storyId, marta()).map((x) => x.text)).toEqual(['He paid in silver.']);

    // Revert brings back the original round.
    await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/undo`, payload: {} });
    expect(h.app.stories.lastTurn(h.storyId)!.narration).toBe('You pay. Marta pockets the coins.');
    expect(h.app.variables.getValue(h.storyId, 'suspicion', marta())).toBe(25);
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael pays you two silver.');
    await server.close();
  });

  it('when the revision fails, the original block stands under the edited prose', async () => {
    h = mindsHarness();
    await h.opening();
    roundTwo();
    const t = (await h.play('"A room."')).final!;
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const r = await patch(server, t.id, 'You pay, and Marta smiles for once.'); // no reviser reply scripted
    expect(r).toMatchObject({ ok: true, recommitted: true });
    expect(h.app.stories.lastTurn(h.storyId)!.narration).toBe('You pay, and Marta smiles for once.');
    expect(h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content).toContain('#kael pays you two silver.');
    await server.close();
  });

  it('an older reply is a transcript-only edit', async () => {
    h = mindsHarness();
    await h.opening();
    roundTwo();
    const t = (await h.play('"A room."')).final!;
    roundTwo();
    await h.play('"A meal."');
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    const r = await patch(server, t.id, 'Edited later.');
    expect(r.recommitted).toBeUndefined();
    expect(h.app.stories.getTurn(t.id)!.narration).toBe('Edited later.');
    await server.close();
  });
});
