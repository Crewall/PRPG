import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { buildOpenAiBody, normalizeUsage, openaiDriver } from '../src/llm/openaiDriver.ts';
import { zodToJsonSchema } from '../src/llm/jsonSchema.ts';
import { callJson } from '../src/llm/jsonCall.ts';
import { createRegistry } from '../src/llm/registry.ts';
import type { EffectiveConfig } from '../src/config/config.ts';
import type { ChatRequest, ChatResult, LlmDriver } from '../src/llm/types.ts';
import { openDb, migrate } from '../src/db/db.ts';
import { createUsageStore, utcDay } from '../src/db/stores/usageStore.ts';
import { createThreadLog } from '../src/db/stores/threadLog.ts';
import { createAgentStore } from '../src/db/stores/agentStore.ts';
import { NpcAgent } from '../src/agents/npcAgent.ts';
import { asBound } from './fixtures/drivers.ts';

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
  ...over,
});

describe('OpenAI-compatible request bodies per provider', () => {
  it('DeepSeek: thinking switch, effort, JSON mode, no temperature unless set', () => {
    const off = buildOpenAiBody(req({ reasoning: 'off', jsonSchema: { type: 'object' }, jsonMode: 'json_object' }), 'deepseek');
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.reasoning_effort).toBeUndefined();
    expect(off.response_format).toEqual({ type: 'json_object' });
    expect('temperature' in off).toBe(false);

    const on = buildOpenAiBody(req({ reasoning: 'on', effort: 'medium', temperature: 0.7 }), 'deepseek');
    expect(on.thinking).toEqual({ type: 'enabled' });
    expect(on.reasoning_effort).toBe('high'); // DeepSeek effort levels: low / high / max
    expect(on.temperature).toBe(0.7);
    expect(on.session_id).toBeUndefined();

    // DeepSeek has JSON mode only: a schema request degrades to json_object.
    const schema = buildOpenAiBody(req({ jsonSchema: { type: 'object' }, jsonMode: 'schema' }), 'deepseek');
    expect(schema.response_format).toEqual({ type: 'json_object' });
  });

  it('OpenRouter: sticky session, reasoning object, structured outputs routed to supporting endpoints', () => {
    const body = buildOpenAiBody(
      req({ reasoning: 'off', sessionKey: 'sess-123', jsonSchema: { type: 'object', properties: {} }, jsonMode: 'schema' }),
      'openrouter',
    );
    expect(body.session_id).toBe('sess-123');
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'reply', strict: false, schema: { type: 'object', properties: {} } } });
    expect(body.provider).toEqual({ require_parameters: true });

    expect(buildOpenAiBody(req({ effort: 'low' }), 'openrouter').reasoning).toEqual({ effort: 'low' });
    expect(buildOpenAiBody(req({ reasoning: 'on' }), 'openrouter').reasoning).toEqual({ enabled: true });
    expect(buildOpenAiBody(req({ jsonSchema: {}, jsonMode: 'prompt' }), 'openrouter').response_format).toBeUndefined();
  });

  it('custom endpoints get no provider-specific parameters', () => {
    const body = buildOpenAiBody(req({ reasoning: 'off', effort: 'high', sessionKey: 's' }), 'custom');
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.session_id).toBeUndefined();
  });

  it('normalizes usage: DeepSeek cache hit/miss, OpenRouter cached/write tokens, reasoning, cost', () => {
    expect(normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 })).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 900,
    });
    expect(
      normalizeUsage({
        prompt_tokens: 500,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 12 },
        cost: 0.0004,
      }),
    ).toEqual({ inputTokens: 500, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 20, reasoningTokens: 12, cost: 0.0004 });
  });
});

