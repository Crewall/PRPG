import type { StoryStore } from '../db/stores/storyStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import type { Story, Turn } from '../domain.ts';
import type { ObjectType } from '../memory/model.ts';
import { Storyteller } from '../agents/storyteller.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { DEFAULT_TURN_MINUTES } from '../util/gameClock.ts';
import { logger } from '../util/logger.ts';
import { breakScene } from '../orchestrator/scenes.ts';
import { buildCharacterCall, buildNarratorCall, commitCall, hereFromScene, queueForCharacter, queueForNarrator, NARRATOR_OWNER } from './builders.ts';
import type { Declaration, PreparedCall, ThreadDeps } from './builders.ts';
import { emptyBlock, entryToOp, parsePlayerInput, parseRoundBlock, readRoundBlock, splitNarratorReply } from './contracts.ts';
import type { CharacterReply, PlayerDeclaration, RoundBlock } from './contracts.ts';
import { chooseCallers } from './gate.ts';
import type { GateCandidate } from './gate.ts';
import { applyChanges, applyThoughtOps, createCharacter, updateSheet } from './service.ts';
import { STATE_KEY, renderRange } from './variables.ts';
import type { ChangeOutcome, Proposal } from './variables.ts';
import { isPlaceholder, isRealName, realValue, slugify } from './text.ts';
import { openDialogueTurns, renderTranscript } from './dialogue.ts';
import { queueCompactions } from './compaction.ts';

// One normal round of the Minds engine (docs/10 §5): characters declare (in
// parallel) → the narrator writes prose + a round block (streamed; the block
// is hidden) → the block is checked → everything is committed in ONE
// transaction → each character's brief waits in its thread. A failed round
// commits nothing, so the next attempt starts from the same state.

export interface RoundDeps extends ThreadDeps {
  stories: StoryStore;
  registry: LlmRegistry;
  threadLog: ThreadLog;
  jobs: JobStore;
  events: EventBus;
}

export interface RoundEmitter {
  status(text: string): void;
  delta(text: string): void;
}

export interface RoundOptions {
  signal: AbortSignal;
  /** Characters the user forces to act this round. */
  force?: string[];
  /** Which part of the round is running (for error messages). */
  setStage?: (stage: string) => void;
}

interface CharacterResult {
  objectId: string;
  call?: PreparedCall;
  reply?: CharacterReply & { problems: string[] };
  raw?: string;
  error?: string;
}

const PLAYER_KEYS = new Set(['#player', 'player', '#you', 'you', 'the player']);
const OPENING_NOTE =
  'Open the story: set the opening scene from the premise in a few short paragraphs, and bring in the first characters with cast.enter. Give each of them a brief.';

/** A delta forwarder that never lets the fenced round block reach the player. */
function fenceGate(out: RoundEmitter) {
  let acc = '';
  let sent = 0;
  return (chunk: string) => {
    acc += chunk;
    const display = acc.split('```')[0];
    if (display.length > sent) {
      out.delta(display.slice(sent));
      sent = display.length;
    }
  };
}

/** The player character's sheet, created from the story's player object when only that exists. */
function ensurePlayerSheet(deps: RoundDeps, story: Story): string | null {
  const existing = deps.sheets.player(story.id);
  if (existing) return existing.objectId;
  const pid = story.settings.playerObjectId;
  const obj = pid ? deps.memory.getObject(pid) : undefined;
  if (!obj || obj.storyId !== story.id) return null;
  deps.sheets.upsert(story.id, obj.id, { isPlayer: true, description: obj.summary });
  return obj.id;
}

const VAGUE_PRONOUN = /\b(he|she|him|her|his|hers|himself|herself)\b/i;

/**
 * The block's `player` field (docs/11 §2.1): creates the player character when the story has none, else fills
 * only its empty fields — what the user wrote is never overwritten. A name that belongs to a character present
 * is refused (the narrator must not turn an NPC into the player).
 */
