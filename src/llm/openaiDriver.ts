import type { ChatRequest, ChatResult, LlmDriver, OnDelta } from './types.ts';
import { LlmError, parseSse } from './types.ts';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl: string; // e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1
  timeoutMs?: number;
}

/**
 * OpenAI-compatible chat-completions driver (streaming). Covers OpenRouter,
 * DeepSeek, local llama.cpp/ollama servers — one driver, many backends.
 */
export function openaiDriver(opts: OpenAiOptions): LlmDriver {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    kind: 'openai_compat',
    async chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult> {
      const wantJson = !!req.jsonSchema;
      const messages = [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
      if (req.signal) {
        req.signal.addEventListener('abort', () => controller.abort(req.signal!.reason), { once: true });
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.8,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (wantJson) body.response_format = { type: 'json_object' };

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        throw new LlmError(`openai request failed: ${(err as Error).message}`, undefined, true);
      }

      if (!res.ok || !res.body) {
        clearTimeout(timer);
        const detail = await res.text().catch(() => '');
        throw new LlmError(
          `openai HTTP ${res.status}: ${detail.slice(0, 500)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }

      let text = '';
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
          const choice = evt.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === 'string' && delta) {
            text += delta;
            onDelta?.(delta);
          }
          if (choice?.finish_reason) stopReason = choice.finish_reason;
          if (evt.usage) {
            inputTokens = evt.usage.prompt_tokens ?? inputTokens;
            outputTokens = evt.usage.completion_tokens ?? outputTokens;
          }
        }
      } finally {
        clearTimeout(timer);
      }

      return { text, usage: { inputTokens, outputTokens }, model: req.model, stopReason };
    },
  };
}