/** A fetch stub answering with an SSE stream of the given events. */
function sseResponse(events: unknown[], status = 200): Response {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('openaiDriver streaming', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('streams content, drops reasoning text, and reads usage from the final chunk', async () => {
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return sseResponse([
        { choices: [{ delta: { reasoning_content: 'let me think…' } }] },
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' there' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 2, prompt_cache_hit_tokens: 100 } },
        '[DONE]',
      ]);
    });
    const deltas: string[] = [];
    const res = await openaiDriver({ apiKey: 'k', baseUrl: 'https://api.deepseek.com', preset: 'deepseek' }).chat(req({ reasoning: 'off' }), (d) => deltas.push(d));
    expect(res.text).toBe('Hello there');
    expect(deltas.join('')).toBe('Hello there');
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 2, cacheReadTokens: 100 });
    expect(sentBody.thinking).toEqual({ type: 'disabled' });
  });

  it('fails the call cleanly on a mid-stream error event', async () => {
    vi.stubGlobal('fetch', async () =>
      sseResponse([{ choices: [{ delta: { content: 'Par' } }] }, { error: { code: 502, message: 'upstream died' }, choices: [{ delta: { content: '' }, finish_reason: 'error' }] }]),
    );
    await expect(openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter' }).chat(req())).rejects.toThrow(/upstream died/);
  });

  it('fails on finish_reason "error" even without an error object', async () => {
    vi.stubGlobal('fetch', async () => sseResponse([{ choices: [{ delta: { content: 'x' }, finish_reason: 'error' }] }]));
    await expect(openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter' }).chat(req())).rejects.toThrow(/ended the stream with an error/);
  });

  it('retries a transient provider error (502, or an error event) when nothing has streamed yet', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) return new Response('{"error":{"code":502,"message":"Provider returned error"}}', { status: 502 });
      if (calls === 2) return sseResponse([{ error: { code: 502, message: 'Provider returned error' } }]);
      return sseResponse([{ choices: [{ delta: { content: 'Fine.' }, finish_reason: 'stop' }] }, '[DONE]']);
    });
    const deltas: string[] = [];
    const driver = openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter', transientDelayMs: 1 });
    const r = await driver.chat(req(), (d) => deltas.push(d));
    expect(r.text).toBe('Fine.');
    expect(deltas).toEqual(['Fine.']);
    expect(calls).toBe(3);

    calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"error":{"code":502,"message":"Provider returned error"}}', { status: 502 });
    });
    await expect(driver.chat(req())).rejects.toThrow(/502/);
    expect(calls).toBe(3); // 1 + 2 retries, then the error surfaces
  });

  it('explains an OpenRouter rate limit in plain words', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":{"code":429,"message":"Rate limit exceeded"}}', { status: 429 }));
    await expect(openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter', maxRetries: 0 }).chat(req())).rejects.toThrow(
      /OpenRouter rate limit reached/,
    );
  });
});

describe('zodToJsonSchema', () => {
  it('converts the shapes our reply contracts use', () => {
    const schema = z.object({
      say: z.string().default(''),
      intent: z.string().optional(),
      mood: z.enum(['calm', 'angry']),
      tags: z.array(z.string()),
      score: z.number().int().min(0).max(10),
      note: z.string().nullable(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        say: { type: 'string' },
        intent: { type: 'string' },
        mood: { type: 'string', enum: ['calm', 'angry'] },
        tags: { type: 'array', items: { type: 'string' } },
        score: { type: 'integer', minimum: 0, maximum: 10 },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['mood', 'tags', 'score', 'note'],
      additionalProperties: false,
    });
  });
});

describe('callJson with provider quirks', () => {
  it('retries a whitespace-only reply (DeepSeek JSON mode) and reports usage per attempt', async () => {
    const replies: ChatResult[] = [
      { text: '    ', usage: { inputTokens: 50, outputTokens: 1 }, model: 'm' },
      { text: '{"ok":true}', usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 40 }, model: 'm' },
    ];
    const seen: ChatRequest[] = [];
    const driver: LlmDriver = {
      kind: 'openai_compat',
      async chat(r) {
        seen.push(r);
        return replies.shift()!;
      },
    };
    const usages: unknown[] = [];
    const out = await callJson(asBound(driver), { system: 's', messages: [{ role: 'user', content: 'go' }], sessionKey: 'thread-1' }, z.object({ ok: z.boolean() }), {
      onUsage: (u) => usages.push(u),
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[0].messages).toHaveLength(1); // a plain re-ask, not a "fix your JSON" repair
    expect(seen[0].jsonSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
    expect(seen[0].sessionKey).toBe('thread-1');
    expect(usages).toHaveLength(2);
  });
});

describe('request counting and usage logging', () => {
  it('counts each model call per connection per UTC day', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const usage = createUsageStore(db);
    const config: EffectiveConfig = {
      connections: { ds: { id: 'ds', label: 'DeepSeek', kind: 'openai_compat', preset: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'k' } },
      modelProfiles: { 'role:npc': { connectionId: 'ds', provider: 'openai_compat', preset: 'deepseek', model: 'deepseek-flash', maxTokens: 100, contextWindow: 1000 } },
      roles: { npc: 'role:npc' },
      llm: { timeoutMs: 1000, maxRetries: 0 },
    };
    const driver: LlmDriver = { kind: 'openai_compat', chat: async (r) => ({ text: 'x', usage: { inputTokens: 1, outputTokens: 1 }, model: r.model }) };
    const registry = createRegistry(() => config, () => driver, { onRequest: (c) => usage.increment(c) });
    await registry.getForRole('npc').chat({ system: 's', messages: [] });
    await registry.getForRole('npc').chat({ system: 's', messages: [] });
    expect(usage.countsFor()).toEqual({ ds: 2 });
    expect(usage.countsFor('2000-01-01')).toEqual({});
    expect(utcDay(Date.UTC(2026, 10, 22, 23, 59))).toBe('2026-11-22');
    db.close();
  });

  it('JSON agent calls log real usage, cache reads and the connection (not 0 input tokens)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const threadLog = createThreadLog(db);
    const agents = createAgentStore(db);
    db.prepare(`INSERT INTO stories (id, title, settings_json, created_at, updated_at) VALUES ('st', 't', '{}', 0, 0)`).run();
    const session = agents.ensureSession('st', 'npc', 'role:npc');
    const driver: LlmDriver = {
      kind: 'openai_compat',
      chat: async (r) => ({
        text: JSON.stringify({ dialogue: 'Hm.', notes: '- noted' }),
        usage: { inputTokens: 800, outputTokens: 12, cacheReadTokens: 700, cost: 0.0001 },
        model: r.model,
      }),
    };
    const bound = asBound(driver);
    const agent = new NpcAgent({ session, bound: { ...bound, profile: { ...bound.profile, connectionId: 'openrouter' } }, threadLog, storyId: 'st' });
    await agent.respondRound({ system: 's', messages: [{ role: 'user', content: 'go' }] });
    const [resp] = threadLog.query('st', { limit: 10 }).filter((e) => e.direction === 'response');
    expect(resp.tokensIn).toBe(800);
    expect(resp.tokensOut).toBe(12);
    expect(resp.cacheRead).toBe(700);
    expect(resp.cost).toBe(0.0001);
    expect(resp.connectionId).toBe('openrouter');
    db.close();
  });
});