function settlePlayer(
  deps: RoundDeps,
  storyId: string,
  playerId: string | null,
  p: { name?: string; pronouns?: string; appearance?: string },
  presentIds: string[],
): { playerId?: string; changed?: boolean; problem?: string } {
  const pronouns = realValue(p.pronouns).slice(0, 40);
  const appearance = realValue(p.appearance);
  if (playerId) {
    const sheet = deps.sheets.get(playerId);
    if (!sheet) return { playerId };
    const patch = { ...(!sheet.appearance.trim() && appearance ? { appearance } : {}), ...(!sheet.pronouns.trim() && pronouns ? { pronouns } : {}) };
    if (!Object.keys(patch).length) return { playerId };
    deps.sheets.upsert(storyId, playerId, patch);
    return { playerId, changed: true };
  }
  const name = p.name?.trim();
  if (!name) return { problem: 'player: no name given for the new player character' };
  if (!isRealName(name)) return { problem: `player: "${name}" is not a name` };
  const existing = deps.memory.findByName(storyId, name);
  if (existing) {
    if (presentIds.includes(existing.id) || existing.type !== 'character') return { problem: `player: '${name}' is already someone else` };
    const sheet = deps.sheets.get(existing.id);
    updateSheet(deps, storyId, existing.id, {
      isPlayer: true,
      ...(!sheet?.appearance.trim() && appearance ? { appearance } : {}),
      ...(!sheet?.pronouns.trim() && pronouns ? { pronouns } : {}),
    });
    return { playerId: existing.id, changed: true };
  }
  return { playerId: createCharacter(deps, storyId, { name, isPlayer: true, appearance, pronouns }).objectId, changed: true };
}

