// Shared request helper: retry a rate-limited/overloaded call with backoff.
// OpenRouter free models (and any low-tier key) return 429 under load; without
// backoff the job worker just re-fires and keeps getting throttled. Here we
// honor Retry-After when present, else use bounded exponential backoff.

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

/** Milliseconds to wait per a Retry-After header (seconds or HTTP-date), if usable. */
function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * Issue `make()` and, on 429/503, wait and retry up to `maxRetries` times.
 * Anything else (success, other errors, or exhausted retries) is returned as-is
 * for the caller to handle. Respects an AbortSignal so the driver timeout still
 * bounds the total wait.
 */
export async function requestWithRetry(
  make: () => Promise<Response>,
  opts: { signal?: AbortSignal; maxRetries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 1000;
  for (let attempt = 0; ; attempt++) {
    const res = await make();
    const throttled = res.status === 429 || res.status === 503;
    if (!throttled || attempt >= maxRetries) return res;
    const wait = retryAfterMs(res) ?? Math.min(base * 2 ** attempt, 30_000);
    await res.body?.cancel().catch(() => {}); // free the socket before waiting
    await sleep(wait, opts.signal);
  }
}
