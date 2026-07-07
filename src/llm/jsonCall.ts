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
/** A stop reason meaning the model was cut off at its output-token limit. */
function isTruncated(stopReason: string | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
}

/**
 * Schema-enforced JSON completion with two independent recovery paths (04-agents.md):
 *
 * 1. **Repair retry** (×1) — when a reply is malformed or fails schema validation,
 *    we send the errors back and ask for corrected JSON.
 * 2. **Cap escalation** (×2) — when a reply was cut off at the model's output-token
 *    limit (stop_reason `max_tokens`/`length`), asking it to "fix" an unfinishable
 *    string is futile; instead we re-request with a larger `maxTokens` budget.
 *    This is what prevents the `scribe_memory` "Unterminated string" failures on
 *    large MemoryDeltas.
 *
 * `opts.maxTokens` overrides the profile's default budget for the first call (used
 * to give the player-intake dossier a bigger allowance up front).
 */
export async function callJson<S extends z.ZodTypeAny>(
  bound: BoundDriver,
  ctx: JsonCallContext,
  schema: S,
  opts: { onRaw?: (raw: string, attempt: number) => void; onDelta?: OnDelta; maxTokens?: number } = {},
): Promise<z.infer<S>> {
  const messages: ChatMessage[] = [...ctx.messages];
  let lastRaw = '';

  const baseMax = opts.maxTokens ?? bound.profile.maxTokens ?? 2048;
  let currentMax = baseMax;
  const CAP_CEILING = Math.max(baseMax * 4, 8192);
  const MAX_REPAIRS = 1; // malformed/invalid JSON → one "fix it" round
  const MAX_ESCALATIONS = 2; // truncated at the cap → up to two budget bumps
  let repairs = 0;
  let escalations = 0;

  for (let attempt = 0; attempt < MAX_REPAIRS + MAX_ESCALATIONS + 1; attempt++) {
    const result = await bound.chat(
      { system: ctx.system, messages, jsonSchema: { type: 'object' }, signal: ctx.signal, maxTokens: currentMax },
      opts.onDelta,
    );
    lastRaw = result.text;
    opts.onRaw?.(result.text, attempt);
    const truncated = isTruncated(result.stopReason);

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      // Cut off at the token cap: give it more room rather than a doomed repair.
      if (truncated && escalations < MAX_ESCALATIONS && currentMax < CAP_CEILING) {
        escalations++;
        currentMax = Math.min(currentMax * 2, CAP_CEILING);
        continue; // same prompt, bigger budget
      }
      if (repairs < MAX_REPAIRS) {
        repairs++;
        messages.push({ role: 'assistant', content: result.text });
        messages.push({
          role: 'user',
          content: `Your reply was not valid JSON (${(err as Error).message}). Reply with only corrected JSON, no prose.`,
        });
        continue;
      }
      throw new JsonCallError(`invalid JSON after retry: ${(err as Error).message}`, lastRaw, attempt + 1);
    }

    const validated = schema.safeParse(parsed);
    if (validated.success) return validated.data;

    if (repairs < MAX_REPAIRS) {
      repairs++;
      const errText = validated.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      messages.push({ role: 'assistant', content: result.text });
      messages.push({
        role: 'user',
        content: `Your reply failed validation: ${errText}. Reply with only corrected JSON, no prose.`,
      });
      continue;
    }
    throw new JsonCallError(
      `schema validation failed after retry: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      lastRaw,
      attempt + 1,
    );
  }

  // Unreachable, but satisfies the type checker.
  throw new JsonCallError('callJson exhausted attempts', lastRaw, MAX_REPAIRS + MAX_ESCALATIONS + 1);
}
