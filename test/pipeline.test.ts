import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { Turn } from '../src/domain.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// Deterministic storyteller: echoes how many prior turns it was given (proves the
// context builder includes full history) and streams in chunks.
function echoDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const priorTurns = req.messages.filter((m) => m.role === 'assistant').length;
      const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
      const text = `Narration #${priorTurns + 1} (heard: "${lastUser.slice(0, 30)}")`;
      if (onDelta) for (const ch of text.match(/.{1,8}/g) ?? []) onDelta(ch);
      return { text, usage: { inputTokens: 10, outputTokens: 20 }, model: req.model };
    },
  };
}

interface Collector {
  emitter: TurnEmitter;
  events: string[];
  deltas: string[];
  final: Turn | null;
}
function collector(): Collector {
  const c: Collector = { events: [], deltas: [], final: null, emitter: null as unknown as TurnEmitter };
  c.emitter = {
    accepted: (id) => c.events.push(`accepted:${id}`),
    status: (t) => c.events.push(`status:${t}`),
    delta: (t) => { c.deltas.push(t); c.events.push('delta'); },
    final: (turn) => { c.final = turn; c.events.push('final'); },
    rejected: (_id, r) => c.events.push(`rejected:${r}`),
    error: (_id, m) => c.events.push(`error:${m}`),
  };
  return c;
}

describe('TurnPipeline (Layer 1)', () => {
  let dir: string;
  let app: App;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-'));
    app = createApp(config, { driverFactory: () => echoDriver(), dbPath: join(dir, 'test.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a turn end-to-end: streams, persists, logs threads', async () => {
    const story = app.stories.createStory({ title: 'T', settings: { premise: 'A dark tavern.' } });
    const c = collector();
    const turn = await app.pipeline.run(story.id, 'I open the door.', c.emitter);

    expect(turn?.status).toBe('complete');
    expect(c.deltas.join('')).toBe(turn?.narration);
    expect(turn?.narration).toContain('Narration #1');
    expect(c.events[0]).toMatch(/^accepted:/);
    expect(c.events.at(-1)).toBe('final');

    // Persisted turn.
    const stored = app.stories.listTurns(story.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].playerInput).toBe('I open the door.');
    expect(stored[0].meta.outputTokensEst).toBeGreaterThan(0);

    // Thread log recorded both request and response.
    const logs = app.threadLog.query(story.id);
    expect(logs.some((l) => l.direction === 'request')).toBe(true);
    expect(logs.some((l) => l.direction === 'response')).toBe(true);
  });

  it('includes full history so later turns see earlier ones', async () => {
    const story = app.stories.createStory({ title: 'T' });
    await app.pipeline.run(story.id, 'first', collector().emitter);
    const c2 = collector();
    const t2 = await app.pipeline.run(story.id, 'second', c2.emitter);
    expect(t2?.narration).toContain('Narration #2'); // saw 1 prior assistant turn
  });

  it('serializes turns per story (mutex)', async () => {
    const story = app.stories.createStory({ title: 'T' });
    const [a, b] = await Promise.all([
      app.pipeline.run(story.id, 'A', collector().emitter),
      app.pipeline.run(story.id, 'B', collector().emitter),
    ]);
    expect([a?.index, b?.index].sort()).toEqual([0, 1]);
  });

  it('survives a restart and continues the story', async () => {
    const story = app.stories.createStory({ title: 'Persistent' });
    await app.pipeline.run(story.id, 'turn one', collector().emitter);
    app.close();

    // Reopen the same DB file — simulates a server restart.
    const app2 = createApp(config, { driverFactory: () => echoDriver(), dbPath: join(dir, 'test.db'), startWorker: false });
    const reloaded = app2.stories.getStory(story.id);
    expect(reloaded?.title).toBe('Persistent');
    expect(app2.stories.listTurns(story.id)).toHaveLength(1);

    const t2 = await app2.pipeline.run(story.id, 'turn two', collector().emitter);
    expect(t2?.index).toBe(1);
    expect(app2.stories.listTurns(story.id)).toHaveLength(2);
    app = app2; // hand app2 to afterEach for cleanup (original handle already closed)
  });

  it('rejects a turn on cancel', async () => {
    // Driver that hangs until aborted.
    const hangingDriver: LlmDriver = {
      kind: 'anthropic',
      chat: (req) =>
        new Promise((_res, rej) => {
          req.signal?.addEventListener('abort', () => rej(req.signal!.reason));
        }),
    };
    const localDir = mkdtempSync(join(tmpdir(), 'prpg-c-'));
    const capp = createApp(config, { driverFactory: () => hangingDriver, dbPath: join(localDir, 'c.db'), startWorker: false });
    const story = capp.stories.createStory({ title: 'Cancel' });
    const c = collector();
    const runP = capp.pipeline.run(story.id, 'go', c.emitter);
    // Give the pipeline a tick to register the aborter, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    capp.pipeline.cancel(story.id);
    const turn = await runP;
    expect(turn?.status).toBe('rejected');
    expect(c.events.some((e) => e.startsWith('rejected'))).toBe(true);
    capp.close();
    rmSync(localDir, { recursive: true, force: true });
  });
});
