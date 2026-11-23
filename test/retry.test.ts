import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { ChatRequest, LlmDriver } from '../src/llm/types.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { BEGIN_MARKER, CONTINUE_MARKER } from '../src/orchestrator/contextBuilder.ts';
import { StaleTurnError } from '../src/orchestrator/turnPipeline.ts';
import { mindsHarness, round, fail, collector } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';

// Failed turns, Retry, the guarded rewind and blank input (bug reports from play).

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

/** Classic storyteller: answers in order from `replies` (a function throws), records each request. */
function classicDriver(replies: (string | Error)[], seen: ChatRequest[]): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      // Only the storyteller streams; background scribes (not drained here) never get this far in these tests.
      seen.push(req);
      const next = replies.shift() ?? 'More story.';
      if (next instanceof Error) throw next;
      onDelta?.(next);
      return { text: next, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('classic engine: blank input, failed attempts, retry', () => {
  let dir: string;
  let app: App;
  let replies: (string | Error)[];
  let seen: ChatRequest[];
  let storyId: string;
  const play = async (input: string) => {
    const c = collector();
    await app.pipeline.run(storyId, input, c.emitter);
    return c;
  };
  const lastUser = () => seen.at(-1)!.messages.at(-1)!.content;
  const turns = () => app.stories.listTurns(storyId).map((t) => `${t.playerInput || '∅'}:${t.status}`);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-retry-'));
    replies = [];
    seen = [];
    app = createApp(config, { driverFactory: () => classicDriver(replies, seen), dbPath: join(dir, 'r.db'), startWorker: false });
    storyId = app.stories.createStory({ title: 'T', settings: { premise: 'A dark tavern.', context: { summaryDriven: false }, adjudicator: { enabled: false } } as never }).id;
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a blank message opens the story only once; later it means "go on"', async () => {
    replies.push('N1', 'N2', 'N3');
    await play('');
    expect(lastUser()).toBe(BEGIN_MARKER);
    await play('I look around.');
    await play('');
    expect(lastUser()).toBe(CONTINUE_MARKER);
    const msgs = seen.at(-1)!.messages.map((m) => m.content);
    expect(msgs[0]).toBe(BEGIN_MARKER); // the opening stays the opening in the history
    expect(msgs.filter((m) => m === BEGIN_MARKER)).toHaveLength(1);
  });

  it('the reported bug: a failed turn, then a blank send — the failed attempt is dropped, nothing reopens', async () => {
    replies.push('N1', 'N2', new Error('HTTP 502: provider returned error'));
    await play('');
    await play('"U1"');
    const failed = await play('"U2"');
    expect(failed.errors[0]).toMatch(/502/);
    expect(turns()).toEqual(['∅:complete', '"U1":complete', '"U2":error']);

    replies.push('N3');
    await play('');
    expect(turns()).toEqual(['∅:complete', '"U1":complete', '∅:complete']); // the failed U2 never happened
    expect(lastUser()).toBe(CONTINUE_MARKER);
    expect(seen.at(-1)!.messages.map((m) => m.content)).toEqual([BEGIN_MARKER, 'N1', '"U1"', 'N2', CONTINUE_MARKER]);
  });

  it('Retry re-runs a failed turn with the same message', async () => {
    replies.push('N1', new Error('timeout'));
    await play('');
    await play('"U1"');
    replies.push('N2');
    const c = collector();
    const t = await app.pipeline.retry(storyId, c.emitter);
    expect(t?.status).toBe('complete');
    expect(t?.playerInput).toBe('"U1"');
    expect(lastUser()).toBe('"U1"');
    expect(turns()).toEqual(['∅:complete', '"U1":complete']);
  });

  it('Retry on a good reply writes it again (the old one is replaced)', async () => {
    replies.push('N1', 'N2 first', 'N2 again');
    await play('');
    await play('"U1"');
    const c = collector();
    const t = await app.pipeline.retry(storyId, c.emitter);
    expect(t?.narration).toBe('N2 again');
    expect(app.stories.listTurns(storyId).map((x) => x.narration)).toEqual(['N1', 'N2 again']);
    expect(seen.at(-1)!.messages.map((m) => m.content)).toEqual([BEGIN_MARKER, 'N1', '"U1"']); // no trace of the first try
  });

  it('regenerating an earlier reply takes the later turns with it; too old a reply is refused', async () => {
    replies.push('N1', 'N2', 'N3', 'N2 again');
    await play('');
    await play('"U1"');
    await play('"U2"');
    const [t0, t1, t2] = app.stories.listTurns(storyId);
    const c = collector();
    const t = await app.pipeline.retry(storyId, c.emitter, { turnId: t1.id, expectTurnId: t2.id });
    expect(t?.narration).toBe('N2 again');
    expect(turns()).toEqual(['∅:complete', '"U1":complete']); // U2 and N3 went with it
    expect(seen.at(-1)!.messages.map((m) => m.content)).toEqual([BEGIN_MARKER, 'N1', '"U1"']);

    // A turn whose snapshot is gone can't be redone (unless it is the last one).
    app.snapshots.drop(t0.id);
    const c2 = collector();
    await app.pipeline.retry(storyId, c2.emitter, { turnId: t0.id });
    expect(c2.errors[0]).toMatch(/too far back/);
    expect(turns()).toEqual(['∅:complete', '"U1":complete']);

    const server = Fastify();
    await registerHttpRoutes(server, app);
    const list = (await server.inject({ method: 'GET', url: `/api/stories/${storyId}/turns` })).json() as { redoable: boolean }[];
    expect(list.map((x) => x.redoable)).toEqual([false, true]);
    await server.close();
  });

  it('a rewind or retry for a turn that is no longer the last is refused, never undoing an earlier turn', async () => {
    replies.push('N1', 'N2');
    await play('');
    const first = app.stories.listTurns(storyId)[0].id;
    await play('"U1"');
    await expect(app.pipeline.rewind(storyId, { expectTurnId: first })).rejects.toBeInstanceOf(StaleTurnError);
    const c = collector();
    await app.pipeline.retry(storyId, c.emitter, { expectTurnId: first });
    expect(c.errors[0]).toMatch(/story changed/);
    expect(turns()).toEqual(['∅:complete', '"U1":complete']);

    const server = Fastify();
    await registerHttpRoutes(server, app);
    const r = await server.inject({ method: 'POST', url: `/api/stories/${storyId}/rewind`, payload: { turnId: first } });
    expect(r.statusCode).toBe(409);
    expect(r.json().stale).toBe(true);
    const ok = await server.inject({ method: 'POST', url: `/api/stories/${storyId}/rewind`, payload: { turnId: app.stories.listTurns(storyId)[1].id } });
    expect(ok.statusCode).toBe(200);
    expect(turns()).toEqual(['∅:complete']);
    await server.close();
  });
});

