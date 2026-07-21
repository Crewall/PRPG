import { z } from 'zod';
import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';

// An NPC's structured reply (doc 04). dialogue/action are woven by the
// storyteller; innerState is stored but never shown to the player; revealsFactIds
// become player knowledge links.
export const NpcReply = z.object({
  dialogue: z.string().default(''),
  action: z.string().optional(),
  innerState: z.string().optional(),
  revealsFactIds: z.array(z.string()).default([]),
});
export type NpcReply = z.infer<typeof NpcReply>;

// NPC Story Mode (docs/09): the per-round reply. dialogue/intent are woven by
// the storyteller (intent is an ATTEMPT — the storyteller decides outcomes);
// innerState is subtext for the storyteller only; notes is the NPC's own
// private story, fully rewritten each round it acts.
export const NpcRoundReply = z.object({
  dialogue: z.string().default(''),
  intent: z.string().optional(),
  innerState: z.string().optional(),
  notes: z.string().default(''),
});
export type NpcRoundReply = z.infer<typeof NpcRoundReply>;

// npc_seed output (NPC Story Mode): a freshly generated mind for a character
// that has no profile yet.
export const NpcSeedReply = z.object({
  personality: z.string(),
  notes: z.string(),
});
export type NpcSeedReply = z.infer<typeof NpcSeedReply>;

/**
 * NPC agent (Layer 4). One session per active major NPC. Its context is built
 * exclusively from `getObjectView(npc, {kind:'npc'})` — the isolation boundary,
 * so an NPC never sees another NPC's persona or knowledge. In NPC Story Mode
 * the context comes from the NPC's narrative profile instead (`forNpcRound`),
 * with the same isolation guarantee.
 */
export class NpcAgent extends Agent {
  async respond(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<NpcReply> {
    return this.invokeJson(ctx, NpcReply, opts);
  }

  /** NPC Story Mode: one proactive round — what do you say/intend, plus rewritten notes. */
  async respondRound(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<NpcRoundReply> {
    return this.invokeJson(ctx, NpcRoundReply, opts);
  }

  /** NPC Story Mode: seed a personality + opening notes for a profile-less NPC. */
  async seed(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal; maxTokens?: number } = {}): Promise<NpcSeedReply> {
    return this.invokeJson(ctx, NpcSeedReply, opts);
  }
}
