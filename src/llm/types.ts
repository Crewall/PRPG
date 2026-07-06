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
  temperature?: number;
  maxTokens?: number;
  /** When set, the driver nudges/forces JSON output. */
  jsonSchema?: object;
  /** Abort long generations (regeneration, user cancel). */
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  stopReason?: string;
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
