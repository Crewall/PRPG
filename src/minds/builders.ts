import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import type { Db } from '../db/db.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadStore, ThreadMessage } from '../db/stores/threadStore.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { formatGameClock } from '../util/gameClock.ts';
import { estimateTokens } from '../util/tokens.ts';
import { VERBOSITY_STYLE } from '../orchestrator/contextBuilder.ts';
import { STATE_KEY, appliesTo, canSee, renderRange, renderValue } from './variables.ts';
import type { HolderInfo, VariableDef, Viewer } from './variables.ts';
import { renderThought, selectRecall, tagsMentioned } from './thoughts.ts';
import type { Thought } from './thoughts.ts';
import { holdersFor, valueOf } from './service.ts';
import type { MindsDeps } from './service.ts';

// Thread builders for the Minds engine (docs/10 §8). Every thread is
// [frozen system] [recap] [append-only log] [newest round message]: the system
// prompt changes only when its inputs are edited, old messages are never
// re-rendered, and each request is a byte-exact prefix of the next one.
//
// Building is read-only (previews use the same functions as the real round);
// `commit*` appends the round message + reply and marks what was delivered.

export interface ThreadDeps extends MindsDeps {
  db: Db;
  agents: AgentStore;
  threads: ThreadStore;
  /** Editable reply-length strings per verbosity step (Settings → style). */
  verbosityOverride?: () => Record<string, string>;
}

/** What a character can see around it right now (the "Here:" line). */
export interface HereInfo {
  location?: { handle: string; name: string };
  /** Others present, the player character included. */
  present: { handle: string; name: string; appearance: string }[];
  items: { handle: string; name: string }[];
}

export interface CharacterCallInput {
  storyId: string;
  objectId: string;
  here: HereInfo;
  /** The narrator's situation tags + its evoke tags for this character (last round block). */
  situationTags?: string[];
  /** What happens right now, before the character declares (the player's words this round). */
  now?: string;
}

export interface PreparedCall {
  sessionId: string;
  ctx: BuiltContext;
  roundMessage: string;
  /** Pending thread items folded into this round message. */
  pendingIds: string[];
  /** Thoughts shown in this round message (marked recalled on commit). */
  recalledIds: string[];
}

/** A present character's declaration this round, as the narrator receives it. */
export interface Declaration {
  objectId: string;
  status: 'acted' | 'idle' | 'unavailable';
  say?: string;
  to?: string;
  intent?: string;
  state?: string;
}

export interface NarratorCallInput {
  storyId: string;
  player: { say?: string; do?: string; ooc?: string };
  /** Present characters (not the player), in scene order. */
  presentIds: string[];
  declarations: Declaration[];
  situationTags?: string[];
}

export const NARRATOR_OWNER = 'narrator';

// ---- Shared helpers ----

/** Join adjacent same-role messages with one fixed rule, so assembly is deterministic. */
export function mergeAdjacent(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else out.push({ ...m });
  }
  return out;
}

function assemble(system: string, recap: ThreadMessage | undefined, log: ThreadMessage[], roundMessage: string): BuiltContext {
  const raw: ChatMessage[] = [];
  if (recap) raw.push({ role: 'user', content: recap.content });
  for (const m of log) raw.push({ role: m.role, content: m.content });
  raw.push({ role: 'user', content: roundMessage });
  return { system, messages: mergeAdjacent(raw) };
}

const h = (handle: string | null | undefined) => (handle ? `#${handle}` : '#?');
/** One sentence ending in exactly one period. */
const sentence = (text: string) => `${text.trim().replace(/[.\s]+$/, '')}.`;

function turnIndexOf(deps: ThreadDeps, turnId: string | null): number | undefined {
  return turnId ? deps.stories.getTurn(turnId)?.index : undefined;
}

/**
 * Is a thought already visible in this thread (so it must not be shown again)?
 * Visible = shown in a round message since the last compaction, written by the
 * owner in its own reply since then, or (after a compaction) restated in the recap.
 */
function visibleInThread(deps: ThreadDeps, t: Thought, recap: ThreadMessage | undefined): boolean {
  const cut = recap ? turnIndexOf(deps, recap.turnId) ?? -1 : -1;
  const after = (turnId: string | null) => {
    const idx = turnIndexOf(deps, turnId);
    return idx !== undefined && idx >= cut;
  };
  if (t.lastRecalledTurnId && after(t.lastRecalledTurnId)) return true;
  if (t.source === 'self' && t.createdTurnId && after(t.createdTurnId)) return true;
  if (recap && t.pinned && (turnIndexOf(deps, t.createdTurnId) ?? -1) < cut) return true; // restated in the recap
  return false;
}

