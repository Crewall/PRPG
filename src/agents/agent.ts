import type { z } from 'zod';
import type { BoundDriver } from '../llm/registry.ts';
import type { ChatMessage, OnDelta, Usage } from '../llm/types.ts';
import { addUsage } from '../llm/types.ts';
import { callJson } from '../llm/jsonCall.ts';
import type { JsonCallContext } from '../llm/jsonCall.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { AgentSession } from '../domain.ts';
import { estimateTokens } from '../util/tokens.ts';
import { logger } from '../util/logger.ts';

// An empty (0-token) reply is a model failure, not a finished response: retry
// this many times before giving up and failing the call (and thus the turn).
const MAX_EMPTY_RETRIES = 2;

// A fully-assembled context for one agent call: the isolation boundary — an
// agent never builds this itself, the orchestrator's contextBuilder does.
export interface BuiltContext {
  system: string;
  messages: ChatMessage[];
}

export interface AgentDeps {
  session: AgentSession;
  bound: BoundDriver;
  threadLog: ThreadLog;
  storyId: string;
}

/**
 * Common agent base: streamed free-text `invoke` and schema-enforced `invokeJson`.
 * Both paths write the full request and response into thread_log so the debug UI
 * (and sqlite CLI at Layer 1) can inspect every agent interaction.
 */
export abstract class Agent {
  protected readonly session: AgentSession;
  protected readonly bound: BoundDriver;
  protected readonly threadLog: ThreadLog;
  protected readonly storyId: string;

  constructor(deps: AgentDeps) {
    this.session = deps.session;
    this.bound = deps.bound;
    this.threadLog = deps.threadLog;
    this.storyId = deps.storyId;
  }

  protected logRequest(ctx: BuiltContext, turnId?: string): void {
    this.threadLog.log({
      storyId: this.storyId,
      turnId: turnId ?? null,
      sessionId: this.session.id,
      agentRole: this.session.role,
      direction: 'request',
      connectionId: this.bound.profile.connectionId ?? this.bound.profile.provider,
      payload: { system: ctx.system, messages: ctx.messages, model: this.bound.profile.model },
      tokensIn: estimateTokens(ctx.system) + ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    });
  }

  protected logResponse(text: string, meta: { durationMs: number; usage: Usage; turnId?: string; extra?: Record<string, unknown> }): void {
    this.threadLog.log({
      storyId: this.storyId,
      turnId: meta.turnId ?? null,
      sessionId: this.session.id,
      agentRole: this.session.role,
      direction: 'response',
      connectionId: this.bound.profile.connectionId ?? this.bound.profile.provider,
      payload: { text, ...(meta.extra ?? {}) },
      tokensIn: meta.usage.inputTokens,
      tokensOut: meta.usage.outputTokens,
      cacheRead: meta.usage.cacheReadTokens,
      cacheWrite: meta.usage.cacheWriteTokens,
      reasoningTokens: meta.usage.reasoningTokens,
      cost: meta.usage.cost,
      durationMs: meta.durationMs,
    });
  }

  /**
   * A call that failed (provider error, timeout, cancel, unusable JSON) still
   * gets its response row, so the Threads view shows why instead of a request
   * that seems to hang forever.
   */
  protected logFailure(err: unknown, durationMs: number, turnId?: string, raw = '', usage: Usage = { inputTokens: 0, outputTokens: 0 }): void {
    this.logResponse(raw, { durationMs, usage, turnId, extra: { error: (err as Error)?.message ?? String(err) } });
  }

  /**
   * Free-text call with streaming (storyteller, NPC dialogue). An empty reply
   * is treated as a failed attempt and retried (an empty reply never emitted a
   * delta, so a retry cannot duplicate streamed text); after the retries are
   * exhausted the call throws so the turn is marked as an error, not complete.
   */
  protected async invoke(ctx: BuiltContext, onDelta?: OnDelta, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      this.logRequest(ctx, opts.turnId);
      const t0 = Date.now();
      let res;
      try {
        res = await this.bound.chat({ system: ctx.system, messages: ctx.messages, signal: opts.signal, sessionKey: this.session.id }, onDelta);
      } catch (err) {
        this.logFailure(err, Date.now() - t0, opts.turnId);
        throw err;
      }
      const empty = res.text.trim().length === 0;
      this.logResponse(res.text, {
        durationMs: Date.now() - t0,
        usage: res.usage,
        turnId: opts.turnId,
        extra: { stopReason: res.stopReason, ...(empty ? { empty: true, attempt: attempt + 1 } : {}) },
      });
      if (!empty) return res.text;
      if (opts.signal?.aborted) throw new Error('cancelled');
      if (attempt >= MAX_EMPTY_RETRIES) {
        throw new Error(`the model returned an empty reply (${attempt + 1} attempts)`);
      }
      logger.warn('empty model reply — retrying', { role: this.session.role, storyId: this.storyId, attempt: attempt + 1 });
    }
  }

  /** Schema-enforced JSON call with auto repair-retry and cap-escalation (scribes, overseer, NPC replies). */
  protected async invokeJson<S extends z.ZodTypeAny>(ctx: BuiltContext, schema: S, opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number } = {}): Promise<z.infer<S>> {
    return (await this.invokeJsonRaw(ctx, schema, opts)).value;
  }

  /**
   * invokeJson that also returns the model's final raw text, byte for byte —
   * Minds threads store replies exactly as received (docs/10 §8).
   */
  protected async invokeJsonRaw<S extends z.ZodTypeAny>(
    ctx: BuiltContext,
    schema: S,
    opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number; jsonSchema?: object } = {},
  ): Promise<{ value: z.infer<S>; raw: string }> {
    this.logRequest(ctx, opts.turnId);
    const t0 = Date.now();
    const jsonCtx: JsonCallContext = { system: ctx.system, messages: ctx.messages, signal: opts.signal, sessionKey: this.session.id };
    let lastRaw = '';
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let result: z.infer<S>;
    try {
      result = await callJson(this.bound, jsonCtx, schema, {
        onRaw: (raw) => (lastRaw = raw),
        onUsage: (u) => (usage = addUsage(usage, u)),
        maxTokens: opts.maxTokens,
        jsonSchema: opts.jsonSchema,
      });
    } catch (err) {
      this.logFailure(err, Date.now() - t0, opts.turnId, lastRaw, usage);
      throw err;
    }
    // Usage summed over every attempt (repairs/escalations are real calls);
    // estimate output from text only when the provider reported nothing.
    if (!usage.outputTokens) usage = { ...usage, outputTokens: estimateTokens(lastRaw) };
    this.logResponse(lastRaw, {
      durationMs: Date.now() - t0,
      usage,
      turnId: opts.turnId,
      extra: { parsed: result },
    });
    return { value: result, raw: lastRaw };
  }
}
