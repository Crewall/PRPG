import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { mindsHarness, round, collector } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { registerHttpRoutes } from '../src/api/http.ts';

// Revert (docs/10 §10a): one step back after regenerate, Edit, remove or edit, restoring everything exactly.

describe('revert', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  const marta = () => h.idOf('Marta');
  /** A fingerprint of everything a turn can change. */
  const state = () => ({
    turns: h.app.stories.recentTurns(h.storyId, 50).map((t) => `${t.index}:${t.playerInput}:${t.narration}`).reverse(),
    martaThread: h.app.threads.log(h.sessionOf(marta())).map((m) => `${m.role}:${m.content}`),
    martaPending: h.app.threads.pending(h.sessionOf(marta())).map((m) => m.content),
    narrator: h.app.threads.log(h.narratorSession()).map((m) => m.content),
    thoughts: h.app.thoughts.list(h.storyId, marta(), { includeRevoked: true }).map((t) => `${t.seq}:${t.status}:${t.text}`),
    suspicion: h.app.variables.getValue(h.storyId, 'suspicion', marta()),
    clock: h.app.stories.getStory(h.storyId)!.clockMin,
    changes: h.app.variables.listChanges(h.storyId).length,
  });
  /** Round 2: Marta notes a thought, the narrator raises her suspicion. */
  const roundTwo = async (tag: string) => {
    h.script.characters['Marta'] = [...(h.script.characters['Marta'] ?? []), JSON.stringify({ say: `Rooms are two silver (${tag}).`, remember: [{ kind: 'opinion', about: '#kael', importance: 6, text: `He paid fast (${tag}).` }] })];
    h.script.characters['Tom'] = [...(h.script.characters['Tom'] ?? []), JSON.stringify({ say: '' })];
    h.script.narrator.push(round(`She names her price (${tag}).`, { briefs: { '#marta': `Kael pays (${tag}).` }, vars: [{ who: '#marta', key: 'suspicion', delta: tag === 'A' ? 10 : 30 }], time: 20 }));
  };

  it('regenerate the last reply, then Revert: the previous reply and everything it changed come back', async () => {
    h = mindsHarness();
    await h.opening();
    await roundTwo('A');
    await h.play('"A room."');
    const before = state();
    expect(before.suspicion).toBe(30);

    await roundTwo('B');
    const c = collector();
    await h.app.pipeline.retry(h.storyId, c.emitter);
    expect(c.final?.narration).toBe('She names her price (B).');
    expect(h.app.snapshots.undoInfo(h.storyId)).toMatchObject({ action: 'regenerate', label: 'Bring back the previous reply' });
    expect(state()).not.toEqual(before);

    expect(await h.app.pipeline.undo(h.storyId)).toMatchObject({ action: 'regenerate' });
    expect(state()).toEqual(before);
    expect(h.app.snapshots.undoInfo(h.storyId)).toBeUndefined(); // once

    // The restored reply is a normal last turn: it can be regenerated again.
    await roundTwo('C');
    const c2 = collector();
    await h.app.pipeline.retry(h.storyId, c2.emitter);
    expect(c2.final?.narration).toBe('She names her price (C).');
  });

  it('regenerating an earlier reply takes later turns with it; Revert brings them all back', async () => {
    h = mindsHarness();
    await h.opening();
    await roundTwo('A');
    const first = await h.play('"A room."');
    await roundTwo('A');
    await h.play('"And a meal."');
    const before = state();

    await roundTwo('B');
    await h.app.pipeline.retry(h.storyId, collector().emitter, { turnId: first.final!.id });
    expect(h.app.snapshots.undoInfo(h.storyId)?.label).toBe('Bring back the 2 replaced replies');
    await h.app.pipeline.undo(h.storyId);
    expect(state()).toEqual(before);
  });

  it('Edit and remove of the last exchange can be reverted; a new message ends the chance', async () => {
    h = mindsHarness();
    await h.opening();
    await roundTwo('A');
    await h.play('"A room."');
    const before = state();

    await h.app.pipeline.rewind(h.storyId);
    expect(h.app.snapshots.undoInfo(h.storyId)?.action).toBe('rewind');
    await h.app.pipeline.undo(h.storyId);
    expect(state()).toEqual(before);

    await h.app.pipeline.rewind(h.storyId, { action: 'remove' });
    expect(h.app.snapshots.undoInfo(h.storyId)?.label).toBe('Restore the removed exchange');
    await roundTwo('B');
    await h.play('"Something else."');
    expect(h.app.snapshots.undoInfo(h.storyId)).toBeUndefined();
  });

  it('a failed attempt leaves nothing to revert', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    // No narrator reply scripted: the turn fails.
    await h.play('"Hello?"');
    expect(h.app.stories.lastTurn(h.storyId)!.status).not.toBe('complete');
    await h.app.pipeline.rewind(h.storyId);
    expect(h.app.snapshots.undoInfo(h.storyId)).toBeUndefined();
  });

  it('older messages: an edit or a removal of the text can be reverted through the API', async () => {
    h = mindsHarness();
    await h.opening();
    await roundTwo('A');
    const t2 = (await h.play('"A room."')).final!;
    await roundTwo('A');
    await h.play('"A meal."');
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/turns/${t2.id}`, payload: { narration: 'Edited.' } });
    expect((await server.inject({ method: 'GET', url: `/api/stories/${h.storyId}/undo` })).json()).toMatchObject({ action: 'edit-text', label: 'Undo the edit' });
    await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/undo`, payload: {} });
    expect(h.app.stories.getTurn(t2.id)!.narration).toBe('She names her price (A).');

    await server.inject({ method: 'DELETE', url: `/api/stories/${h.storyId}/turns/${t2.id}` });
    expect(h.app.stories.getTurn(t2.id)).toBeUndefined();
    const res = await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/undo`, payload: {} });
    expect(res.json()).toMatchObject({ ok: true, action: 'remove-text' });
    expect(h.app.stories.getTurn(t2.id)!.playerInput).toBe('"A room."');
    expect((await server.inject({ method: 'POST', url: `/api/stories/${h.storyId}/undo`, payload: {} })).statusCode).toBe(404);
    await server.close();
  });
});
