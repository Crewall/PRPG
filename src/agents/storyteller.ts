import { Agent } from './agent.ts';
import type { BuiltContext } from './agent.ts';
import type { OnDelta } from '../llm/types.ts';

/**
 * Storyteller v1 (Layer 1): pure narration, no directives yet. The single
 * player-facing agent. Context is assembled by the orchestrator's contextBuilder.
 */
export class Storyteller extends Agent {
  /** Stream a narration for the built context. Returns the full text. */
  async narrate(ctx: BuiltContext, onDelta?: OnDelta, opts: { turnId?: string; signal?: AbortSignal } = {}): Promise<string> {
    return this.invoke(ctx, onDelta, opts);
  }
}