/**
 * What an owner is shown this round (docs/11 §5.4): pinned thoughts not yet
 * visible in the thread, plus the tagged thoughts the active tags evoke. The
 * active set gets the owner's own tags found in `perceived` text added first.
 */
function chooseThoughts(deps: ThreadDeps, storyId: string, owner: string, recap: ThreadMessage | undefined, active: Set<string>, perceived: string, budget: number) {
  const all = deps.thoughts.list(storyId, owner);
  const vocabulary = deps.thoughts.vocabulary(storyId, owner).map((v) => v.tag);
  for (const t of tagsMentioned(perceived, vocabulary)) active.add(t);
  const shown = new Set(all.filter((t) => visibleInThread(deps, t, recap)).map((t) => t.id));
  const pinnedNew = all.filter((t) => t.pinned && !shown.has(t.id));
  const recalled = selectRecall(all, active, shown, budget);
  const pinnedTokens = all.filter((t) => t.pinned).reduce((n, t) => n + estimateTokens(renderThought(t)), 0);
  return { pinnedNew, recalled, pinnedTokens, vocabulary };
}

/** "health 7/10 (fine) · mood "wary"" for one holder, filtered for a viewer. */
function valueLine(deps: ThreadDeps, storyId: string, defs: VariableDef[], holder: HolderInfo, viewer: Viewer, markHidden: boolean): string {
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const d of defs) {
    if (!appliesTo(d, holder) || !canSee(d, holder.id, viewer)) continue;
    const part = `${d.key} ${renderValue(d, valueOf(deps, storyId, d, holder.id))}`;
    (markHidden && d.visibility === 'hidden' ? hidden : shown).push(part);
  }
  if (hidden.length) shown.push(`hidden: ${hidden.join(' · ')}`);
  return shown.join(' · ');
}

// ---- Character threads ----

function characterSession(deps: ThreadDeps, storyId: string, objectId: string): string {
  return deps.agents.ensureSession(storyId, 'character', 'minds', objectId).id;
}

/** The character's frozen system prompt: rules, contract, its own description and visible variable definitions. */
export function characterSystemPrompt(deps: ThreadDeps, storyId: string, objectId: string): string {
  const obj = deps.memory.getObject(objectId);
  const sheet = deps.sheets.get(objectId);
  const holder = holdersFor(deps, storyId).get(objectId) ?? { id: objectId, isPlayer: false };
  const viewer: Viewer = { kind: 'character', id: objectId };
  const lines: string[] = [];
  for (const d of deps.variables.listDefs(storyId)) {
    const mine = d.scope === 'character' && appliesTo(d, holder) && canSee(d, objectId, viewer);
    const world = d.scope === 'world' && canSee(d, 'world', viewer);
    if (!mine && !world) continue;
    const mayChange = mine && d.changedBy.includes('self');
    const step = mayChange && d.type === 'number' && d.maxStep ? `, by at most ${d.maxStep} per round` : '';
    const who = mayChange ? `YOU may change it${step}.` : d.changedBy.includes('narrator') ? 'The narrator changes it; you cannot.' : 'It does not change.';
    const guide = d.changeGuide ? ` ${d.changeGuide}` : '';
    lines.push(`- ${world ? '(the world) ' : ''}${d.key} (${renderRange(d)}): ${sentence(d.description || d.label)} ${who}${mayChange ? guide : ''}`.trim());
  }
  lines.push(`- state (one sentence): how you feel or are right now. YOU may update it; the narrator records what happens to you.`);
  return renderPrompt('minds-character', {
    name: obj?.name ?? 'the character',
    handle: h(obj?.handle ?? deps.memory.ensureHandle(objectId)),
    description: sheet?.description.trim() || '(Not written yet: improvise a personality that fits the story so far, and stay consistent with it.)',
    appearance: sheet?.appearance.trim() || '(not described yet)',
    variables: lines.join('\n'),
  });
}

/** "Not applied" notes for the character's own proposals from its last reply (docs/11 §4.6). */
function proposalNotes(deps: ThreadDeps, storyId: string, objectId: string, lastReply: ThreadMessage | undefined): string[] {
  if (!lastReply?.turnId) return [];
  return deps.variables
    .listChanges(storyId, { holder: objectId, turnId: lastReply.turnId })
    .filter((c) => c.by === 'self' && c.result !== 'applied')
    .reverse()
    .map((c) => {
      const key = c.key === STATE_KEY ? 'state' : c.key;
      if (c.result === 'rejected') return `Not applied: ${c.reason || `your change to ${key}`}.`;
      if (c.result === 'clamped') return `Adjusted: ${key} became ${JSON.stringify(c.new)} (limits).`;
      return `Overridden: what happened set your ${key} differently.`;
    });
}

