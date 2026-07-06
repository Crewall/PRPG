import type { z } from 'zod';
import type { BoundDriver } from './registry.ts';
import type { ChatMessage, OnDelta } from './types.ts';

export interface JsonCallContext {
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export class JsonCallError extends Error {
  readonly raw: string;
  readonly attempts: number;
  constructor(message: string, raw: string, attempts: number) {
    super(message);
    this.name = 'JsonCallError';
    this.raw = raw;
    this.attempts = attempts;
  }
}

/** Extract the first balanced JSON object/array from a possibly-noisy string. */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  // Strip a leading ```json / ``` fence if present.
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fence ? fence[1] : trimmed;
  const start = body.search(/[[{]/);
  if (start < 0) return body;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start); // unbalanced — let the parser report it
}

/**
 * Schema-enforced JSON completion with one automatic repair-retry, as specified
 * in 04-agents.md. On the first validation failure we send the parser errors
 * back and ask for corrected JSON; a second failure throws JsonCallError.
 */
export async function callJson<T>(
  bound: BoundDriver,
  ctx: JsonCallContext,
  schema: z.ZodType<T>,
  opts: { onRaw?: (raw: string, attempt: number) => void; onDelta?: OnDelta } = {},
): Promise<T> {
  const messages: ChatMessage[] = [...ctx.messages];
  let lastRaw = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await bound.chat(
      { system: ctx.system, messages, jsonSchema: { type: 'object' }, signal: ctx.signal },
      opts.onDelta,
    );
    lastRaw = result.text;
    opts.onRaw?.(result.text, attempt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      if (attempt === 1) throw new JsonCallError(`invalid JSON after retry: ${(err as Error).message}`, lastRaw, attempt + 1);
      messages.push({ role: 'assistant', content: result.text });
      messages.push({
        role: 'user',
        content: `Your reply was not valid JSON (${(err as Error).message}). Reply with only corrected JSON, no prose.`,
      });
      continue;
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) return validated.data;

    if (attempt === 1) {
      throw new JsonCallError(
        `schema validation failed after retry: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        lastRaw,
        attempt + 1,
      );
    }
    const errText = validated.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    messages.push({ role: 'assistant', content: result.text });
    messages.push({
      role: 'user',
      content: `Your reply failed validation: ${errText}. Reply with only corrected JSON, no prose.`,
    });
  }

  // Unreachable, but satisfies the type checker.
  throw new JsonCallError('callJson exhausted attempts', lastRaw, 2);
}
