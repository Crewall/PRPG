import type { StoryStore } from '../db/stores/storyStore.ts';
import type { ThreadLog } from '../db/stores/threadLog.ts';
import type { JobStore } from '../db/stores/jobStore.ts';
import type { LlmRegistry } from '../llm/registry.ts';
import type { EventBus } from '../util/events.ts';
import type { Story, Turn } from '../domain.ts';
import { Storyteller } from '../agents/storyteller.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { DEFAULT_TURN_MINUTES } from '../util/gameClock.ts';
import { logger } from '../util/logger.ts';
import { breakScene } from '../orchestrator/scenes.ts';
import { buildCharacterCall, buildNarratorCall, commitCall, hereFromScene, queueForCharacter, queueForNarrator, NARRATOR_OWNER } from './builders.ts';
import type { Declaration, PreparedCall, ThreadDeps } from './builders.ts';
import { emptyBlock, entryToOp, mixedBeats, parsePlayerInput, parseRoundBlock, readCharacterReply, readRoundBlock, spokenLines, splitNarratorReply } from './contracts.ts';
import { focusFor, focusLine, holdToLimits, limitsFor } from './focus.ts';
import type { CharacterReply, PlayerDeclaration, RoundBlock } from './contracts.ts';
import { chooseCallers } from './gate.ts';
import type { GateCandidate } from './gate.ts';
import { applyChanges, applyThoughtOps, createCharacter, fadeThoughts, updateSheet } from './service.ts';
import { STATE_KEY, relationHolder, relationParts, renderRange } from './variables.ts';
import type { ChangeOutcome, Proposal } from './variables.ts';
import { clampWords, isPlaceholder, isRealName, realValue, slugify } from './text.ts';
import { setTie } from './ties.ts';
import { applyObjects, matchObject } from './places.ts';
import { labelFor, learnFromSpeech, learnName, maskUnknownNames, namesOn } from './names.ts';
import { openDialogueTurns, renderTranscript } from './dialogue.ts';
import { NO_DIRECTION, resolveDirection } from './director.ts';
import type { DirectionResult } from './director.ts';
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
  /** Randomness for the round's character order (tests pass a fixed one). */
  rng?: () => number;
}

/** A copy of `xs` in random order (Fisher–Yates). An rng that always returns ~1 keeps the order. */
export function shuffled<T>(xs: T[], rng: () => number = Math.random): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface RoundEmitter {
  status(text: string): void;
  delta(text: string): void;
}