/** Build a character's next call (read-only). */
export function buildCharacterCall(deps: ThreadDeps, input: CharacterCallInput): PreparedCall {
  const { storyId, objectId, here } = input;
  const story = deps.stories.getStory(storyId);
  const settings = story?.settings.minds;
  const sessionId = characterSession(deps, storyId, objectId);
  const recap = deps.threads.recap(sessionId);
  const log = deps.threads.log(sessionId);
  const pending = deps.threads.pending(sessionId);
  const lastReply = deps.threads.lastReply(sessionId);
  const defs = deps.variables.listDefs(storyId);
  const holders = holdersFor(deps, storyId);
  const holder = holders.get(objectId) ?? { id: objectId, isPlayer: false };
  const sheet = deps.sheets.get(objectId);

  // Active tags: the narrator's + what is around + the owner's tags mentioned in what it perceived.
  const active = new Set<string>(input.situationTags ?? []);
  for (const p of here.present) active.add(`#${p.handle}`);
  for (const i of here.items) active.add(`#${i.handle}`);
  if (here.location) active.add(`#${here.location.handle}`);
  const perceived = [...pending.map((p) => p.content), input.now ?? ''].join('\n');
  const chosen = chooseThoughts(deps, storyId, objectId, recap, active, perceived, settings?.thoughtRecallTokens ?? 300);
  const recalled = chosen.recalled;

  const parts: string[] = [];
  const present = [...here.present].sort((a, b) => a.handle.localeCompare(b.handle));
  const hereBits = [
    here.location ? `${h(here.location.handle)} (${here.location.name})` : 'an unnamed place',
    ...present.map((p) => `${h(p.handle)} ${p.name}${p.appearance ? ` — ${p.appearance}` : ''}`),
  ];
  const items = [...here.items].sort((a, b) => a.handle.localeCompare(b.handle));
  parts.push(`Here: ${hereBits.join(' · ')}${items.length ? ` · in view: ${items.map((i) => h(i.handle)).join(', ')}` : ''}`);
  if (pending.length) parts.push(`Since you last acted:\n${pending.map((p) => p.content.trim()).join('\n\n')}`);
  if (input.now?.trim()) parts.push(`Right now:\n${input.now.trim()}`);
  const notes = proposalNotes(deps, storyId, objectId, lastReply);
  if (notes.length) parts.push(notes.join('\n'));
  const own = valueLine(deps, storyId, defs, holder, { kind: 'character', id: objectId }, false);
  const world = valueLine(deps, storyId, defs, holders.get('world')!, { kind: 'character', id: objectId }, false);
  parts.push(`You now: ${sheet?.state ? `"${sheet.state}"` : '(no state noted yet)'}${own ? ` · ${own}` : ''}${world ? `\nThe world: ${world}` : ''}`);
  if (chosen.pinnedNew.length) parts.push(`Always on your mind:\n${chosen.pinnedNew.map(renderThought).join('\n')}`);
  if (recalled.length) parts.push(`You recall:\n${recalled.map(renderThought).join('\n')}`);
  if (chosen.pinnedTokens > (settings?.pinnedTokens ?? 400)) parts.push('Your pinned thoughts are long: unpin or merge some.');
  parts.push('Declare what you say and what you try to do. Reply as JSON.');
  const roundMessage = parts.join('\n\n');

  return {
    sessionId,
    ctx: assemble(characterSystemPrompt(deps, storyId, objectId), recap, log, roundMessage),
    roundMessage,
    pendingIds: pending.map((p) => p.id),
    recalledIds: [...chosen.pinnedNew, ...recalled].map((t) => t.id),
  };
}

/** Store a completed call: the round message and the reply (exactly as received), deliveries, recalls. */
export function commitCall(deps: ThreadDeps, call: PreparedCall, reply: string, turnId: string | null): void {
  deps.db.transaction(() => {
    deps.threads.append(call.sessionId, { role: 'user', content: call.roundMessage, turnId });
    deps.threads.append(call.sessionId, { role: 'assistant', content: reply, turnId });
    deps.threads.markDelivered(call.pendingIds);
    deps.thoughts.markRecalled(call.recalledIds, turnId);
  });
}

/** Queue text for a character's next round message (briefs, heard lines, notes). */
export function queueForCharacter(deps: ThreadDeps, storyId: string, objectId: string, text: string, turnId: string | null): void {
  deps.threads.append(characterSession(deps, storyId, objectId), { role: 'user', content: text, kind: 'pending', turnId });
}

