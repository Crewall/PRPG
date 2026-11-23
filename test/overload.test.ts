import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestWithRetry } from '../src/llm/http.ts';
import { openaiDriver, buildOpenAiBody } from '../src/llm/openaiDriver.ts';
import type { ChatRequest } from '../src/llm/types.ts';
import { migrate, openDb } from '../src/db/db.ts';
import { createJobStore } from '../src/db/stores/jobStore.ts';
import { mindsHarness, round } from './fixtures/minds.ts';

// Ready for overloaded providers: real waits, the tier's fallback model, job backoff, re-seeding.

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], ...over });
const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });

describe('provider overloads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for OpenRouter's rate-limit reset when it names one, and says so", async () => {
    const reset = Date.now() + 200;
    let calls = 0;
    const waits: number[] = [];
    const res = await requestWithRetry(
      async () => {
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ error: { code: 429, metadata: { headers: { 'X-RateLimit-Reset': String(reset) } } } }), { status: 429 })
          : new Response('ok', { status: 200 });
      },
      { maxRetries: 2, onWait: (ms) => waits.push(ms) },
    );
    expect(res.status).toBe(200);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(300);
    expect(waits[0]).toBeLessThan(1500);
  });

  it('OpenRouter gets the fallback as its own models list; other providers switch model when overloaded', async () => {
    expect(buildOpenAiBody(req({ fallbackModels: ['b'] }), 'openrouter').models).toEqual(['m', 'b']);
    expect(buildOpenAiBody(req({ fallbackModels: ['b'] }), 'deepseek').models).toBeUndefined();

    const models: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      models.push(model);
      return model === 'busy-model' ? new Response('{"error":{"message":"overloaded"}}', { status: 503 }) : sse('Hi from the fallback.');
    });
    const driver = openaiDriver({ apiKey: 'k', baseUrl: 'https://api.example.test/v1', preset: 'custom', maxRetries: 1, transientDelayMs: 1, throttleDelayMs: 5 });
    const waits: number[] = [];
    const r = await driver.chat(req({ model: 'busy-model', fallbackModels: ['spare-model'], onWait: (i) => waits.push(i.waitMs) }));
    expect(r.text).toBe('Hi from the fallback.');
    expect(models).toEqual(['busy-model', 'busy-model', 'spare-model']); // one wait-and-retry, then the fallback
    expect(waits).toHaveLength(1);
  }, 15_000);
});

describe('background jobs back off', () => {
  it('a failed attempt waits before it is picked up again; Retry now clears the wait', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prpg-jobs-'));
    const db = openDb(join(dir, 'j.db'));
    migrate(db);
    try {
      const jobs = createJobStore(db);
      const job = jobs.enqueue('minds_seed', { payload: { objectId: 'x' } });
      const claimed = jobs.claimNext()!;
      expect(claimed.id).toBe(job.id);
      expect(jobs.markFailedOrRetry(job.id, 'HTTP 429', 3)).toBe('pending');
      expect(jobs.claimNext()).toBeUndefined(); // waiting
      expect(jobs.claimNext({ ignoreWait: true })?.id).toBe(job.id); // tests drain everything
      jobs.markFailedOrRetry(job.id, 'HTTP 429', 1);
      expect(jobs.get(job.id)!.status).toBe('failed');
      jobs.retry(job.id);
      expect(jobs.claimNext()?.id).toBe(job.id); // retry now: no wait, attempts start over
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a mind that failed to be written is tried again', () => {
  it('each round re-queues seeding for a present character still without a mind', async () => {
    const h = mindsHarness();
    try {
      await h.opening(); // queues seeds for Marta and Tom
      const seeds = () => h.app.db.prepare(`SELECT status FROM jobs WHERE type = 'minds_seed' ORDER BY created_at`).all<{ status: string }>().map((r) => r.status);
      h.app.db.prepare(`UPDATE jobs SET status = 'failed' WHERE type = 'minds_seed'`).run(); // the provider was down
      h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
      h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
      h.script.director.push(JSON.stringify({ to: [], all: true }));
      h.script.narrator.push(round('Rain.', { briefs: {} }));
      await h.play('"Hello."');
      expect(seeds()).toEqual(['failed', 'failed', 'pending', 'pending']);
      // Still waiting: the next round adds nothing.
      h.script.characters['Marta'].push(JSON.stringify({ say: '' }));
      h.script.characters['Tom'].push(JSON.stringify({ say: '' }));
      h.script.director.push(JSON.stringify({ to: [], all: true }));
      h.script.narrator.push(round('More rain.', { briefs: {} }));
      await h.play('"Hello again."');
      expect(seeds()).toHaveLength(4);
    } finally {
      h.close();
    }
  });
});
