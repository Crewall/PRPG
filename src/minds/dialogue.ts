import type { Story, Turn } from '../domain.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { logger } from '../util/logger.ts';
import { buildCharacterCall, commitCall, hereFromScene, queueForCharacter } from './builders.ts';
import { parsePlayerInput, parseRoundBlock, emptyBlock } from './contracts.ts';
import type { DialogueReply, PlayerDeclaration } from './contracts.ts';
import { applyChanges, applyThoughtOps } from './service.ts';
import { STATE_KEY } from './variables.ts';
import type { RoundDeps, RoundEmitter } from './round.ts';

// Dialogue mode (docs/10 §7): a quick back-and-forth with one character. Each
// exchange is its own turn (so rewind and edit just work): the player's line
// goes to the partner's thread, the partner answers, nobody else is called.
// The next normal round wraps the conversation up (round.ts), so ending is
// just sending a normal message — or an empty one.

export interface DialogueOptions {
  signal: AbortSignal;
  partner: string;
  setStage?: (stage: string) => void;
}

/** How a partner's reply shows in the chat: Marta: "Rooms are two silver." (wipes the counter) */
export function renderDialogueLine(name: string, r: Pick<DialogueReply, 'say' | 'gesture'>): string {
  const gesture = r.gesture.trim() ? ` (${r.gesture.trim().replace(/^\(|\)$/g, '')})` : '';
  if (r.say.trim()) return `${name}: "${r.say.trim()}"${gesture}`;
  return gesture ? `${name}:${gesture}` : `${name} says nothing.`;
}

const handleLabel = (deps: RoundDeps, oid: string) => {
  const obj = deps.memory.getObject(oid);
  return `#${obj?.handle ?? deps.memory.ensureHandle(oid)} ${obj?.name ?? '?'}`;
};

/** The player's line as the partner hears and sees it. */
function playerLine(label: string, d: PlayerDeclaration): string {
  const said = d.say ? `${label}: "${d.say}"` : `${label} says nothing`;
  return d.do ? `${said} (${d.do})` : said;
}

/** Dialogue turns at the end of the story that no round has wrapped up yet, oldest first. */
export function openDialogueTurns(deps: RoundDeps, storyId: string, beforeIndex: number): Turn[] {
  const out: Turn[] = [];
  const turns = deps.stories.recentTurns(storyId, 200).filter((t) => t.status === 'complete' && t.index < beforeIndex);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].meta.mode !== 'dialogue') break;
    out.unshift(turns[i]);
  }
  return out;
}

/** The conversation as the narrator receives it at the wrap-up. */
export function renderTranscript(deps: RoundDeps, storyId: string, turns: Turn[]): string {
  const player = deps.sheets.player(storyId);
  const pLabel = player ? handleLabel(deps, player.objectId) : 'The player character';
  const lines: string[] = [];
  for (const t of turns) {
    const decl = t.meta.player as PlayerDeclaration | undefined;
    const reply = t.meta.reply as Pick<DialogueReply, 'say' | 'gesture'> | undefined;
    const partner = t.meta.partner as string;
    if (decl) {
      lines.push(`- ${playerLine(pLabel, decl)}`);
      if (decl.ooc) lines.push(`  (note to you from the player: ${decl.ooc})`);
    }
    if (reply) lines.push(`- ${renderDialogueLine(handleLabel(deps, partner), reply)}`);
  }
  return lines.join('\n');
}

export async function runDialogueExchange(deps: RoundDeps, story: Story, turn: Turn, playerInput: string, out: RoundEmitter, opts: DialogueOptions): Promise<Turn> {
  const t0 = Date.now();
  const storyId = story.id;
  const partner = opts.partner;
  opts.setStage?.('dialogue');

  const scene = story.currentSceneId ? deps.stories.getScene(story.currentSceneId) : undefined;
  const player = deps.sheets.player(storyId);
  const sheet = deps.sheets.get(partner);
  if (!sheet || sheet.storyId !== storyId || sheet.isPlayer || !scene?.activeNpcIds.includes(partner)) {
    throw new Error('that character is not here to talk to');
  }

  const decl = parsePlayerInput(playerInput);
  const pLabel = player ? handleLabel(deps, player.objectId) : 'The player character';
  // The last real round's block (exchanges carry none): its tags still colour what comes to mind.
  const previous = deps.stories.recentTurns(storyId, 60).filter((t) => t.status === 'complete' && t.index < turn.index && t.meta.mode !== 'dialogue').at(-1);
  const lastBlock = previous?.meta.block ? parseRoundBlock(previous.meta.block).block : emptyBlock();
  const handle = deps.memory.getObject(partner)?.handle ?? '';

  out.status(`${deps.memory.getObject(partner)?.name ?? 'They'} is answering…`);
  const sheetNow = deps.sheets.get(partner);
  const bound = deps.registry.getForRole('character', sheetNow?.tierId ? `tier:${sheetNow.tierId}` : story.settings.roles.character);
  const call = buildCharacterCall(deps, {
    storyId,
    objectId: partner,
    here: hereFromScene(deps, storyId, partner),
    situationTags: [...lastBlock.tags, ...(lastBlock.evoke[`#${handle}`] ?? [])],
    now: playerLine(pLabel, decl),
    conversationWith: pLabel,
  });
  const agent = new MindAgent({ session: deps.agents.getSession(call.sessionId)!, bound, threadLog: deps.threadLog, storyId });
  const { reply, raw } = await agent.converse(call.ctx, { turnId: turn.id, signal: opts.signal });

  const name = deps.memory.getObject(partner)?.name ?? '?';
  const line = renderDialogueLine(name, reply);
  for (let i = 0; i < line.length; i += 24) out.delta(line.slice(i, i + 24));

  opts.setStage?.('saving the exchange');
  deps.db.transaction(() => {
    commitCall(deps, call, raw, turn.id);
    const ops = applyThoughtOps(deps, storyId, partner, { remember: reply.remember, forget: reply.forget }, 'self', turn.id);
    if (ops.notes.length) queueForCharacter(deps, storyId, partner, `About your memory: ${ops.notes.join(' ')}`, turn.id);
    if (reply.state) applyChanges(deps, storyId, [{ change: { holder: partner, key: STATE_KEY, op: 'set', value: reply.state }, by: 'self', proposer: partner }], turn.id);
    const clockMin = deps.stories.advanceClock(storyId, 1);
    deps.stories.updateTurn(turn.id, {
      narration: line,
      status: 'complete',
      meta: {
        engine: 'minds',
        mode: 'dialogue',
        partner,
        player: decl,
        reply: { say: reply.say, gesture: reply.gesture, state: reply.state, act: reply.act },
        ...(reply.problems.length ? { problems: reply.problems } : {}),
        durationMs: Date.now() - t0,
        model: bound.profile.model,
        clockMin,
      },
    });
  });
  if (reply.act) logger.info('dialogue partner acts — the conversation ends at the next round', { storyId, partner, act: reply.act });
  deps.events.emit({ t: 'minds.updated', storyId, objectIds: [partner] });
  return deps.stories.getTurn(turn.id)!;
}