/** Resolve a block key ("#marta", "Marta Vell", "world", "#player") to a holder id. */
function resolveKey(deps: RoundDeps, storyId: string, key: string, playerId: string | null): string | undefined {
  const k = key.trim();
  if (!k) return undefined;
  if (k.toLowerCase() === 'world') return 'world';
  if (PLAYER_KEYS.has(k.toLowerCase())) return playerId ?? undefined;
  return deps.memory.findByHandle(storyId, k)?.id ?? deps.memory.findByName(storyId, k.replace(/^#/, ''))?.id ?? deps.memory.findByHandle(storyId, slugify(k))?.id;
}

const label = (deps: RoundDeps, oid: string) => {
  const obj = deps.memory.getObject(oid);
  return `#${obj?.handle ?? deps.memory.ensureHandle(oid)} ${obj?.name ?? '?'}`;
};

const OBJECT_TYPES: ObjectType[] = ['character', 'item', 'location', 'faction', 'event', 'lore'];

export async function runMindsRound(deps: RoundDeps, storyIn: Story, turn: Turn, playerInput: string, out: RoundEmitter, opts: RoundOptions): Promise<Turn> {
  const t0 = Date.now();
  const stage = (s: string) => opts.setStage?.(s);
  const { signal } = opts;
  const storyId = storyIn.id;

  // ---- 0. Scene, player character, the last round's block ----
  stage('setup');
  if (!storyIn.currentSceneId) deps.stories.openScene(storyId);
  let story = deps.stories.getStory(storyId)!;
  const mset = story.settings.minds;
  let playerId = ensurePlayerSheet(deps, story);
  const scene = deps.stories.getScene(story.currentSceneId!)!;
  const completed = deps.stories.recentTurns(storyId, 60).filter((t) => t.status === 'complete' && t.index < turn.index);
  // The last real round (dialogue exchanges carry no block).
  const previous = completed.filter((t) => t.meta.mode !== 'dialogue').at(-1);
  const lastBlock: RoundBlock = previous?.meta.block ? parseRoundBlock(previous.meta.block).block : emptyBlock();

  // Dialogue mode (docs/10 §7): a round right after dialogue exchanges wraps the conversation up.
  const dialogue = openDialogueTurns(deps, storyId, turn.index);
  const partnerId = dialogue.length ? (dialogue.at(-1)!.meta.partner as string) : undefined;
  const partnerAct = dialogue.length ? ((dialogue.at(-1)!.meta.reply as { act?: string } | undefined)?.act ?? undefined) : undefined;

  const decl: PlayerDeclaration = parsePlayerInput(playerInput);
  if (!completed.length && !decl.say && !decl.do && !decl.ooc) decl.ooc = OPENING_NOTE;

  // Present characters (not the player). Roster objects without a sheet get a bare one.
  const presentIds = scene.activeNpcIds.filter((oid) => oid !== playerId && deps.memory.getObject(oid));
  for (const oid of presentIds) if (!deps.sheets.get(oid)) deps.sheets.upsert(storyId, oid, {});

  // ---- 1. Who acts (docs/10 §5.1) ----
  const candidates: GateCandidate[] = presentIds.map((oid) => {
    const obj = deps.memory.getObject(oid)!;
    return { id: oid, name: obj.name, aliases: obj.aliases, handle: obj.handle ?? deps.memory.ensureHandle(oid)! };
  });
  const neverActed = new Set<string>();
  const actedLast = new Set<string>();
  for (const oid of presentIds) {
    const session = deps.agents.listSessions(storyId).find((s) => s.role === 'character' && s.npcObjectId === oid);
    const last = session ? deps.threads.lastReply(session.id) : undefined;
    if (!last) neverActed.add(oid);
    else if (previous && last.turnId === previous.id) actedLast.add(oid);
  }
  const spotlight = new Set(lastBlock.spotlight.map((k) => resolveKey(deps, storyId, k, playerId)).filter((x): x is string => !!x));
  const gate = dialogue.length
    ? { called: [] as string[], idle: presentIds, reasons: {} as Record<string, string> } // the wrap-up calls nobody
    : chooseCallers({
    present: candidates,
    playerText: `${decl.say}\n${decl.do}`,
    spotlight,
    neverActed,
    actedLastRound: actedLast,
    forced: new Set(opts.force ?? []),
    cap: mset.maxCharactersPerRound,
  });

  // ---- 2. Characters declare, in parallel ----
  const playerLabel = playerId ? label(deps, playerId) : 'The player character';
  const heardNow = mset.playerSpeechHeardImmediately && decl.say ? `${playerLabel}: "${decl.say}"` : undefined;
  let results: CharacterResult[] = [];
  if (gate.called.length) {
    stage('characters');
    out.status('the characters are deciding…');
    results = await Promise.all(
      gate.called.map(async (oid): Promise<CharacterResult> => {
        try {
          const sheet = deps.sheets.get(oid);
          const bound = deps.registry.getForRole('character', sheet?.tierId ? `tier:${sheet.tierId}` : story.settings.roles.character);
          const handle = deps.memory.getObject(oid)?.handle ?? '';
          const tags = [...lastBlock.tags, ...(lastBlock.evoke[`#${handle}`] ?? lastBlock.evoke[handle] ?? [])];
          const call = buildCharacterCall(deps, { storyId, objectId: oid, here: hereFromScene(deps, storyId, oid), situationTags: tags, now: heardNow });
          const agent = new MindAgent({ session: deps.agents.getSession(call.sessionId)!, bound, threadLog: deps.threadLog, storyId });
          const { reply, raw } = await agent.declare(call.ctx, { turnId: turn.id, signal });
          return { objectId: oid, call, reply, raw };
        } catch (err) {
          if (signal.aborted) throw err; // a user cancel must still cancel the turn
          logger.warn('character call failed', { storyId, objectId: oid, err: (err as Error).message });
          return { objectId: oid, error: (err as Error).message };
        }
      }),
    );
  }
  const byId = new Map(results.map((r) => [r.objectId, r]));
  const declarations: Declaration[] = presentIds.map((oid) => {
    const r = byId.get(oid);
    if (!r && oid === partnerId && partnerAct) return { objectId: oid, status: 'acted', intent: partnerAct };
    if (!r) return { objectId: oid, status: 'idle' };
    if (!r.reply) return { objectId: oid, status: 'unavailable' };
    return { objectId: oid, status: 'acted', say: r.reply.say, to: r.reply.to, intent: r.reply.intent, state: r.reply.state };
  });

  // ---- 3. The narrator writes (streamed; the block never reaches the player) ----
  stage('narrator');
  out.status('the narrator is writing…');
  const narratorBound = deps.registry.getForRole('narrator', story.settings.roles.narrator);
  let context: string | undefined;
  if (dialogue.length && partnerId) {
    const partnerName = deps.memory.getObject(partnerId)?.name ?? 'them';
    context =
      `A direct conversation between ${playerLabel} and ${label(deps, partnerId)} just ended:\n${renderTranscript(deps, storyId, dialogue)}\n\n` +
      `Wrap it up: bridge back to the scene in a few sentences (or none if nothing else happens), resolve what the player${partnerAct ? ` and ${partnerName}` : ''} now try, ` +
      `and give every other present character a brief of what they overheard or noticed. ${partnerName} was there, so their brief only needs what happens next.`;
  }
  // The player character must exist and be describable (docs/11 §2.1): ask the narrator for what is missing.
  const playerSheet = playerId ? deps.sheets.get(playerId) : undefined;
  const playerAsk = !playerSheet
    ? 'The player has no character yet. In the block, add "player" with their name (a real name, not a description), their pronouns and a one-line appearance: what the story has established about them, else invent what fits the premise.'
    : !playerSheet.appearance.trim() || !playerSheet.pronouns.trim()
      ? `The player character's sheet lacks ${[!playerSheet.appearance.trim() && 'an appearance', !playerSheet.pronouns.trim() && 'pronouns'].filter(Boolean).join(' and ')}: add ${!playerSheet.appearance.trim() && !playerSheet.pronouns.trim() ? 'them' : 'it'} in the block's "player" field, from what the story has established.`
      : undefined;
  if (playerAsk) context = context ? `${context}\n\n${playerAsk}` : playerAsk;
  const nCall = buildNarratorCall(deps, { storyId, player: decl, presentIds, declarations, situationTags: lastBlock.tags, context });
  const narrator = new Storyteller({ session: deps.agents.getSession(nCall.sessionId)!, bound: narratorBound, threadLog: deps.threadLog, storyId });
  const narratorText = await narrator.narrate(nCall.ctx, fenceGate(out), { turnId: turn.id, signal });
  const { prose, rawBlock } = splitNarratorReply(narratorText);
  if (!prose) throw new Error('the narrator wrote no story text (only a block)');

  // ---- 4. The round block: the narrator's, else the distributor's, else nothing ----
  let blockSource: 'narrator' | 'distributor' | 'fallback' = 'narrator';
  let blockProblems: string[] = [];
  let block: RoundBlock;
  const read = readRoundBlock(rawBlock);
  if (read) {
    block = read.block;
    blockProblems = read.problems;
  } else {
    stage('distributor');
    out.status('sorting out what everyone noticed…');
    try {
      block = await distribute(deps, story, turn, prose, presentIds, playerId, signal);
      blockSource = 'distributor';
    } catch (err) {
      if (signal.aborted) throw err;
      logger.warn('distributor failed — mechanical briefs only', { storyId, err: (err as Error).message });
      block = emptyBlock();
      blockSource = 'fallback';
      blockProblems = [`distributor: ${(err as Error).message}`];
    }
  }

  // ---- 5. Commit, all at once ----
  stage('saving the round');
  const changedIds = new Set<string>();
  const seedQueue: string[] = [];
  let outcomes: ChangeOutcome[] = [];
  deps.db.transaction(() => {
    // 5a. Character threads (replies byte-exact) and their memory operations.
    const memoryNotes = new Map<string, string[]>();
    for (const r of results) {
      if (!r.call || !r.reply || r.raw === undefined) continue;
      commitCall(deps, r.call, r.raw, turn.id);
      const ops = applyThoughtOps(deps, storyId, r.objectId, { remember: r.reply.remember, forget: r.reply.forget }, 'self', turn.id);
      if (ops.notes.length) memoryNotes.set(r.objectId, ops.notes);
      changedIds.add(r.objectId);
    }

    // 5b. The player character, objects, cast and scene first, so briefs and changes can name them.
    if (block.player) {
      const r = settlePlayer(deps, storyId, playerId, block.player, presentIds);
      if (r.problem) blockProblems.push(r.problem);
      if (r.playerId) {
        playerId = r.playerId;
        if (r.changed) changedIds.add(r.playerId);
      }
    }
    for (const o of block.objects) {
      if (isPlaceholder(o.name)) continue;
      o.line = realValue(o.line);
      const existing = deps.memory.findByName(storyId, o.name) ?? (o.name.trim().startsWith('#') ? deps.memory.findByHandle(storyId, o.name.trim()) : undefined);
      if (existing) {
        // The narrator keeps places' and things' public one-liners current (docs/11 §2.4).
        const line = o.line.trim();
        if (line && existing.type !== 'character' && existing.summary !== line) deps.memory.updateObject(existing.id, { summary: line });
        continue;
      }
      const type = OBJECT_TYPES.includes(o.type as ObjectType) && o.type !== 'character' ? (o.type as ObjectType) : 'item';
      const name = o.name.trim().startsWith('#') ? o.name.trim().replace(/^#/, '').replace(/[-_]+/g, ' ') : o.name.trim();
      deps.memory.createObject({ storyId, type, name, aliases: [], summary: o.line.trim(), salience: 0.5, status: 'active' });
    }
    const current = () => deps.stories.getScene(deps.stories.getStory(storyId)!.currentSceneId!)!;
    for (const key of block.cast.exit) {
      const oid = resolveKey(deps, storyId, key, playerId);
      if (oid && oid !== 'world' && oid !== playerId) deps.stories.removeActiveNpc(current().id, oid);
    }
    const entered: string[] = [];
    for (const e of block.cast.enter) {
      if (!isRealName(e.name)) {
        blockProblems.push(`cast.enter: "${e.name}" is not a name`);
        continue;
      }
      e.appearance = realValue(e.appearance);
      e.pronouns = realValue(e.pronouns).slice(0, 40);
      const existing = deps.memory.findByName(storyId, e.name) ?? deps.memory.findByHandle(storyId, slugify(e.name));
      let oid: string;
      if (existing && existing.id !== playerId) {
        oid = existing.id;
        const sheet = deps.sheets.get(oid);
        deps.sheets.upsert(storyId, oid, {
          ...(sheet?.appearance ? {} : { appearance: e.appearance }),
          ...(sheet?.pronouns || !e.pronouns.trim() ? {} : { pronouns: e.pronouns.trim() }),
        });
      } else if (!existing) {
        oid = createCharacter(deps, storyId, { name: e.name, appearance: e.appearance, pronouns: e.pronouns }).objectId;
      } else continue;
      if (!current().activeNpcIds.includes(oid)) {
        deps.stories.addActiveNpc(current().id, oid);
        entered.push(oid);
      }
      const sheet = deps.sheets.get(oid);
      if (sheet && !sheet.seeded && !sheet.description.trim()) seedQueue.push(oid);
    }
    if (block.scene.break) {
      breakScene(deps, storyId, { title: block.scene.title, carryNpcs: current().activeNpcIds });
    }
    if (block.scene.location) {
      let loc = resolveKey(deps, storyId, block.scene.location, playerId);
      if (!loc || loc === 'world') {
        const name = block.scene.location.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
        loc = name ? deps.memory.createObject({ storyId, type: 'location', name, aliases: [], summary: '', salience: 0.5, status: 'active' }).id : undefined;
      }
      if (loc) deps.stories.setSceneLocation(current().id, loc);
    }
    if (block.scene.items) {
      const handles = block.scene.items
        .map((k) => {
          const oid = resolveKey(deps, storyId, k, playerId);
          if (oid && oid !== 'world') return deps.memory.ensureHandle(oid);
          const name = k.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
          return name ? deps.memory.createObject({ storyId, type: 'item', name, aliases: [], summary: '', salience: 0.4, status: 'active' }).handle : undefined;
        })
        .filter((x): x is string => !!x);
      deps.stories.setSceneItems(current().id, handles);
    }

    // 5c. Variables and states: characters' proposals first, then the narrator's (it wins on the same key).
    const proposals: Proposal[] = [];
    for (const r of results) {
      if (!r.reply) continue;
      for (const v of r.reply.vars) {
        const op = entryToOp(v, r.objectId);
        if (op) proposals.push({ change: op, by: 'self', proposer: r.objectId });
      }
      if (r.reply.state) proposals.push({ change: { holder: r.objectId, key: STATE_KEY, op: 'set', value: r.reply.state }, by: 'self', proposer: r.objectId });
    }
    for (const v of block.vars) {
      const holder = v.who ? resolveKey(deps, storyId, v.who, playerId) : undefined;
      const op = holder ? entryToOp(v, holder) : undefined;
      if (op) proposals.push({ change: op, by: 'narrator' });
      else blockProblems.push(`vars: no holder '${v.who ?? '?'}' for '${v.key}'`);
    }
    for (const [key, text] of Object.entries(block.state)) {
      const holder = resolveKey(deps, storyId, key, playerId);
      if (holder && holder !== 'world') proposals.push({ change: { holder, key: STATE_KEY, op: 'set', value: text }, by: 'narrator' });
    }
    outcomes = applyChanges(deps, storyId, proposals, turn.id);
    for (const o of outcomes) if (o.proposal.change.holder !== 'world') changedIds.add(o.proposal.change.holder);

    // 5d. The narrator's own notes.
    applyThoughtOps(deps, storyId, NARRATOR_OWNER, block.notes, 'self', turn.id);

    // 5e. Briefs + the exact words heard, waiting in each character's thread.
    const briefs = new Map<string, string>();
    for (const [key, text] of Object.entries(block.briefs)) {
      const oid = resolveKey(deps, storyId, key, playerId);
      if (oid && oid !== 'world' && oid !== playerId && text.trim()) briefs.set(oid, text.trim());
    }
    // Soft check (docs/11 §2.4): a brief that says he/she without naming anyone by #handle, while its reader
    // has two or more people around, is delivered — and the narrator is reminded next round.
    if (presentIds.length >= 2) {
      const vague = [...briefs].filter(([, text]) => VAGUE_PRONOUN.test(text) && !/#[\p{L}\p{N}]/u.test(text)).map(([oid]) => label(deps, oid));
      if (vague.length) {
        blockProblems.push(`briefs: he/she without a #handle (${vague.join(', ')})`);
        queueForNarrator(deps, storyId, `Note: your briefs for ${vague.join(', ')} said he/she without naming anyone by #handle. Name people by #handle in briefs (the player too), so each character knows who is meant.`, turn.id);
      }
    }
    const speeches: { from: string; line: string }[] = [];
    if (decl.say) speeches.push({ from: 'player', line: `${playerLabel}: "${decl.say}"` });
    for (const d of declarations) {
      if (d.status === 'acted' && d.say?.trim()) speeches.push({ from: d.objectId, line: `${label(deps, d.objectId)}${d.to ? ` (to ${d.to})` : ''}: "${d.say.trim()}"` });
    }
    const heardPlayerAlready = new Set(heardNow ? results.filter((r) => r.reply).map((r) => r.objectId) : []);
    for (const oid of presentIds) {
      const heard = speeches.filter((s) => s.from !== oid && !(s.from === 'player' && heardPlayerAlready.has(oid))).map((s) => `- ${s.line}`);
      const parts = [briefs.get(oid) ?? 'Nothing notable changes for you.'];
      if (heard.length) parts.push(`Heard:\n${heard.join('\n')}`);
      const notes = memoryNotes.get(oid);
      if (notes?.length) parts.push(`About your memory: ${notes.join(' ')}`);
      queueForCharacter(deps, storyId, oid, parts.join('\n'), turn.id);
    }
    for (const oid of entered) {
      const loc = current().locationObjectId ? deps.memory.getObject(current().locationObjectId!)?.name : undefined;
      queueForCharacter(deps, storyId, oid, briefs.get(oid) ?? `You have just arrived${loc ? ` at ${loc}` : ''}.`, turn.id);
    }

    // 5f. The narrator's thread, the clock, the turn.
    commitCall(deps, nCall, narratorText, turn.id);
    const clockMin = deps.stories.advanceClock(storyId, block.time && block.time > 0 ? block.time : DEFAULT_TURN_MINUTES);
    for (const oid of seedQueue) deps.jobs.enqueue('minds_seed', { storyId, turnId: turn.id, payload: { objectId: oid } });
    // Threads that grew past their threshold get folded after the round (docs/10 §8.4).
    queueCompactions(deps, storyId, [nCall.sessionId, ...results.filter((r) => r.call && r.reply).map((r) => r.call!.sessionId)], turn.id);
    const count = (r: string) => outcomes.filter((o) => o.result === r).length;
    deps.stories.updateTurn(turn.id, {
      narration: prose,
      status: 'complete',
      meta: {
        engine: 'minds',
        mode: dialogue.length ? 'wrapup' : 'round',
        ...(partnerId ? { partner: partnerId } : {}),
        durationMs: Date.now() - t0,
        model: narratorBound.profile.model,
        clockMin,
        presentNpcIds: presentIds,
        player: decl,
        gate: { called: gate.called, idle: gate.idle, reasons: gate.reasons },
        declarations: declarations.map((d) => ({ ...d, error: byId.get(d.objectId)?.error, problems: byId.get(d.objectId)?.reply?.problems })),
        block,
        blockSource,
        ...(blockProblems.length ? { blockProblems } : {}),
        changes: { applied: count('applied'), clamped: count('clamped'), rejected: count('rejected'), overridden: count('overridden') },
        entered,
      },
    });
  });

  story = deps.stories.getStory(storyId)!;
  deps.events.emit({ t: 'minds.updated', storyId, objectIds: [...changedIds] });
  deps.events.emit({ t: 'scene.changed', storyId, sceneId: story.currentSceneId ?? '' });
  return deps.stories.getTurn(turn.id)!;
}

/** The distributor (Light tier): a round block rebuilt from the prose when the narrator's is missing or broken. */
async function distribute(deps: RoundDeps, story: Story, turn: Turn, prose: string, presentIds: string[], playerId: string | null, signal: AbortSignal): Promise<RoundBlock> {
  const bound = deps.registry.getForRole('distributor', story.settings.roles.distributor);
  const session = deps.agents.ensureSession(story.id, 'distributor', bound.name);
  const defs = deps.variables.listDefs(story.id).filter((d) => d.changedBy.includes('narrator'));
  const user = [
    `The prose of this round:\n${prose}`,
    `Present characters:\n${presentIds.map((oid) => `- ${label(deps, oid)}`).join('\n') || '(none)'}`,
    `The player character: ${playerId ? label(deps, playerId) : '(not on the roster)'}`,
    `Variables the narrator may change:\n${defs.map((d) => `- ${d.key} (${renderRange(d)})`).join('\n') || '(none)'}`,
    'Reply with the round block as JSON.',
  ].join('\n\n');
  const agent = new MindAgent({ session, bound, threadLog: deps.threadLog, storyId: story.id });
  return agent.distribute({ system: renderPrompt('minds-distributor', { briefMaxWords: String(story.settings.minds.briefMaxWords) }), messages: [{ role: 'user', content: user }] }, { turnId: turn.id, signal });
}
