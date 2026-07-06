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

/**
 * NPC agent (Layer 4). One session per active major NPC. Its context is built
 * exclusively from `getObjectView(npc, {kind:'npc'})` — the isolation boundary,
 * so an NPC never sees another NPC's persona or knowledge.
 */
export class NpcAgent extends Agent {
  async respond(ctx: BuiltContext, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<NpcReply> {
    return this.invokeJson(ctx, NpcReply, opts);
  }
}
