import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { CharacterReplySchema, CharacterReplyWire, RoundBlockSchema } from '../minds/contracts.ts';
import { zodToJsonSchema } from '../llm/jsonSchema.ts';

const REPLY_WIRE_SCHEMA = zodToJsonSchema(CharacterReplyWire);
import type { CharacterReply, RoundBlock } from '../minds/contracts.ts';

// Minds engine agents (docs/10). Contexts come from src/minds/builders.ts (the
// isolation boundary); replies are parsed leniently in src/minds/contracts.ts.

export const SeedReply = z.unknown().transform((raw) => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const thoughts = Array.isArray(r.thoughts) ? r.thoughts : [];
  return {
    description: str(r.description),
    appearance: str(r.appearance),
    state: str(r.state),
    values: r.values && typeof r.values === 'object' && !Array.isArray(r.values) ? (r.values as Record<string, unknown>) : {},
    thoughts: thoughts
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string')
      .map((t) => ({
        text: String(t.text),
        tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
        pin: t.pin === true,
      })),
  };
});
export type SeedReply = z.infer<typeof SeedReply>;

export class MindAgent extends Agent {
  /** A character's declaration for this round, plus its raw text (stored byte-exact in its thread). */
  async declare(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<{ reply: CharacterReply & { problems: string[] }; raw: string }> {
    const { value, raw } = await this.invokeJsonRaw(ctx, CharacterReplySchema, { ...opts, jsonSchema: REPLY_WIRE_SCHEMA });
    return { reply: value, raw };
  }

  /** The distributor: a round block rebuilt from the narrator's prose. */
  async distribute(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<RoundBlock> {
    return this.invokeJson(ctx, RoundBlockSchema, opts);
  }

  /** The seeder: a new character's description, state, starting values and thoughts. */
  async seed(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number } = {}): Promise<SeedReply> {
    return this.invokeJson(ctx, SeedReply, opts);
  }
}
