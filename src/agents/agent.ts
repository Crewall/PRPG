import type { z } from 'zod';
import type { BoundDriver } from '../llm/registry.ts';
import type { ChatMessage, OnDelta } from '../llm/types.ts';
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
      payload: { system: ctx.system, messages: ctx.messages, model: this.bound.profile.model },
      tokensIn: estimateTokens(ctx.system) + ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    });
  }

  protected logResponse(text: string, meta: { durationMs: number; tokensIn: number; tokensOut: number; turnId?: string; extra?: Record<string, unknown> }): void {
    this.threadLog.log({
      storyId: this.storyId,
      turnId: meta.turnId ?? null,
      sessionId: this.session.id,
      agentRole: this.session.role,
      direction: 'response',
      payload: { text, ...(meta.extra ?? {}) },
      tokensIn: meta.tokensIn,
      tokensOut: meta.tokensOut,
      durationMs: meta.durationMs,
    });
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
      const res = await this.bound.chat({ system: ctx.system, messages: ctx.messages, signal: opts.signal }, onDelta);
      const empty = res.text.trim().length === 0;
      this.logResponse(res.text, {
        durationMs: Date.now() - t0,
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
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
    this.logRequest(ctx, opts.turnId);
    const t0 = Date.now();
    const jsonCtx: JsonCallContext = { system: ctx.system, messages: ctx.messages, signal: opts.signal };
    let lastRaw = '';
    const result = await callJson(this.bound, jsonCtx, schema, { onRaw: (raw) => (lastRaw = raw), maxTokens: opts.maxTokens });
    this.logResponse(lastRaw, {
      durationMs: Date.now() - t0,
      tokensIn: 0,
      tokensOut: estimateTokens(lastRaw),
      turnId: opts.turnId,
      extra: { parsed: result },
    });
    return result;
  }
}
