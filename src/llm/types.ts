// The provider-agnostic LLM contract. See 01-tech-stack.md.
// Drivers are implemented with native fetch (no SDK) to keep the dependency
// tree tiny — important for the Termux constraint.

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  /** Undefined = the driver sends no temperature (some models reject it). */
  temperature?: number;
  maxTokens?: number;
  /** When set, the driver nudges/forces JSON output. A real JSON Schema when `jsonMode` is 'schema'. */
  jsonSchema?: object;
  /** How the model is asked for JSON (from the model's caps): structured outputs, JSON mode, or prompt only. */
  jsonMode?: 'schema' | 'json_object' | 'prompt';
  /** Reasoning switch (already filtered by the model's caps): undefined = send nothing. */
  reasoning?: 'off' | 'on' | 'default';
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Stable per agent thread; OpenRouter uses it to keep a thread on one upstream (cache hits). */
  sessionKey?: string;
  /** Abort long generations (regeneration, user cancel). */
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the cache (providers that bill cache writes). */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** Provider-reported cost of the call (OpenRouter: credits), when available. */
  cost?: number;
}

export interface ChatResult {
  text: string;
  usage: Usage;
  model: string;
  stopReason?: string;
}

/** Add usage `b` into `a` (for calls that retry internally). */
export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    cost: sum(a.cost, b.cost),
  };
}

export type OnDelta = (text: string) => void;

export interface LlmDriver {
  readonly kind: 'anthropic' | 'openai_compat';
  /** Streamed chat completion. Yields text deltas; resolves to the full message. */
  chat(req: ChatRequest, onDelta?: OnDelta): Promise<ChatResult>;
}

export class LlmError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** Parse a Server-Sent-Events byte stream into individual `data:` payload strings. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE events are separated by a blank line; emit each `data:` line.
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
