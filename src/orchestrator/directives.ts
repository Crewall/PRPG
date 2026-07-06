import { z } from 'zod';

// Storyteller output contract (04-agents.md): narration text plus an optional
// fenced ```directives block the orchestrator strips before display. Layer 2
// parses all directive types but only acts on scene_break; the rest are wired
// up in Layer 4.

export const Directive = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene_break'), title: z.string().optional(), carryNpcs: z.array(z.string()).optional() }),
  z.object({ type: z.literal('consult_npc'), npcName: z.string(), situation: z.string().optional(), expects: z.string().optional() }),
  z.object({ type: z.literal('npc_enter'), name: z.string() }),
  z.object({ type: z.literal('npc_exit'), name: z.string() }),
  z.object({ type: z.literal('roll'), kind: z.string().optional(), difficulty: z.string().optional() }),
]);
export type Directive = z.infer<typeof Directive>;

const DirectiveBlock = z.object({ directives: z.array(z.unknown()) });

export interface ParsedTurn {
  narration: string;
  directives: Directive[];
}

const FENCE_RE = /```directives\s*([\s\S]*?)```/i;

/**
 * Split a storyteller draft into player-visible narration and structured
 * directives. Unknown/invalid directives are dropped (fail-open to plain
 * narration) rather than throwing — a malformed block never breaks a turn.
 */
export function parseDirectives(draft: string): ParsedTurn {
  const match = draft.match(FENCE_RE);
  if (!match) return { narration: draft.trim(), directives: [] };

  const narration = draft.replace(FENCE_RE, '').trim();
  const directives: Directive[] = [];
  try {
    const block = DirectiveBlock.parse(JSON.parse(match[1].trim()));
    for (const raw of block.directives) {
      const parsed = Directive.safeParse(raw);
      if (parsed.success) directives.push(parsed.data);
    }
  } catch {
    // Malformed directive block — ignore it, keep the narration.
  }
  return { narration, directives };
}
