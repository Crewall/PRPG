import type { ChatRequest, ChatResult, LlmDriver, OnDelta, Usage } from './types.ts';
import { LlmError, parseSse } from './types.ts';
import { requestWithRetry } from './http.ts';
import type { ProviderPreset } from '../config/config.ts';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl: string; // e.g. https://api.deepseek.com, https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1
  /** Which provider is behind the URL; turns on that provider's extra parameters. */
  preset?: ProviderPreset;
  timeoutMs?: number;
  maxRetries?: number;
}

/** The request body for one chat completion (exported for tests). */
export function buildOpenAiBody(req: ChatRequest, preset: ProviderPreset = 'custom'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
    max_tokens: req.maxTokens ?? 2048,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Only when set: reasoning models (and some providers) reject or ignore it.
  if (req.temperature !== undefined) body.temperature = req.temperature;

  // JSON output (doc 12 §5.3–5.4).
  if (req.jsonSchema) {
    let mode = req.jsonMode ?? 'json_object';
    if (mode === 'schema' && preset === 'deepseek') mode = 'json_object'; // DeepSeek has JSON mode only
    if (mode === 'schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: 'reply', strict: false, schema: req.jsonSchema } };
      // Route only to OpenRouter endpoints that actually support structured outputs.
      if (preset === 'openrouter') body.provider = { require_parameters: true };
    } else if (mode === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
  }

  // Reasoning switches. `reasoning` arrives already filtered by the model's caps.
  if (preset === 'deepseek') {
    if (req.reasoning === 'off') body.thinking = { type: 'disabled' };
    if (req.reasoning === 'on') body.thinking = { type: 'enabled' };
    if (req.effort && req.reasoning !== 'off') body.reasoning_effort = req.effort === 'max' ? 'max' : req.effort === 'low' ? 'low' : 'high';
  } else if (preset === 'openrouter') {
    if (req.reasoning === 'off') body.reasoning = { enabled: false };
    else if (req.effort) body.reasoning = { effort: req.effort };
    else if (req.reasoning === 'on') body.reasoning = { enabled: true };
  } else if (preset === 'openai' && req.effort) {
    body.reasoning_effort = req.effort === 'max' ? 'high' : req.effort;
  }

  // OpenRouter sticky routing: one session per agent thread keeps it on the
  // same upstream provider, so that provider's prompt cache keeps hitting.
  if (preset === 'openrouter' && req.sessionKey) body.session_id = req.sessionKey.slice(0, 256);
  return body;
}

/** Normalize a provider's usage object (exported for tests). */
export function normalizeUsage(u: Record<string, any>): Usage {
  const usage: Usage = { inputTokens: Number(u.prompt_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? 0) };
  // DeepSeek reports cache hits/misses at the top level; OpenAI/OpenRouter under prompt_tokens_details.
  const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  if (cacheRead !== undefined && cacheRead !== null) usage.cacheReadTokens = Number(cacheRead);
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens;
  if (cacheWrite !== undefined && cacheWrite !== null) usage.cacheWriteTokens = Number(cacheWrite);
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) usage.reasoningTokens = Number(reasoning);
  if (typeof u.cost === 'number') usage.cost = u.cost;
  return usage;
}

function friendlyHttpError(status: number, detail: string, preset: ProviderPreset): string {
  if (status === 429 && preset === 'openrouter') {
    return `OpenRouter rate limit reached (free models: 20 requests/minute and a daily cap that depends on purchased credits). Wait a bit, or switch this tier to another model or provider. Details: ${detail.slice(0, 300)}`;
  }
  if (status === 401 || status === 403) return `the provider rejected the API key (HTTP ${status}). Check it in Settings → Providers. Details: ${detail.slice(0, 300)}`;
  if (status === 402) return `the provider reports insufficient credits or balance (HTTP 402). Details: ${detail.slice(0, 300)}`;
  return `HTTP ${status}: ${detail.slice(0, 500)}`;
}

/**
 * OpenAI-compatible chat-completions driver (streaming). Covers DeepSeek,
 * OpenRouter, OpenAI and local llama.cpp/Ollama servers — one driver, with
 * per-provider extras switched on by `preset`.
 */
export function openaiDriver(opts: OpenAiOptions): LlmDriver {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const preset = opts.preset ?? 'custom';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 2;

  return {
    kind: 'openai_compat',
    async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
      const body = buildOpenAiBody(req, preset);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      if (req.signal) {
        req.signal.addEventListener('abort', () => controller.abort(req.signal!.reason), { once: true });
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

      let res: Response;
      try {
        res = await requestWithRetry(
          () => fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }),
          { signal: controller.signal, maxRetries },
        );
      } catch (err) {
        clearTimeout(timer);
        throw new LlmError(`request failed: ${(err as Error).message}`, undefined, true);
      }

      if (!res.ok || !res.body) {
        clearTimeout(timer);
        const detail = await res.text().catch(() => '');
        throw new LlmError(friendlyHttpError(res.status, detail, preset), res.status, res.status === 429 || res.status >= 500);
      }

      let text = '';
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stopReason: string | undefined;
      try {
        for await (const data of parseSse(res.body)) {
          if (!data || data === '[DONE]') continue;
          let evt: any;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          // Errors after the stream started arrive as an SSE event (OpenRouter).
          if (evt.error) {
            const code = Number(evt.error.code);
            throw new LlmError(`stream error: ${evt.error.message ?? 'unknown'}`, Number.isFinite(code) ? code : undefined, code === 429 || code >= 500);
          }
          const choice = evt.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta?.(delta);
          }
          // Reasoning text (delta.reasoning_content / reasoning / reasoning_details) is never shown or kept.
          if (choice?.finish_reason) stopReason = choice.finish_reason;
          if (evt.usage) usage = normalizeUsage(evt.usage);
        }
      } finally {
        clearTimeout(timer);
      }
      if (stopReason === 'error') throw new LlmError('the provider ended the stream with an error', undefined, true);

      return { text, usage, model: req.model, stopReason };
    },
  };
}