// ---- The narrator's thread ----

function narratorSession(deps: ThreadDeps, storyId: string): string {
  return deps.agents.ensureSession(storyId, 'narrator', 'minds').id;
}

/** The narrator's frozen system prompt: rules, style, block contract, premise, every variable with its rules, secret notes. */
export function narratorSystemPrompt(deps: ThreadDeps, storyId: string): string {
  const story = deps.stories.getStory(storyId);
  const s = story!.settings;
  const player = deps.sheets.player(storyId);
  const playerObj = player ? deps.memory.getObject(player.objectId) : undefined;
  const override = deps.verbosityOverride?.() ?? {};
  const verbosity = override[String(s.verbosity)]?.trim() || VERBOSITY_STYLE[s.verbosity] || VERBOSITY_STYLE[3];
  const lines = deps.variables.listDefs(storyId).map((d) => {
    const scope = d.scope === 'world' ? 'world' : d.appliesTo === 'all' ? 'every character' : Array.isArray(d.appliesTo) ? d.appliesTo.map((x) => `#${x}`).join(', ') : d.appliesTo === 'player' ? 'the player character' : 'every non-player character';
    const vis = d.visibility === 'hidden' ? 'hidden from its holder' : d.visibility === 'public' ? 'visible to everyone present' : 'visible to its holder';
    const who = [d.changedBy.includes('narrator') ? 'you' : '', d.changedBy.includes('self') ? 'the holder' : ''].filter(Boolean).join(' and ') || 'nobody';
    const step = d.type === 'number' && d.maxStep ? `, at most ${d.maxStep} per round` : '';
    return `- ${d.key} (${renderRange(d)}; ${scope}; ${vis}; changed by ${who}${step}): ${sentence(d.description || d.label)}${d.changeGuide ? ` When/how: ${d.changeGuide}` : ''}`;
  });
  return renderPrompt('minds-narrator', {
    playerName: playerObj?.name ?? 'the player character',
    playerHandle: h(playerObj?.handle ?? (player ? deps.memory.ensureHandle(player.objectId) : 'player')),
    genre: s.genre,
    tone: s.tone,
    verbosity,
    premise: s.premise.trim() || '(none given)',
    variables: lines.length ? lines.join('\n') : '(none defined for this story)',
    secretNotes: s.minds.narratorNotes.trim() || '(none)',
    briefMaxWords: String(s.minds.briefMaxWords),
  });
}

function sheetBlock(deps: ThreadDeps, storyId: string, defs: VariableDef[], holder: HolderInfo, full: boolean): string[] {
  const obj = deps.memory.getObject(holder.id);
  const sheet = deps.sheets.get(holder.id);
  const lines = [`${h(holder.handle)} (${obj?.name ?? '?'})${sheet?.appearance ? ` — ${sheet.appearance}` : ''}`];
  if (full && sheet?.description) lines.push(`  Who: ${sheet.description.replace(/\s+/g, ' ').trim()}`);
  lines.push(`  State: ${sheet?.state ? `"${sheet.state}"` : '(none noted)'}`);
  const values = valueLine(deps, storyId, defs, holder, { kind: 'narrator' }, true);
  if (values) lines.push(`  Variables: ${values}`);
  return lines;
}