describe('Minds: retry keeps the request; removing a past message keeps the minds\' memory', () => {
  let h: MindsHarness;
  beforeEach(() => {
    h = mindsHarness();
  });
  afterEach(() => h.close());

  it('Retry of a failed dialogue exchange talks to the same partner again', async () => {
    await h.opening();
    const marta = h.idOf('Marta');
    h.script.characters['Marta'] = [fail('provider 502'), JSON.stringify({ say: 'Two silver.' })];
    const c1 = await h.play('"A room?"', { dialogue: { partner: marta } });
    expect(c1.errors[0]).toMatch(/502/);
    const c2 = collector();
    const t = await h.app.pipeline.retry(h.storyId, c2.emitter);
    expect(t?.meta).toMatchObject({ mode: 'dialogue', partner: marta });
    expect(t?.narration).toBe('Marta: "Two silver."');
    expect(h.requests('narrator')).toHaveLength(1); // only the opening: the retry was an exchange, not a round
  });

  it('a failed round is dropped before the next one: its effects and its turn are gone', async () => {
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Yes?', state: 'Annoyed.' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(fail('provider 502'));
    await h.play('"Hello."');
    expect(h.app.stories.listTurns(h.storyId).at(-1)!.status).toBe('error');
    h.script.characters['Marta'].push(JSON.stringify({ say: 'Well?' }));
    h.script.characters['Tom'].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('');
    expect(h.app.stories.listTurns(h.storyId).map((t) => t.status)).toEqual(['complete', 'complete']);
    expect(h.requests('narrator').at(-1)!.messages.at(-1)!.content).not.toContain('Hello');
  });

  it('removing a past message from the transcript leaves every thread as it was', async () => {
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Yes?' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She looks up.', { briefs: {} }));
    await h.play('"Hello."');
    const turn = h.app.stories.listTurns(h.storyId)[1];
    const before = h.app.threads.log(h.sessionOf(h.idOf('Marta'))).map((m) => m.id);
    const server = Fastify();
    await registerHttpRoutes(server, h.app);
    await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/turns/${turn.id}`, payload: { playerInput: '' } });
    const r = await server.inject({ method: 'PATCH', url: `/api/stories/${h.storyId}/turns/${turn.id}`, payload: { narration: '' } });
    expect(r.json().deleted).toBe(true);
    expect(h.app.stories.listTurns(h.storyId)).toHaveLength(1);
    expect(h.app.threads.log(h.sessionOf(h.idOf('Marta'))).map((m) => m.id)).toEqual(before);
    expect(h.app.snapshots.has(turn.id)).toBe(false);
    await server.close();
  });
});

describe('M8: the old engines are retired', () => {
  let dir: string;
  let app: App;
  let server: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-m8-'));
    app = createApp(config, { driverFactory: () => classicDriver([], []), dbPath: join(dir, 'm8.db'), startWorker: false });
    server = Fastify();
    await registerHttpRoutes(server, app);
  });
  afterEach(async () => {
    await server.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new story is a Minds story, whatever the request asks', async () => {
    const r = await server.inject({ method: 'POST', url: '/api/stories', payload: { title: 'New', seed: 'A tavern.', settings: { engine: 'classic', npcStories: { enabled: true } } } });
    expect(r.statusCode).toBe(201);
    expect(r.json().settings).toMatchObject({ engine: 'minds', premise: 'A tavern.', npcStories: { enabled: false } });
  });

  it('a Minds story stays Minds; a legacy story keeps its engine or switches to Minds', async () => {
    const minds = (await server.inject({ method: 'POST', url: '/api/stories', payload: { title: 'M' } })).json();
    for (const settings of [{ engine: 'classic' }, { npcStories: { enabled: true } }]) {
      const r = await server.inject({ method: 'PATCH', url: `/api/stories/${minds.id}`, payload: { settings } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/retired/);
    }
    expect((await server.inject({ method: 'PATCH', url: `/api/stories/${minds.id}`, payload: { settings: { verbosity: 2 } } })).statusCode).toBe(200);

    const legacy = app.stories.createStory({ title: 'Old', settings: {} as never });
    expect(legacy.settings.engine).toBe('classic');
    const toNpc = await server.inject({ method: 'PATCH', url: `/api/stories/${legacy.id}`, payload: { settings: { engine: 'npc_stories' } } });
    expect(toNpc.statusCode).toBe(200);
    const toMinds = await server.inject({ method: 'PATCH', url: `/api/stories/${legacy.id}`, payload: { settings: { engine: 'minds' } } });
    expect(toMinds.json().settings.engine).toBe('minds');
  });
});
