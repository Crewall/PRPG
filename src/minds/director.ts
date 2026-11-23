import type { Story, Turn } from '../domain.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { logger } from '../util/logger.ts';
import type { Declaration } from './builders.ts';
import type { PlayerDeclaration } from './contracts.ts';
import { labelFor, knowsName } from './names.ts';
import type { RoundDeps } from './round.ts';

// Who the player's words are meant for (docs/10 §5.1b). Obvious cases are
// settled by rules; otherwise a Light-tier director reads the people present
// (as the player knows them), the last lines spoken and the player's message.
// No answer (or a failed call) means no direction: the gate works as before.

export interface DirectionResult {
  /** Object ids the player's words are meant for. */
  to: string[];
  all: boolean;
  /** Object ids not spoken to who would plausibly react anyway. */
  react: string[];
  source: 'none' | 'rule' | 'director';
  why?: string;
}

export const NO_DIRECTION: DirectionResult = { to: [], all: false, react: [], source: 'none' };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text: string, word: string, flags = '') => new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}(?![\\p{L}\\p{N}])`, `u${flags}`).test(text);

/** Present people the player's message points at: by #handle, a name the player knows, or their known-as label. */
function mentioned(deps: RoundDeps, storyId: string, playerId: string | null, presentIds: string[], text: string): string[] {
  return presentIds.filter((oid) => {
    const obj = deps.memory.getObject(oid);
    if (!obj) return false;
    if (obj.handle && hasWord(text.toLowerCase(), `#${obj.handle}`)) return true;
    if (knowsName(deps, storyId, playerId, oid)) {
      const first = obj.name.split(/\s+/)[0];
      if (hasWord(text, obj.name) || (first.length >= 3 && hasWord(text, first))) return true;
    }
    const label = deps.sheets.get(oid)?.knownAs.replace(/^(the|a|an)\s+/i, '').trim();
    return !!label && label.split(/\s+/).length >= 1 && label.length >= 4 && hasWord(text, label, 'i');
  });
}

/** Who spoke to the player last round (their reply goes back to them). */
function spokeToPlayer(deps: RoundDeps, playerId: string | null, lastRound: Turn | undefined, presentIds: string[]): string[] {
  if (!playerId || !lastRound) return [];
  const handle = `#${deps.memory.getObject(playerId)?.handle ?? ''}`.toLowerCase();
  const decls = (lastRound.meta.declarations ?? []) as Declaration[];
  return decls
    .filter((d) => d.status === 'acted' && d.say?.trim() && (d.to ?? '').trim().toLowerCase() === handle && presentIds.includes(d.objectId))
    .map((d) => d.objectId);
}

export async function resolveDirection(
  deps: RoundDeps,
  story: Story,
  turn: Turn,
  decl: PlayerDeclaration,
  ctx: { presentIds: string[]; playerId: string | null; lastRound: Turn | undefined; signal: AbortSignal },
): Promise<DirectionResult> {
  const { presentIds, playerId, lastRound, signal } = ctx;
  if (!decl.say.trim() || !presentIds.length) return NO_DIRECTION;
  if (presentIds.length === 1) return { ...NO_DIRECTION, to: [presentIds[0]], source: 'rule', why: 'the only one here' };
  const named = mentioned(deps, story.id, playerId, presentIds, `${decl.say}\n${decl.do}`);
  if (named.length === 1) return { ...NO_DIRECTION, to: named, source: 'rule', why: 'named in the message' };
  if (!named.length && !decl.do.trim()) {
    const askers = spokeToPlayer(deps, playerId, lastRound, presentIds);
    if (askers.length === 1) return { ...NO_DIRECTION, to: askers, source: 'rule', why: 'a reply to who spoke last' };
  }

  // Ambiguous: ask the director.
  try {
    const bound = deps.registry.getForRole('director', story.settings.roles.director);
    const session = deps.agents.ensureSession(story.id, 'director', bound.name);
    const pLabel = playerId ? labelFor(deps, story.id, playerId, playerId) : 'The player character';
    const people = presentIds.map((oid) => {
      const sheet = deps.sheets.get(oid);
      const known = knowsName(deps, story.id, playerId, oid);
      const who = known ? deps.memory.getObject(oid)?.name : sheet?.knownAs || 'someone';
      return `- ${labelFor(deps, story.id, playerId, oid).split(' ')[0]} (${who}${sheet?.pronouns ? `, ${sheet.pronouns}` : ''}): ${sheet?.appearance || '—'}`;
    });
    const lines: string[] = [];
    if (lastRound) {
      const lastDecl = lastRound.meta.player as PlayerDeclaration | undefined;
      if (lastDecl?.say) lines.push(`- ${pLabel} (the player): "${lastDecl.say}"`);
      for (const d of (lastRound.meta.declarations ?? []) as Declaration[]) {
        if (d.status === 'acted' && d.say?.trim() && presentIds.includes(d.objectId)) {
          lines.push(`- ${labelFor(deps, story.id, playerId, d.objectId)}${d.to ? ` to ${d.to}` : ''}: "${d.say.trim()}"`);
        }
      }
    }
    const user = [
      `People present:\n${people.join('\n')}`,
      `The last lines spoken:\n${lines.join('\n') || '(none yet)'}`,
      `The player (${pLabel.split(' ')[0]}) now says: "${decl.say}"${decl.do ? `\nand does: ${decl.do}` : ''}`,
      'Who are these words meant for? Reply as JSON.',
    ].join('\n\n');
    const reply = await new MindAgent({ session, bound, threadLog: deps.threadLog, storyId: story.id }).direct(
      { system: renderPrompt('minds-director', {}), messages: [{ role: 'user', content: user }] },
      { turnId: turn.id, signal },
    );
    const resolve = (keys: string[]) =>
      [...new Set(keys.map((k) => deps.memory.findByHandle(story.id, k)?.id).filter((x): x is string => !!x && presentIds.includes(x)))];
    const to = resolve(reply.to);
    const react = resolve(reply.react).filter((x) => !to.includes(x));
    if (!to.length && !reply.all) return { ...NO_DIRECTION, react, source: 'director', why: reply.why };
    return { to, all: reply.all, react, source: 'director', why: reply.why };
  } catch (err) {
    if (signal.aborted) throw err;
    logger.warn('director failed — no direction this round', { storyId: story.id, err: (err as Error).message });
    return NO_DIRECTION;
  }
}
