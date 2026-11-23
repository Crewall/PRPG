import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import { CharacterReplySchema, CharacterReplyWire, DialogueReplySchema, DialogueReplyWire, DirectionReply, RoundBlockSchema } from '../minds/contracts.ts';
import { zodToJsonSchema } from '../llm/jsonSchema.ts';

const REPLY_WIRE_SCHEMA = zodToJsonSchema(CharacterReplyWire);
const DIALOGUE_WIRE_SCHEMA = zodToJsonSchema(DialogueReplyWire);
import type { CharacterReply, DialogueReply, Direction, RoundBlock } from '../minds/contracts.ts';

// Minds engine agents (docs/10). Contexts come from src/minds/builders.ts (the
// isolation boundary); replies are parsed leniently in src/minds/contracts.ts.

export const SeedReply = z.unknown().transform((raw) => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const thoughts = Array.isArray(r.thoughts) ? r.thoughts : [];
  return {
    description: str(r.description),
    appearance: str(r.appearance),
    pronouns: str(r.pronouns).slice(0, 40),
    state: str(r.state),
    values: r.values && typeof r.values === 'object' && !Array.isArray(r.values) ? (r.values as Record<string, unknown>) : {},
    ties: Object.fromEntries(
      Object.entries(r.ties && typeof r.ties === 'object' && !Array.isArray(r.ties) ? (r.ties as Record<string, unknown>) : {})
        .filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()),
    ),
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

/** The compactor's reply: the recap text, plus (characters only) up to three proposed pins. */
export const CompactReply = z.unknown().transform((raw) => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pins = Array.isArray(r.pins) ? r.pins : [];
  return {
    recap: typeof r.recap === 'string' ? r.recap.trim() : '',
    pins: pins
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof (t as { text?: unknown }).text === 'string' && !!String((t as { text: string }).text).trim())
      .slice(0, 3)
      .map((t) => ({ text: String(t.text).trim(), tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [] })),
  };
});
export type CompactReply = z.infer<typeof CompactReply>;

export class MindAgent extends Agent {
  /** A character's declaration for this round, plus its raw text (stored byte-exact in its thread). */
  async declare(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<{ reply: CharacterReply & { problems: string[] }; raw: string }> {
    const { value, raw } = await this.invokeJsonRaw(ctx, CharacterReplySchema, { ...opts, jsonSchema: REPLY_WIRE_SCHEMA });
    return { reply: value, raw };
  }

  /** Dialogue mode: one conversational reply, plus its raw text (stored byte-exact). */
  async converse(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<{ reply: DialogueReply & { problems: string[] }; raw: string }> {
    const { value, raw } = await this.invokeJsonRaw(ctx, DialogueReplySchema, { ...opts, jsonSchema: DIALOGUE_WIRE_SCHEMA });
    return { reply: value, raw };
  }

  /** The distributor: a round block rebuilt from the narrator's prose. */
  async distribute(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<RoundBlock> {
    return this.invokeJson(ctx, RoundBlockSchema, opts);
  }

  /** The director: who the player's words are meant for (docs/10 §5.1b). */
  async direct(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<Direction> {
    return this.invokeJson(ctx, DirectionReply, { ...opts, maxTokens: 300 });
  }

  /** The compactor: a recap of a thread's oldest rounds. */
  async compact(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number } = {}): Promise<CompactReply> {
    return this.invokeJson(ctx, CompactReply, opts);
  }

  /** The seeder: a new character's description, state, starting values and thoughts. */
  async seed(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number } = {}): Promise<SeedReply> {
    return this.invokeJson(ctx, SeedReply, opts);
  }
}