/** Build the narrator's next call (read-only). */
export function buildNarratorCall(deps: ThreadDeps, input: NarratorCallInput): PreparedCall {
  const { storyId } = input;
  const story = deps.stories.getStory(storyId)!;
  const sessionId = narratorSession(deps, storyId);
  const recap = deps.threads.recap(sessionId);
  const log = deps.threads.log(sessionId);
  const pending = deps.threads.pending(sessionId);
  const defs = deps.variables.listDefs(storyId);
  const holders = holdersFor(deps, storyId);
  const player = deps.sheets.player(storyId);

  const parts: string[] = [];
  if (pending.length) parts.push(pending.map((p) => p.content.trim()).join('\n\n'));

  const p = input.player;
  const said = [p.say?.trim() ? `says "${p.say.trim()}"` : '', p.do?.trim() ? `tries: ${p.do.trim()}` : ''].filter(Boolean).join(' · ');
  const playerLine = `The player${player ? ` (${h(holders.get(player.objectId)?.handle)})` : ''}: ${said || 'waits.'}${p.ooc?.trim() ? `\nNote to you from the player (out of character): ${p.ooc.trim()}` : ''}`;
  parts.push(playerLine);
  if (player) parts.push(sheetBlock(deps, storyId, defs, holders.get(player.objectId)!, false).join('\n'));

  const byId = new Map(input.declarations.map((d) => [d.objectId, d]));
  const present = input.presentIds.filter((id) => id !== player?.objectId && holders.has(id));
  if (present.length) {
    const blocks = present.map((oid) => {
      const lines = sheetBlock(deps, storyId, defs, holders.get(oid)!, true);
      const d = byId.get(oid);
      if (!d || d.status === 'idle') lines.push('  This round: not acting.');
      else if (d.status === 'unavailable') lines.push('  This round: unavailable (voice them briefly yourself, in character).');
      else {
        const bits = [
          d.say?.trim() ? `says "${d.say.trim()}"${d.to ? ` to ${d.to}` : ''}` : 'says nothing',
          d.intent?.trim() ? `tries: ${d.intent.trim()}` : '',
          d.state?.trim() ? `feels: "${d.state.trim()}"` : '',
        ].filter(Boolean);
        lines.push(`  This round: ${bits.join(' · ')}`);
      }
      return lines.join('\n');
    });
    parts.push(`Characters present:\n${blocks.join('\n')}`);
  }

  const world = valueLine(deps, storyId, defs, holders.get('world')!, { kind: 'narrator' }, true);
  if (world) parts.push(`The world: ${world}`);
  parts.push(`Time: ${formatGameClock(story.clockMin)}`);

  // The narrator's own notes, recalled by the same rules as characters' thoughts.
  const active = new Set<string>(input.situationTags ?? []);
  for (const oid of present) active.add(`#${holders.get(oid)?.handle}`);
  const declared = [p.say ?? '', p.do ?? '', ...input.declarations.flatMap((d) => [d.say ?? '', d.intent ?? ''])].join('\n');
  const chosen = chooseThoughts(deps, storyId, NARRATOR_OWNER, recap, active, declared, story.settings.minds.thoughtRecallTokens);
  const notes = [...chosen.pinnedNew, ...chosen.recalled];
  if (notes.length) parts.push(`Your notes in mind:\n${notes.map(renderThought).join('\n')}`);

  const tagsInUse = new Set<string>();
  for (const oid of present) for (const v of deps.thoughts.vocabulary(storyId, oid)) tagsInUse.add(v.tag);
  for (const v of chosen.vocabulary) tagsInUse.add(v);
  if (tagsInUse.size) parts.push(`Tags in use (reuse these): ${[...tagsInUse].sort().join(', ')}`);

  parts.push('Write the prose for the player, then the ```round block.');
  const roundMessage = parts.join('\n\n');
  return {
    sessionId,
    ctx: assemble(narratorSystemPrompt(deps, storyId), recap, log, roundMessage),
    roundMessage,
    pendingIds: pending.map((x) => x.id),
    recalledIds: notes.map((t) => t.id),
  };
}

/** Queue text for the narrator's next round message (e.g. a dialogue transcript to wrap up). */
export function queueForNarrator(deps: ThreadDeps, storyId: string, text: string, turnId: string | null): void {
  deps.threads.append(narratorSession(deps, storyId), { role: 'user', content: text, kind: 'pending', turnId });
}

/** The "Here:" line inputs from the current scene (until the round tracks location and items, M4). */
export function hereFromScene(deps: ThreadDeps & { stories: MindsDeps['stories'] }, storyId: string, objectId: string): HereInfo {
  const story = deps.stories.getStory(storyId);
  const scene = story?.currentSceneId ? deps.stories.getScene(story.currentSceneId) : undefined;
  const present = new Set<string>(scene?.activeNpcIds ?? []);
  const player = deps.sheets.player(storyId);
  if (player) present.add(player.objectId);
  present.delete(objectId);
  const loc = scene?.locationObjectId ? deps.memory.getObject(scene.locationObjectId) : undefined;
  return {
    location: loc ? { handle: deps.memory.ensureHandle(loc.id) ?? '', name: loc.name } : undefined,
    present: [...present]
      .map((oid) => {
        const obj = deps.memory.getObject(oid);
        return obj ? { handle: deps.memory.ensureHandle(oid) ?? '', name: obj.name, appearance: deps.sheets.get(oid)?.appearance ?? '' } : undefined;
      })
      .filter((x): x is HereInfo['present'][number] => !!x),
    items: (scene?.itemHandles ?? [])
      .map((handle) => {
        const obj = deps.memory.findByHandle(storyId, handle);
        return obj ? { handle: obj.handle ?? handle, name: obj.name } : undefined;
      })
      .filter((x): x is HereInfo['items'][number] => !!x),
  };
}
