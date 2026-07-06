import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResult, LlmDriver, OnDelta } from '../../src/llm/types.ts';
import type { BoundDriver } from '../../src/llm/registry.ts';
import type { ModelProfile } from '../../src/config/config.ts';

/** Wrap a raw driver as a BoundDriver so callJson/agents can use it in tests. */
export function asBound(driver: LlmDriver, name = 'test'): BoundDriver {
  const profile: ModelProfile = { provider: driver.kind, model: 'test-model', temperature: 0.5, maxTokens: 1024, contextWindow: 200_000 };
  return {
    name,
    profile,
    driver,
    chat: (req, onDelta) =>
      driver.chat(
        { model: profile.model, temperature: req.temperature ?? profile.temperature, maxTokens: req.maxTokens ?? profile.maxTokens, system: req.system, messages: req.messages, jsonSchema: req.jsonSchema, signal: req.signal },
        onDelta,
      ),
  };
}

export interface Recording {
  key: string;
  request: { model: string; system: string; messages: ChatRequest['messages']; json: boolean };
  result: ChatResult;
}

/** Stable hash of the semantically relevant request fields (ignores signal). */
export function requestKey(req: ChatRequest): string {
  const h = createHash('sha256');
  h.update(JSON.stringify({ model: req.model, system: req.system, messages: req.messages, json: !!req.jsonSchema }));
  return h.digest('hex').slice(0, 16);
}

/** Wraps a real driver, forwarding calls and recording every exchange to `path`. */
export function recordingDriver(inner: LlmDriver, path: string): LlmDriver {
  const recordings: Recording[] = [];
  return {
    kind: inner.kind,
    async chat(req, onDelta) {
      const result = await inner.chat(req, onDelta);
      recordings.push({
        key: requestKey(req),
        request: { model: req.model, system: req.system, messages: req.messages, json: !!req.jsonSchema },
        result,
      });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(recordings, null, 2));
      return result;
    },
  };
}

/**
 * Deterministic driver for tests. Replays recorded results — by request key
 * when available, otherwise in call order. Re-emits the recorded text through
 * onDelta in chunks so streaming paths are exercised too.
 */
export function replayDriver(
  source: Recording[] | string,
  opts: { kind?: LlmDriver['kind']; chunk?: number } = {},
): LlmDriver {
  const recordings: Recording[] = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
  const byKey = new Map<string, Recording[]>();
  for (const r of recordings) {
    const list = byKey.get(r.key) ?? [];
    list.push(r);
    byKey.set(r.key, list);
  }
  let cursor = 0;
  const chunk = opts.chunk ?? 24;

  return {
    kind: opts.kind ?? 'anthropic',
    async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
      const key = requestKey(req);
      let rec: Recording | undefined;
      const matches = byKey.get(key);
      if (matches && matches.length) {
        rec = matches.shift();
      } else {
        rec = recordings[cursor];
      }
      cursor++;
      if (!rec) throw new Error(`replayDriver: no recording for request (key=${key}, cursor=${cursor})`);
      if (onDelta) {
        for (let i = 0; i < rec.result.text.length; i += chunk) {
          onDelta(rec.result.text.slice(i, i + chunk));
        }
      }
      return rec.result;
    },
  };
}

/** Convenience: an in-memory scripted driver for unit tests. */
export function scriptedDriver(replies: (string | ChatResult)[], kind: LlmDriver['kind'] = 'anthropic'): LlmDriver {
  let i = 0;
  return {
    kind,
    async chat(_req, onDelta) {
      const r = replies[i++];
      if (r === undefined) throw new Error('scriptedDriver: out of replies');
      const result: ChatResult =
        typeof r === 'string'
          ? { text: r, usage: { inputTokens: 0, outputTokens: 0 }, model: _req.model }
          : r;
      if (onDelta) onDelta(result.text);
      return result;
    },
  };
}
