import type { ChatRequest, ChatResult, LlmDriver, OnDelta } from './types.ts';
import { LlmError, parseSse } from './types.ts';
import { requestWithRetry } from './http.ts';

const API_VERSION = '2023-06-01';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Anthropic Messages API driver (streaming). Uses fetch + SSE directly.
 * When jsonSchema is set we append a strong "reply with JSON only" system
 * instruction and prefill an opening brace — reliable and provider-portable.
 */
export function anthropicDriver(opts: AnthropicOptions): LlmDriver {
  const baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxRetries = opts.maxRetries ?? 2;

  return {
    kind: 'anthropic',
    async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
      const wantJson = !!req.jsonSchema;
      const system = wantJson
        ? `${req.system}\n\nYou must reply with a single valid JSON object and nothing else. No prose, no markdown fences.`
        : req.system;

      const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
      // Prefill the assistant turn with "{" to force JSON and suppress preamble.
      if (wantJson) messages.push({ role: 'assistant', content: '{' });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      if (req.signal) {
        req.signal.addEventListener('abort', () => controller.abort(req.signal!.reason), { once: true });
      }

      let res: Response;
      try {
        res = await requestWithRetry(
          () =>
            fetch(`${baseUrl}/v1/messages`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': opts.apiKey,
                'anthropic-version': API_VERSION,
              },
              body: JSON.stringify({
                model: req.model,
                system,
                messages,
                max_tokens: req.maxTokens ?? 2048,
                temperature: req.temperature ?? 0.8,
                stream: true,
              }),
              signal: controller.signal,
            }),
          { signal: controller.signal, maxRetries },
        );
      } catch (err) {
        clearTimeout(timer);
        throw new LlmError(`anthropic request failed: ${(err as Error).message}`, undefined, true);
      }

      if (!res.ok || !res.body) {
        clearTimeout(timer);
        const detail = await res.text().catch(() => '');
        throw new LlmError(
          `anthropic HTTP ${res.status}: ${detail.slice(0, 500)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      let text = wantJson ? '{' : '';
      let inputTokens = 0;
      let outputTokens = 0;
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
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            text += evt.delta.text;
            onDelta?.(evt.delta.text);
          } else if (evt.type === 'message_start') {
            inputTokens = evt.message?.usage?.input_tokens ?? 0;
          } else if (evt.type === 'message_delta') {
            outputTokens = evt.usage?.output_tokens ?? outputTokens;
            stopReason = evt.delta?.stop_reason ?? stopReason;
          } else if (evt.type === 'error') {
            throw new LlmError(`anthropic stream error: ${evt.error?.message ?? 'unknown'}`);
          }
        }
      } finally {
        clearTimeout(timer);
      }

      return { text, usage: { inputTokens, outputTokens }, model: req.model, stopReason };
    },
  };
}