describe('mandatory reasoning (OpenRouter ERNIE regression)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('model caps from the real OpenRouter listing: mandatory → always, only the offered efforts', async () => {
    const { capsFromListing } = await import('../src/config/config.ts');
    const params = ['include_reasoning', 'max_tokens', 'reasoning', 'reasoning_effort', 'response_format', 'structured_outputs', 'temperature'];
    expect(capsFromListing({ supported_parameters: params, reasoning: { mandatory: true, supported_efforts: ['high'] } }, 'openrouter')).toEqual({
      sampling: true,
      reasoning: 'always',
      json: 'schema',
      efforts: ['high'],
    });
    expect(capsFromListing({ supported_parameters: params, reasoning: { mandatory: false, supported_efforts: ['max', 'high', 'low', 'none'] } }, 'openrouter')).toEqual({
      sampling: true,
      reasoning: 'toggle',
      json: 'schema',
      efforts: ['max', 'high', 'low'],
    });
    expect(capsFromListing({ supported_parameters: ['temperature', 'response_format'] }, 'openrouter')).toEqual({ sampling: true, reasoning: 'none', json: 'json_object' });
  });

  it('a rejected reasoning switch is retried once without it, and not sent again for that model', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.reasoning && String(body.model).startsWith('baidu/')) return new Response('{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled.","code":400}}', { status: 400 });
      return sseResponse([{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }, '[DONE]']);
    });
    const driver = openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter', maxRetries: 0 });
    const first = await driver.chat(req({ model: 'baidu/ernie-5.5-flash-preview:free', reasoning: 'off' }));
    expect(first.text).toBe('OK');
    expect(bodies.map((b) => 'reasoning' in b)).toEqual([true, false]);
    await driver.chat(req({ model: 'baidu/ernie-5.5-flash-preview:free', reasoning: 'off', effort: 'low' }));
    expect(bodies.slice(2).map((b) => 'reasoning' in b)).toEqual([false]); // learned: one request, no switch
    await driver.chat(req({ model: 'other/model', reasoning: 'off' }));
    expect(bodies.at(-1)!.reasoning).toEqual({ enabled: false }); // other models unaffected
  });

  it('other 400s are not retried', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"error":{"message":"No such model"}}', { status: 400 });
    });
    const driver = openaiDriver({ apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', preset: 'openrouter', maxRetries: 0 });
    await expect(driver.chat(req({ reasoning: 'off' }))).rejects.toThrow(/No such model/);
    expect(calls).toBe(1);
  });
});
