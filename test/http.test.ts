import { describe, it, expect } from 'vitest';
import { requestWithRetry } from '../src/llm/http.ts';

describe('requestWithRetry (rate-limit backoff)', () => {
  it('retries a 429 and returns the eventual success', async () => {
    let calls = 0;
    const res = await requestWithRetry(
      async () => {
        calls++;
        return calls < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok', { status: 200 });
      },
      { maxRetries: 3 },
    );
    expect(calls).toBe(3);
    expect(res.status).toBe(200);
  });

  it('gives up after maxRetries and returns the last throttled response', async () => {
    let calls = 0;
    const res = await requestWithRetry(
      async () => {
        calls++;
        return new Response('nope', { status: 429, headers: { 'retry-after': '0' } });
      },
      { maxRetries: 2 },
    );
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(res.status).toBe(429);
  });

  it('does not retry a normal error status', async () => {
    let calls = 0;
    const res = await requestWithRetry(async () => {
      calls++;
      return new Response('bad', { status: 400 });
    });
    expect(calls).toBe(1);
    expect(res.status).toBe(400);
  });

  it('aborts the backoff wait when the signal fires', async () => {
    const ac = new AbortController();
    const p = requestWithRetry(async () => new Response('x', { status: 429, headers: { 'retry-after': '30' } }), { maxRetries: 3, signal: ac.signal });
    ac.abort(new Error('cancelled'));
    await expect(p).rejects.toThrow();
  });
});