export interface RoundOptions {
  signal: AbortSignal;
  /** Characters the user forces to act this round. */
  force?: string[];
  /** Characters the user gives the floor this round (docs/10 §5.1e): they act, with the sole focus. */
  floor?: string[];
  /**
   * Replay a round with the narrator's prose edited by the user (docs/10 §10a): no director, character or narrator
   * calls — their stored outputs are used — and the round block is revised to match the edited prose.
   */
  replay?: ReplayInput;
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

/** A brief telling its reader its own thoughts ("you're calculating", "you decide"). */
const TELLS_THOUGHTS =
  /\byou(?:'re|’re| are)\s+(?:thinking|calculating|wondering|deciding|planning|considering|weighing|sure|convinced|certain)\b|\byou\s+(?:think|decide|wonder|plan|realize|realise|conclude|suspect|believe|intend|resolve|figure)\b/i;

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
  p: { name?: string; pronouns?: string; appearance?: string; knownAs?: string },
  presentIds: string[],
): { playerId?: string; changed?: boolean; problem?: string } {
  const pronouns = realValue(p.pronouns).slice(0, 40);
  const appearance = realValue(p.appearance);
  const knownAs = realValue(p.knownAs).slice(0, 60);
  if (playerId) {
    const sheet = deps.sheets.get(playerId);
    if (!sheet) return { playerId };
    const patch = {
      ...(!sheet.appearance.trim() && appearance ? { appearance } : {}),
      ...(!sheet.pronouns.trim() && pronouns ? { pronouns } : {}),
      ...(!sheet.knownAs.trim() && knownAs ? { knownAs } : {}),
    };
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
  return { playerId: createCharacter(deps, storyId, { name, isPlayer: true, appearance, pronouns, knownAs }).objectId, changed: true };
}

/** The gate when the player's words have a direction: those spoken to, those who'd react, the spotlight, forced. */
function directedGate(presentIds: string[], d: DirectionResult, forced: Set<string>, spotlight: Set<string>, cap: number) {
  const reasons: Record<string, string> = {};
  const order: string[] = [];
  const add = (oid: string, why: string) => {
    if (!presentIds.includes(oid) || reasons[oid]) return;
    reasons[oid] = why;
    order.push(oid);
  };
  for (const oid of forced) add(oid, 'forced');
  for (const oid of d.all ? presentIds : d.to) add(oid, 'spoken to');
  for (const oid of d.react) add(oid, 'would react');
  for (const oid of spotlight) add(oid, 'spotlight');
  const called = order.slice(0, Math.max(1, cap));
  for (const oid of order.slice(called.length)) delete reasons[oid];
  return { called, idle: presentIds.filter((x) => !called.includes(x)), reasons };
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

  // Present characters (not the player), in a new random order every round (settled after a play test: the same
  // order every round made the narrator go round the same circle). The order breaks ties for who is called and is
  // the order the narrator reads them in. A replayed round keeps its first order. Roster objects without a sheet get
  // a bare one.
  const inScene = scene.activeNpcIds.filter((oid) => oid !== playerId && deps.memory.getObject(oid));
  const presentIds = opts.replay?.presentOrder
    ? [...opts.replay.presentOrder.filter((x) => inScene.includes(x)), ...inScene.filter((x) => !opts.replay!.presentOrder!.includes(x))]
    : shuffled(inScene, deps.rng);
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
  // Who the player's words are meant for (docs/10 §5.1b): when they are for particular people, those answer —
  // not everyone who happens to be new or spoke last round.
  stage('direction');
  const direction: DirectionResult = dialogue.length
    ? NO_DIRECTION
    : opts.replay
      ? opts.replay.direction
      : await resolveDirection(deps, story, turn, decl, { presentIds, playerId, lastRound: previous, signal });
  const directed = direction.all || direction.to.length > 0;
  const floor = new Set(opts.floor ?? []);
  const forcedSet = new Set([...(opts.force ?? []), ...floor]);
  const gate = dialogue.length
    ? { called: [] as string[], idle: presentIds, reasons: {} as Record<string, string> } // the wrap-up calls nobody
    : directed
      ? directedGate(presentIds, direction, forcedSet, spotlight, mset.maxCharactersPerRound)
      : chooseCallers({
          present: candidates,
          playerText: `${decl.say}\n${decl.do}`,
          spotlight,
          neverActed,
          actedLastRound: actedLast,
          forced: forcedSet,
          cap: mset.maxCharactersPerRound,
        });
  // How much each called character says this round (docs/10 §5.1e).
  const focus = new Map(gate.called.map((oid) => [oid, focusFor(oid, { called: gate.called, reasons: gate.reasons, direction, floor })]));
  const handleOf = (oid: string) => `#${deps.memory.getObject(oid)?.handle ?? deps.memory.ensureHandle(oid)}`;
  const playerTo = direction.all ? 'everyone' : direction.to.map(handleOf).join(', ');

  // ---- 2. Characters declare, in parallel ----
  const playerLabel = playerId ? label(deps, playerId) : 'The player character';
  // The player's words, as each character hears them right now (their name only if that character knows it).
  // Separate lines stay separate, in order (docs/10 §6): "A room, please." … "And a meal."
  const playerSpoken = spokenLines(decl.beats, decl.say);
  const heardNowFor = (viewer: string) =>
    mset.playerSpeechHeardImmediately && decl.say ? `${playerId ? labelFor(deps, storyId, viewer, playerId) : 'The player character'}: ${playerSpoken}${playerTo ? ` (to ${playerTo})` : ''}` : undefined;
  const heardNow = heardNowFor(NARRATOR_OWNER);
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
          const f = focus.get(oid) ?? 'background';
          const limits = limitsFor(f, mset.characterVerbosity);
          const call = buildCharacterCall(deps, { storyId, objectId: oid, here: hereFromScene(deps, storyId, oid), situationTags: tags, now: heardNowFor(oid), focusLine: focusLine(f, limits) });
          if (opts.replay) {
            // The reply this character gave the first time, byte-exact (docs/10 §10a).
            const raw = opts.replay.characterReplies.get(oid);
            if (raw === undefined) return { objectId: oid, error: 'no reply to replay' };
            return { objectId: oid, call, reply: holdToLimits(readCharacterReply(raw), limits), raw };
          }
          const agent = new MindAgent({ session: deps.agents.getSession(call.sessionId)!, bound, threadLog: deps.threadLog, storyId });
          const { reply, raw } = await agent.declare(call.ctx, { turnId: turn.id, signal });
          return { objectId: oid, call, reply: holdToLimits(reply, limits), raw };
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
    return {
      objectId: oid,
      status: 'acted',
      say: r.reply.say,
      to: r.reply.to,
      intent: r.reply.intent,
      state: r.reply.state,
      ...(mixedBeats(r.reply.beats) ? { beats: r.reply.beats } : {}),
      ...(focus.get(oid) ? { focus: focus.get(oid) } : {}),
    };
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
  const nCall = buildNarratorCall(deps, { storyId, player: { ...decl, ...(playerTo ? { to: playerTo } : {}) }, presentIds, declarations, situationTags: lastBlock.tags, context });
  const narrator = new Storyteller({ session: deps.agents.getSession(nCall.sessionId)!, bound: narratorBound, threadLog: deps.threadLog, storyId });
  const narratorText = opts.replay
    ? await replayNarration(deps, story, turn, nCall.roundMessage, opts.replay, signal)
    : await narrator.narrate(nCall.ctx, fenceGate(out), { turnId: turn.id, signal });
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
      const ops = applyThoughtOps(deps, storyId, r.objectId, { remember: r.reply.remember, revise: r.reply.revise, forget: r.reply.forget }, 'self', turn.id);
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
    // Places and things (docs/10 §5.1d): existing ones are matched, not named afresh; gone ones are marked gone.
    const { gone: goneIds } = applyObjects(deps, storyId, block.objects);
    const current = () => deps.stories.getScene(deps.stories.getStory(storyId)!.currentSceneId!)!;
    for (const key of block.cast.exit) {
      const oid = resolveKey(deps, storyId, key, playerId);
      if (oid && oid !== 'world' && oid !== playerId) deps.stories.removeActiveNpc(current().id, oid);
    }
    const entered: string[] = [];
    const arrivals: [string, (typeof block.cast.enter)[number]][] = [];
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
        const knownAs = realValue(e.knownAs).slice(0, 60);
        deps.sheets.upsert(storyId, oid, {
          ...(sheet?.appearance ? {} : { appearance: e.appearance }),
          ...(sheet?.pronouns || !e.pronouns.trim() ? {} : { pronouns: e.pronouns.trim() }),
          ...(sheet?.knownAs || !knownAs ? {} : { knownAs }),
        });
      } else if (!existing) {
        oid = createCharacter(deps, storyId, { name: e.name, appearance: e.appearance, pronouns: e.pronouns, knownAs: realValue(e.knownAs).slice(0, 60) }).objectId;
      } else continue;
      // The narrator's hand-over (docs/11 §2.3): who they are, as fact — their identity until the seeder lands.
      const who = realValue(e.who);
      if (who && !deps.sheets.get(oid)?.concept.trim()) deps.sheets.upsert(storyId, oid, { concept: clampWords(who, 80).text });
      arrivals.push([oid, e]);
      if (!current().activeNpcIds.includes(oid)) {
        deps.stories.addActiveNpc(current().id, oid);
        entered.push(oid);
      }
      const sheet = deps.sheets.get(oid);
      if (sheet && !sheet.seeded && !sheet.description.trim()) seedQueue.push(oid);
    }
    // Once everyone has entered (two newcomers may be family): their ties, whom they already know by name, and
    // who already knows theirs (docs/11 §2.5, §2.6).
    for (const [oid, e] of arrivals) {
      for (const [k, tie] of Object.entries(e.ties)) {
        const other = resolveKey(deps, storyId, k, playerId);
        if (other && other !== 'world') setTie(deps, storyId, oid, other, tie, turn.id);
      }
      for (const k of e.knows) {
        const other = resolveKey(deps, storyId, k, playerId);
        if (other && other !== 'world') learnName(deps, storyId, oid, other, turn.id);
      }
      for (const k of e.knownBy) {
        const other = resolveKey(deps, storyId, k, playerId);
        if (other && other !== 'world') learnName(deps, storyId, other, oid, turn.id);
      }
    }
    if (block.scene.break) {
      breakScene(deps, storyId, { title: block.scene.title, carryNpcs: current().activeNpcIds });
    }
    if (block.scene.location) {
      let loc: string | undefined = matchObject(deps, storyId, block.scene.location).obj?.id;
      if (!loc) {
        const name = block.scene.location.replace(/^#/, '').replace(/[-_]+/g, ' ').trim();
        loc = name && !isPlaceholder(name) ? deps.memory.createObject({ storyId, type: 'location', name, aliases: [], summary: '', salience: 0.5, status: 'active' }).id : undefined;
      }
      if (loc) deps.stories.setSceneLocation(current().id, loc);
    }
    if (block.scene.items) {
      const handles = block.scene.items
        .map((k) => {
          if (isPlaceholder(k)) return undefined;
          const m = matchObject(deps, storyId, k);
          if (m.obj) return m.obj.type === 'character' || m.obj.status === 'destroyed' || m.gone ? undefined : deps.memory.ensureHandle(m.obj.id);
          const name = m.name.trim();
          return name && !m.gone ? deps.memory.createObject({ storyId, type: 'item', name, aliases: m.alias ? [m.alias] : [], summary: '', salience: 0.4, status: 'active' }).handle : undefined;
        })
        .filter((x): x is string => !!x);
      deps.stories.setSceneItems(current().id, [...new Set(handles)]);
    } else if (goneIds.length) {
      // A thing that is gone is no longer in view.
      const goneHandles = new Set(goneIds.map((oid) => deps.memory.getObject(oid)?.handle));
      const items = current().itemHandles ?? [];
      if (items.some((x) => goneHandles.has(x))) deps.stories.setSceneItems(current().id, items.filter((x) => !goneHandles.has(x)));
    }

    // Everyone in the scene now has met everyone else: relation variables exist for them (docs/11 §4.9).
    deps.met?.meetAll(storyId, [...current().activeNpcIds, ...(playerId ? [playerId] : [])].filter((oid) => deps.sheets.get(oid)), turn.id);

    // 5c. Variables and states: characters' proposals first, then the narrator's (it wins on the same key).
    const defsByKey = new Map(deps.variables.listDefs(storyId).map((d) => [d.key, d]));
    /** The holder an entry changes: the character, or for a relation variable the pair toward `to`. */
    const holderOf = (holder: string, v: (typeof block.vars)[number]): string | undefined => {
      const def = defsByKey.get(v.key);
      if (def?.scope !== 'relation') return holder;
      const to = v.to ? resolveKey(deps, storyId, v.to, playerId) : undefined;
      return holder !== 'world' && to && to !== 'world' && to !== holder ? relationHolder(def, holder, to) : undefined;
    };
    const proposals: Proposal[] = [];
    for (const r of results) {
      if (!r.reply) continue;
      for (const v of r.reply.vars) {
        const h = holderOf(r.objectId, v);
        const op = h ? entryToOp(v, h) : undefined;
        if (op) proposals.push({ change: op, by: 'self', proposer: r.objectId });
      }
      if (r.reply.state) proposals.push({ change: { holder: r.objectId, key: STATE_KEY, op: 'set', value: r.reply.state }, by: 'self', proposer: r.objectId });
    }
    for (const v of block.vars) {
      const who = v.who ? resolveKey(deps, storyId, v.who, playerId) : undefined;
      const holder = who ? holderOf(who, v) : undefined;
      const op = holder ? entryToOp(v, holder) : undefined;
      if (op) proposals.push({ change: op, by: 'narrator' });
      else if (who && defsByKey.get(v.key)?.scope === 'relation') blockProblems.push(`vars: '${v.key}' needs "to": whom ${v.who} feels it toward`);
      else blockProblems.push(`vars: no holder '${v.who ?? '?'}' for '${v.key}'`);
    }
    for (const [key, text] of Object.entries(block.state)) {
      const holder = resolveKey(deps, storyId, key, playerId);
      if (holder && holder !== 'world') proposals.push({ change: { holder, key: STATE_KEY, op: 'set', value: text }, by: 'narrator' });
    }
    outcomes = applyChanges(deps, storyId, proposals, turn.id);
    for (const o of outcomes) {
      const hid = o.proposal.change.holder;
      const pair = relationParts(hid);
      if (pair) [pair.from, pair.to].forEach((x) => changedIds.add(x));
      else if (hid !== 'world') changedIds.add(hid);
    }

    // 5c''. Ties set or changed by the narrator (docs/11 §2.6); "" removes one.
    for (const [holderKey, others] of Object.entries(block.ties)) {
      const holder = resolveKey(deps, storyId, holderKey, playerId);
      if (!holder || holder === 'world') continue;
      for (const [k, label] of Object.entries(others)) {
        const other = resolveKey(deps, storyId, k, playerId);
        if (other && other !== 'world' && setTie(deps, storyId, holder, other, label, turn.id)) changedIds.add(holder);
      }
    }

    // 5c'. Names learned other than by hearing them (docs/11 §2.5).
    for (const [learnerKey, subjects] of Object.entries(block.names)) {
      const learner = resolveKey(deps, storyId, learnerKey, playerId);
      if (!learner || learner === 'world') continue;
      for (const k of subjects) {
        const subject = resolveKey(deps, storyId, k, playerId);
        if (subject && subject !== 'world') learnName(deps, storyId, learner, subject, turn.id);
      }
    }

    // 5d. The narrator's own notes.
    applyThoughtOps(deps, storyId, NARRATOR_OWNER, block.notes, 'self', turn.id);

    // 5e. Briefs + the exact words heard, waiting in each character's thread.
    const briefs = new Map<string, string>();
    for (const [key, text] of Object.entries(block.briefs)) {
      const oid = resolveKey(deps, storyId, key, playerId);
      if (oid && oid !== 'world' && oid !== playerId && text.trim()) briefs.set(oid, text.trim());
    }
    // Soft check (docs/10 §5.1c): briefs carry perception only. One that tells its reader what it thinks or plans
    // is delivered, and the narrator is reminded next round.
    const thinking = [...briefs].filter(([, text]) => TELLS_THOUGHTS.test(text)).map(([oid]) => label(deps, oid));
    if (thinking.length) {
      blockProblems.push(`briefs: told thoughts (${thinking.join(', ')})`);
      queueForNarrator(deps, storyId, `Note: your briefs for ${thinking.join(', ')} told them what they think or plan. Briefs carry perception only: what they saw, heard and felt. Their own minds decide what they make of it.`, turn.id);
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
    // What was said aloud, each speaker's lines kept apart and in order (docs/10 §6).
    const speeches: { from: string; to?: string; say: string; line: string }[] = [];
    if (decl.say) speeches.push({ from: 'player', say: decl.say, line: playerSpoken, ...(playerTo ? { to: playerTo } : {}) });
    for (const d of declarations) {
      if (d.status === 'acted' && d.say?.trim()) speeches.push({ from: d.objectId, to: d.to, say: d.say.trim(), line: spokenLines(d.beats, d.say) });
    }
    // Names (docs/11 §2.5): a name said aloud is learned by everyone who heard it; the player also learns the
    // names the prose shows. Learned before the briefs are written, so a brief may use a name just heard.
    if (namesOn(deps, storyId)) {
      for (const sp of speeches) {
        const speaker = sp.from === 'player' ? playerId : sp.from;
        learnFromSpeech(deps, storyId, [...presentIds, playerId].filter((x) => x && x !== speaker), sp.say, turn.id);
      }
      if (playerId) learnFromSpeech(deps, storyId, [playerId], prose, turn.id);
    }
    const speakerLabel = (hearer: string, from: string) => (from === 'player' ? (playerId ? labelFor(deps, storyId, hearer, playerId) : 'The player character') : labelFor(deps, storyId, hearer, from));
    const heardPlayerAlready = new Set(heardNow ? results.filter((r) => r.reply).map((r) => r.objectId) : []);
    for (const oid of presentIds) {
      const heard = speeches
        .filter((s) => s.from !== oid && !(s.from === 'player' && heardPlayerAlready.has(oid)))
        .map((s) => `- ${speakerLabel(oid, s.from)}${s.to ? ` (to ${s.to})` : ''}: ${s.line}`);
      const brief = briefs.get(oid);
      const parts = [brief ? maskUnknownNames(deps, storyId, oid, brief) : 'Nothing notable changes for you.'];
      if (heard.length) parts.push(`Heard:\n${heard.join('\n')}`);
      const notes = memoryNotes.get(oid);
      if (notes?.length) parts.push(`About your memory: ${notes.join(' ')}`);
      queueForCharacter(deps, storyId, oid, parts.join('\n'), turn.id);
    }
    for (const oid of entered) {
      const loc = current().locationObjectId ? deps.memory.getObject(current().locationObjectId!)?.name : undefined;
      const brief = briefs.get(oid);
      queueForCharacter(deps, storyId, oid, brief ? maskUnknownNames(deps, storyId, oid, brief) : `You have just arrived${loc ? ` at ${loc}` : ''}.`, turn.id);
    }

    // 5f. The narrator's thread, the clock, the turn.
    commitCall(deps, nCall, narratorText, turn.id);
    const clockMin = deps.stories.advanceClock(storyId, block.time && block.time > 0 ? block.time : DEFAULT_TURN_MINUTES);
    // Thoughts that went unrenewed for long enough fade (docs/11 §5.7).
    fadeThoughts(deps, storyId, turn.id);
    // A mind not written yet (its seeding failed: an overloaded provider, an empty reply) is tried again each
    // round it is present, unless a seed for it is still waiting.
    for (const oid of presentIds) {
      const sheet = deps.sheets.get(oid);
      if (sheet && !sheet.seeded && !sheet.description.trim() && !seedQueue.includes(oid)) seedQueue.push(oid);
    }
    for (const oid of seedQueue) {
      const waiting = deps.db
        .prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'minds_seed' AND status IN ('pending','running') AND json_extract(payload_json, '$.objectId') = ?`)
        .get<{ n: number }>(oid)!.n;
      if (!waiting) deps.jobs.enqueue('minds_seed', { storyId, turnId: turn.id, payload: { objectId: oid } });
    }
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
        ...(direction.source !== 'none' ? { direction } : {}),
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
export interface ReplayInput {
  direction: DirectionResult;
  /** The character order of the first run (it decided who was called). */
  presentOrder?: string[];
  /** Each called character's raw reply from the first time. */
  characterReplies: Map<string, string>;
  /** The narrator's prose as the user edited it. */
  editedProse: string;
  /** The round block the narrator wrote the first time. */
  originalBlock: unknown;
}

/**
 * The narrator's reply for a replayed round (docs/10 §10a): the edited prose, and the original round block
 * revised by a light model to match it (briefs, states, variables, cast, places…). If the revision fails, the
 * original block stands.
 */
async function replayNarration(deps: RoundDeps, story: Story, turn: Turn, roundMessage: string, replay: ReplayInput, signal: AbortSignal): Promise<string> {
  const prose = replay.editedProse.trim();
  let block: unknown = replay.originalBlock ?? {};
  try {
    const bound = deps.registry.getForRole('distributor', story.settings.roles.distributor);
    const session = deps.agents.ensureSession(story.id, 'distributor', bound.name);
    const user = [
      `The narrator's round message (who is present, with #handles):\n${roundMessage}`,
      `The original round block:\n${JSON.stringify(replay.originalBlock ?? {}, null, 1)}`,
      `The prose as the player edited it:\n${prose}`,
      'Reply with the revised round block as JSON.',
    ].join('\n\n');
    const agent = new MindAgent({ session, bound, threadLog: deps.threadLog, storyId: story.id });
    block = await agent.distribute({ system: renderPrompt('minds-reviser', { briefMaxWords: String(story.settings.minds.briefMaxWords) }), messages: [{ role: 'user', content: user }] }, { turnId: turn.id, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    logger.warn('block revision failed — the original block stands', { storyId: story.id, err: (err as Error).message });
  }
  return `${prose}\n\n\`\`\`round\n${JSON.stringify(block)}\n\`\`\``;
}

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
