import type { BuiltContext } from '../agents/agent.ts';
import type { ChatMessage } from '../llm/types.ts';
import type { Db } from '../db/db.ts';
import type { AgentStore } from '../db/stores/agentStore.ts';
import type { ThreadStore, ThreadMessage } from '../db/stores/threadStore.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { formatGameClock } from '../util/gameClock.ts';
import { estimateTokens } from '../util/tokens.ts';
import { VERBOSITY_STYLE } from '../orchestrator/contextBuilder.ts';
import { STATE_KEY, appliesTo, canSee, holdsRelation, relationHolder, relationParts, renderRange, renderValue } from './variables.ts';
import type { HolderInfo, VariableDef, Viewer } from './variables.ts';
import { EXPECTATION_SHOWN, NARRATOR_SEES, alwaysOn, selectRecall, tagsMentioned, thoughtHandle } from './thoughts.ts';
import { clampWords } from './text.ts';
import { knowsName, knownNames, namesOn } from './names.ts';
import { tieLines, tieSummary } from './ties.ts';
import { placesAndThings } from './places.ts';
import type { Thought } from './thoughts.ts';
import type { Beat } from './contracts.ts';
import { mixedBeats } from './contracts.ts';
import { holdersFor, thoughtLens, valueOf } from './service.ts';
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

/** What a character can see around it right now (the "Here:" block; docs/11 §2.4). */
export interface HereInfo {
  location?: { handle: string; name: string; line?: string };
  /** Others present, the player character included: their public profile. */
  present: { handle: string; name: string; appearance: string; pronouns?: string; visibly?: string; nameKnown?: boolean; awareness?: 'asleep' | 'unconscious' }[];
  items: { handle: string; name: string; line?: string }[];
}

export interface CharacterCallInput {
  storyId: string;
  objectId: string;
  here: HereInfo;
  /** The narrator's situation tags + its evoke tags for this character (last round block). */
  situationTags?: string[];
  /** What happens right now, before the character declares (the player's words this round). */
  now?: string;
  /** Dialogue mode (docs/10 §7): who the character is talking with — switches the ask to the conversation format. */
  conversationWith?: string;
  /** How much to say this round (docs/10 §5.1e), the round message's last line before the ask. */
  focusLine?: string;
}

export interface PreparedCall {
  sessionId: string;
  ctx: BuiltContext;
  roundMessage: string;
  /** Pending thread items folded into this round message. */
  pendingIds: string[];
  /** Thoughts shown in this round message (marked recalled on commit). */
  recalledIds: string[];
  /** Thoughts that came up because of something that happened (renewed on commit, docs/11 §5.7). */
  renewIds?: string[];
}

/** A present character's declaration this round, as the narrator receives it. */
export interface Declaration {
  objectId: string;
  status: 'acted' | 'idle' | 'unavailable';
  say?: string;
  to?: string;
  intent?: string;
  state?: string;
  /** Words and actions in order, when the reply gave them so (docs/10 §6). */
  beats?: Beat[];
  /** Its focus this round (docs/10 §5.1e). */
  focus?: string;
}

export interface NarratorCallInput {
  storyId: string;
  /** `to`: whom the player's words are meant for (docs/10 §5.1b): "#a, #b" or "everyone". `beats`: the order (§6). */
  player: { say?: string; do?: string; ooc?: string; to?: string; beats?: Beat[] };
  /** Present characters (not the player), in scene order. */
  presentIds: string[];
  declarations: Declaration[];
  /** The characters who act, in the order the narrator should tell them (docs/10 §5.1): new every round. */
  order?: string[];
  situationTags?: string[];
  /** Extra context for this round, e.g. a conversation that just ended (dialogue wrap-up). */
  context?: string;
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

/** Where a thread's memory stands: what is still in the thread starts at turn `liveFrom`. */
interface ThreadWindow {
  liveFrom: number;
}

function threadWindow(deps: ThreadDeps, recap: ThreadMessage | undefined, log: ThreadMessage[]): ThreadWindow {
  if (!recap) return { liveFrom: -1 };
  // After a compaction only the recap and the live log are in the thread. The recap restates the pinned
  // thoughts of its time, which the compaction marks recalled at its own turn (compaction.ts).
  const recapAt = turnIndexOf(deps, recap.turnId) ?? Number.MAX_SAFE_INTEGER;
  const firstLive = log.length ? turnIndexOf(deps, log[0].turnId) : undefined;
  return { liveFrom: Math.min(firstLive ?? recapAt, recapAt) };
}

/**
 * Is a thought already visible in this thread (so it must not be shown again)?
 * Visible = shown in a round message (or restated in the recap) still in the
 * thread, or written by the owner in its own reply there.
 */
function visibleInThread(deps: ThreadDeps, t: Thought, w: ThreadWindow): boolean {
  const live = (turnId: string | null) => {
    const idx = turnIndexOf(deps, turnId);
    return idx !== undefined && idx >= w.liveFrom;
  };
  if (t.lastRecalledTurnId && live(t.lastRecalledTurnId)) return true;
  if (t.source === 'self' && t.createdTurnId && live(t.createdTurnId)) return true;
  return false;
}

/**
 * What an owner is shown this round (docs/11 §5.4): pinned thoughts not yet
 * visible in the thread, plus the tagged thoughts the active tags evoke. The
 * active set gets the owner's own tags found in `perceived` text added first.
 */
function chooseThoughts(deps: ThreadDeps, storyId: string, owner: string, window: ThreadWindow, active: Set<string>, perceived: string, budget: number, present?: Set<string>, events?: Set<string>) {
  const lens = thoughtLens(deps, storyId);
  const all = deps.thoughts.list(storyId, owner);
  const vocabulary = deps.thoughts.vocabulary(storyId, owner).map((v) => v.tag);
  // What happened this round: the narrator's tags and evoke (`events`, given), and the owner's topics named in what
  // it perceived. A #handle named in a brief is just someone being there, not an event (docs/11 §5.7).
  const happened = new Set(events ?? []);
  for (const t of tagsMentioned(perceived, vocabulary)) {
    active.add(t);
    if (!t.startsWith('#')) happened.add(t);
  }
  const shown = new Set(all.filter((t) => visibleInThread(deps, t, window)).map((t) => t.id));
  // Always on their mind (docs/11 §5.9): the agenda first, then pinned and 9–10 thoughts; each once per window.
  const always = all.filter(alwaysOn).sort((a, b) => Number(b.kind === 'agenda') - Number(a.kind === 'agenda') || a.seq - b.seq);
  const pinnedNew = always.filter((t) => !shown.has(t.id));
  const recalled = selectRecall(all, active, shown, budget, { current: lens.current, present });
  // Already in the thread and relevant again this round.
  const cameUp = all.filter((t) => shown.has(t.id) && !alwaysOn(t) && (t.tags.some((g) => active.has(g)) || (!!t.about && !!present?.has(t.about))));
  // Renewed only when something that happened touches it, not because its subject is in the room (docs/11 §5.7).
  const renew = [...recalled, ...cameUp].filter((t) => t.tags.some((g) => happened.has(g)));
  const pinnedTokens = always.filter((t) => t.kind !== 'agenda').reduce((n, t) => n + estimateTokens(lens.render(t)), 0);
  const expectations = all.filter((t) => t.kind === 'expectation' && (t.confidence ?? 5) >= EXPECTATION_SHOWN).sort((a, b) => a.seq - b.seq);
  return { pinnedNew, recalled, cameUp, renew, expectations, pinnedTokens, vocabulary, render: lens.render };
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

/**
 * Relation values (docs/11 §4.9) of `from` toward each of `others`, as `viewer` may see them:
 * "trust → #agnes 2/10, #rin 9/10 · affection → #agnes 5/10". Only pairs who have met.
 */
function relationLine(deps: ThreadDeps, storyId: string, defs: VariableDef[], holders: Map<string, HolderInfo>, from: string, others: string[], viewer: Viewer): string {
  const parts: string[] = [];
  const handleOf = (oid: string) => deps.memory.getObject(oid)?.handle ?? '';
  const sorted = [...new Set(others)].sort((a, b) => handleOf(a).localeCompare(handleOf(b)));
  for (const d of defs) {
    if (d.scope !== 'relation') continue;
    const vals: string[] = [];
    for (const other of sorted) {
      if (other === from) continue;
      const hid = relationHolder(d, from, other);
      const holder = holders.get(hid);
      if (!holder || !appliesTo(d, holder) || !canSee(d, hid, viewer)) continue;
      vals.push(`${h(deps.memory.getObject(other)?.handle)} ${renderValue(d, valueOf(deps, storyId, d, hid))}`);
    }
    if (vals.length) parts.push(`${d.key} → ${vals.join(', ')}`);
  }
  return parts.join(' · ');
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
  const lines = characterVariableLines(deps.variables.listDefs(storyId), holder);
  return renderPrompt('minds-character', {
    name: obj?.name ?? 'the character',
    handle: h(obj?.handle ?? deps.memory.ensureHandle(objectId)),
    description: whoYouAre(deps, storyId, objectId),
    appearance: `${sheet?.pronouns ? `Pronouns: ${sheet.pronouns}. ` : ''}${sheet?.appearance.trim() || '(not described yet)'}`,
    variables: lines.join('\n'),
  });
}

/** The "Your variables" lines of a character's system prompt: what it can see, and what it may change. */
export function characterVariableLines(defs: VariableDef[], holder: HolderInfo): string[] {
  const viewer: Viewer = { kind: 'character', id: holder.id };
  const lines: string[] = [];
  for (const d of defs) {
    if (d.scope === 'relation') {
      // Toward each person they have met (docs/11 §4.9): their own side, when they may see it.
      if (!holdsRelation(d, holder) || d.visibility === 'hidden') continue;
      const mayChange = d.changedBy.includes('self');
      const step = mayChange && d.type === 'number' && d.maxStep ? `, by at most ${d.maxStep} per round` : '';
      const who = mayChange ? `YOU may change your own${step} (with "to": their #handle).` : d.changedBy.includes('narrator') ? 'The narrator changes it; you cannot.' : 'It does not change.';
      lines.push(`- ${d.key} (${renderRange(d)}), ${d.mutual ? 'shared between you and each person you have met' : 'yours toward each person you have met'}: ${sentence(d.description || d.label)} ${who}${mayChange && d.changeGuide ? ` ${d.changeGuide}` : ''}`.trim());
      continue;
    }
    const mine = d.scope === 'character' && appliesTo(d, holder) && canSee(d, holder.id, viewer);
    const world = d.scope === 'world' && canSee(d, 'world', viewer);
    if (!mine && !world) continue;
    const mayChange = mine && d.changedBy.includes('self');
    const step = mayChange && d.type === 'number' && d.maxStep ? `, by at most ${d.maxStep} per round` : '';
    const who = mayChange ? `YOU may change it${step}.` : d.changedBy.includes('narrator') ? 'The narrator changes it; you cannot.' : 'It does not change.';
    const guide = d.changeGuide ? ` ${d.changeGuide}` : '';
    lines.push(`- ${world ? '(the world) ' : ''}${d.key} (${renderRange(d)}): ${sentence(d.description || d.label)} ${who}${mayChange ? guide : ''}`.trim());
  }
  lines.push(`- state (one sentence): your body and mood right now (physical and emotional condition only). YOU may update it; the narrator records what happens to you.`);
  return lines;
}

/** The variables section of the narrator's system prompt: every definition with its rules. */
export function narratorVariableLines(defs: VariableDef[]): string[] {
  return defs.map((d) => {
    const holders = d.appliesTo === 'all' ? 'every character' : Array.isArray(d.appliesTo) ? d.appliesTo.map((x) => `#${x}`).join(', ') : d.appliesTo === 'player' ? 'the player character' : 'every non-player character';
    const scope = d.scope === 'world' ? 'world' : d.scope === 'relation' ? (d.mutual ? `one shared value per pair who have met (${holders}); set with "who" and "to"` : `${holders}, one value toward each person they have met; set with "who" and "to"`) : holders;
    const vis = d.visibility === 'hidden' ? 'hidden from its holder' : d.visibility === 'public' ? 'visible to everyone present' : 'visible to its holder';
    const who = [d.changedBy.includes('narrator') ? 'you' : '', d.changedBy.includes('self') ? 'the holder' : ''].filter(Boolean).join(' and ') || 'nobody';
    const step = d.type === 'number' && d.maxStep ? `, at most ${d.maxStep} per round` : '';
    return `- ${d.key} (${renderRange(d)}; ${scope}; ${vis}; changed by ${who}${step}): ${sentence(d.description || d.label)}${d.changeGuide ? ` When/how: ${d.changeGuide}` : ''}`;
  });
}

/**
 * "Who you are": the description; until the seeder writes it, the narrator's hand-over (docs/11 §2.3); then the
 * character's ties (docs/11 §2.6), so it always knows who its people are.
 */
function whoYouAre(deps: ThreadDeps, storyId: string, objectId: string): string {
  const sheet = deps.sheets.get(objectId);
  const core = sheet?.description.trim()
    || (sheet?.concept.trim() ? `${sheet.concept.trim()}\n(More about you is still being written: stay true to this, and fill in the rest the way this person would be.)` : '')
    || '(Not written yet: improvise a personality that fits the story so far, and stay consistent with it.)';
  const ties = tieLines(deps, storyId, objectId);
  const nature = sheet?.nature.trim() ? `\n\nYour nature: ${sheet.nature.trim()}` : '';
  return `${core}${nature}${ties.length ? `\n\nYour people (how you know them):\n${ties.join('\n')}` : ''}`;
}

/** "Not applied" notes for the character's own proposals from its last reply (docs/11 §4.6). */
function proposalNotes(deps: ThreadDeps, storyId: string, objectId: string, lastReply: ThreadMessage | undefined): string[] {
  if (!lastReply?.turnId) return [];
  return deps.variables
    .listChanges(storyId, { turnId: lastReply.turnId })
    .filter((c) => c.holder === objectId || relationParts(c.holder)?.from === objectId || relationParts(c.holder)?.to === objectId)
    .filter((c) => c.by === 'self' && c.result !== 'applied')
    .reverse()
    .map((c) => {
      const key = c.key === STATE_KEY ? 'state' : c.key;
      if (c.result === 'rejected') return `Not applied: ${c.reason || `your change to ${key}`}.`;
      if (c.result === 'clamped') return `Adjusted: ${key} became ${JSON.stringify(c.new)} (limits).`;
      return `Overridden: what happened set your ${key} differently.`;
    });
}

/**
 * The "Here:" block: the place, everyone present with their public profile
 * (pronouns, appearance, what is visibly true), and the things in view.
 *   Here: #broken-wheel (broken wheel) — a smugglers' inn on the coast road.
 *   - #kael Kael (he/him) — Tall, rain-soaked. Visibly: health 7/10 (fine)
 *   In view: #ledger (ledger — the smugglers' book of debts)
 */
export function renderHere(here: HereInfo): string {
  const loc = here.location;
  const lines = [`Here: ${loc ? `${h(loc.handle)} (${loc.name})${loc.line ? ` — ${loc.line}` : ''}` : 'an unnamed place'}`];
  for (const p of [...here.present].sort((a, b) => a.handle.localeCompare(b.handle))) {
    // A name the viewer hasn't learned stays out (docs/11 §2.5): the handle is made from what they look like.
    const who = p.nameKnown === false
      ? `${h(p.handle)}, name unknown to you${p.pronouns ? ` (${p.pronouns})` : ''}`
      : `${h(p.handle)} ${p.name}${p.pronouns ? ` (${p.pronouns})` : ''}`;
    lines.push(`- ${who}${p.awareness ? ` (${p.awareness})` : ''}${p.appearance ? ` — ${sentence(p.appearance)}` : ''}${p.visibly ? ` Visibly: ${p.visibly}` : ''}`);
  }
  const items = [...here.items].sort((a, b) => a.handle.localeCompare(b.handle));
  if (items.length) lines.push(`In view: ${items.map((i) => `${h(i.handle)}${i.line ? ` (${i.name} — ${i.line})` : ''}`).join(', ')}`);
  return lines.join('\n');
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
  const presentIds = new Set(here.present.map((p) => deps.memory.findByHandle(storyId, p.handle)?.id).filter((x): x is string => !!x));
  const chosen = chooseThoughts(deps, storyId, objectId, threadWindow(deps, recap, log), active, perceived, settings?.thoughtRecallTokens ?? 300, presentIds, new Set(input.situationTags ?? []));
  const recalled = chosen.recalled;

  const parts: string[] = [];
  parts.push(renderHere(here));
  if (pending.length) parts.push(`Since you last acted:\n${pending.map((p) => p.content.trim()).join('\n\n')}`);
  if (input.now?.trim()) parts.push(`Right now:\n${input.now.trim()}`);
  const notes = proposalNotes(deps, storyId, objectId, lastReply);
  if (notes.length) parts.push(notes.join('\n'));
  const own = valueLine(deps, storyId, defs, holder, { kind: 'character', id: objectId }, false);
  const world = valueLine(deps, storyId, defs, holders.get('world')!, { kind: 'character', id: objectId }, false);
  const toward = relationLine(deps, storyId, defs, holders, objectId, [...presentIds], { kind: 'character', id: objectId });
  parts.push(`You now: ${sheet?.state ? `"${sheet.state}"` : '(no state noted yet)'}${own ? ` · ${own}` : ''}${toward ? `\nToward others: ${toward}` : ''}${world ? `\nThe world: ${world}` : ''}`);
  const agenda = chosen.pinnedNew.filter((t) => t.kind === 'agenda');
  const always = chosen.pinnedNew.filter((t) => t.kind !== 'agenda');
  if (agenda.length) parts.push(`Your agenda:\n${agenda.map(chosen.render).join('\n')}`);
  if (always.length) parts.push(`Always on your mind:\n${always.map(chosen.render).join('\n')}`);
  if (recalled.length) parts.push(`You recall:\n${recalled.map(chosen.render).join('\n')}`);
  // What it foresees (docs/11 §5.11): it says in "outcomes" when one came true or didn't.
  if (chosen.expectations.length) {
    parts.push(`Your expectations (if one came true or plainly didn't, say so in "outcomes"):\n${chosen.expectations.map(chosen.render).join('\n')}`);
  }
  if (chosen.pinnedTokens > (settings?.pinnedTokens ?? 400)) parts.push('Your pinned thoughts are long: unpin or merge some.');
  // Close to where recent text weighs most: who they are (docs/11 §2.7).
  if (sheet?.nature.trim()) parts.push(`Stay yourself: ${sheet.nature.trim().replace(/\s+/g, ' ')}`);
  if (input.focusLine) parts.push(input.focusLine);
  parts.push(
    input.conversationWith
      ? `You are in a direct conversation with ${input.conversationWith}. Reply as JSON in the conversation format.`
      : 'Declare what you say and what you try to do. Reply as JSON.',
  );
  const roundMessage = parts.join('\n\n');

  return {
    sessionId,
    ctx: assemble(characterSystemPrompt(deps, storyId, objectId), recap, log, roundMessage),
    roundMessage,
    pendingIds: pending.map((p) => p.id),
    recalledIds: [...chosen.pinnedNew, ...recalled, ...chosen.cameUp].map((t) => t.id),
    renewIds: chosen.renew.map((t) => t.id),
  };
}

/** Store a completed call: the round message and the reply (exactly as received), deliveries, recalls. */
export function commitCall(deps: ThreadDeps, call: PreparedCall, reply: string, turnId: string | null): void {
  deps.db.transaction(() => {
    deps.threads.append(call.sessionId, { role: 'user', content: call.roundMessage, turnId });
    deps.threads.append(call.sessionId, { role: 'assistant', content: reply, turnId });
    deps.threads.markDelivered(call.pendingIds);
    deps.thoughts.markRecalled(call.recalledIds, turnId);
    if (call.renewIds?.length) deps.thoughts.renew(call.renewIds);
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

/** The narrator's rule for names, when the story tracks who knows whom (docs/11 §2.5). */
const NAMES_RULE = `
- **Names: nobody knows a stranger's name.** Each sheet in your round message says whose names that person knows.
  In a brief, use a name only if its reader knows it; otherwise the person's #handle (the app replaces any other
  name with the handle). In the prose, use a name only if the player knows it; otherwise describe the person. A
  name said aloud is learned by everyone who heard it. Record any other learning (a letter, an introduction you
  narrate) in "names". Give every newcomer a "knownAs" (what strangers call them) and say whom they already know.`;

/** The narrator's frozen system prompt: rules, style, block contract, premise, every variable with its rules, secret notes. */
export function narratorSystemPrompt(deps: ThreadDeps, storyId: string): string {
  const story = deps.stories.getStory(storyId);
  const s = story!.settings;
  const player = deps.sheets.player(storyId);
  const playerObj = player ? deps.memory.getObject(player.objectId) : undefined;
  const override = deps.verbosityOverride?.() ?? {};
  const verbosity = override[String(s.verbosity)]?.trim() || VERBOSITY_STYLE[s.verbosity] || VERBOSITY_STYLE[3];
  const lines = narratorVariableLines(deps.variables.listDefs(storyId));
  return renderPrompt('minds-narrator', {
    playerName: playerObj?.name ?? 'the player character',
    playerHandle: h(playerObj?.handle ?? (player ? deps.memory.ensureHandle(player.objectId) : 'player')),
    genre: s.genre,
    tone: s.tone,
    verbosity,
    premise: s.premise.trim() || '(none given)',
    variables: lines.length ? lines.join('\n') : '(none defined for this story)',
    secretNotes: s.minds.narratorNotes.trim() || '(none)',
    namesRule: namesOn(deps, storyId) ? NAMES_RULE : '',
    briefMaxWords: String(s.minds.briefMaxWords),
  });
}

function sheetBlock(deps: ThreadDeps, storyId: string, defs: VariableDef[], holder: HolderInfo, full: boolean, others: string[] = []): string[] {
  const obj = deps.memory.getObject(holder.id);
  const sheet = deps.sheets.get(holder.id);
  const lines = [`${h(holder.handle)} (${obj?.name ?? '?'}${sheet?.pronouns ? `, ${sheet.pronouns}` : ''})${sheet?.appearance ? ` — ${sheet.appearance}` : ''}`];
  if (namesOn(deps, storyId)) {
    // Who knows whose name (docs/11 §2.5): briefs and prose use a name only for someone who knows it.
    const others = deps.sheets.listForStory(storyId).map((x) => x.objectId).filter((id) => id !== holder.id);
    const known = knownNames(deps, storyId, holder.id, others).map((id) => h(deps.memory.getObject(id)?.handle));
    lines.push(`  Known to strangers as: ${sheet?.knownAs || '(not set)'} · knows the names of: ${known.length ? known.join(', ') : 'nobody yet'}`);
  }
  const who = sheet?.description.trim() || sheet?.concept.trim();
  if (full && who) lines.push(`  Who: ${who.replace(/\s+/g, ' ')}`);
  if (full && sheet?.nature.trim()) lines.push(`  Nature: ${sheet.nature.trim().replace(/\s+/g, ' ')}`);
  const ties = tieSummary(deps, holder.id);
  if (ties.length) lines.push(`  Ties: ${ties.join(', ')}`);
  if (full && !holder.isPlayer) {
    // Their agenda and strongest opinions and feelings (docs/11 §5.9, settled with the owner).
    const lens = thoughtLens(deps, storyId);
    const mine = deps.thoughts.list(storyId, holder.id);
    const agenda = mine.filter((t) => t.kind === 'agenda');
    if (agenda.length) lines.push(`  Agenda: ${agenda.map((t) => t.text).join(' · ')}`);
    const strong = mine
      .filter((t) => (t.kind === 'opinion' || t.kind === 'feeling') && lens.current(t) >= NARRATOR_SEES)
      .sort((a, b) => lens.current(b) - lens.current(a) || b.seq - a.seq)
      .slice(0, 5)
      .map((t) => {
        const about = lens.aboutHandle(t);
        return `(${t.kind}${about ? ` ${t.kind === 'opinion' ? 'of' : 'about'} #${about}` : ''}, ${lens.current(t)}/10) ${t.text}`;
      });
    if (strong.length) lines.push(`  Strongly: ${strong.join(' · ')}`);
  }
  lines.push(`  State: ${sheet?.state ? `"${sheet.state}"` : '(none noted)'}`);
  if (sheet && sheet.awareness !== 'awake') {
    lines.push(`  ${sheet.awareness === 'asleep' ? 'Asleep' : 'Unconscious'}: perceives nothing and can't act. If something wakes them, set "awareness": "awake" for them in the block and brief what they notice as they come to.`);
  }
  const values = valueLine(deps, storyId, defs, holder, { kind: 'narrator' }, true);
  if (values) lines.push(`  Variables: ${values}`);
  const toward = relationLine(deps, storyId, defs, holdersFor(deps, storyId), holder.id, others, { kind: 'narrator' });
  if (toward) lines.push(`  Toward others: ${toward}`);
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
  if (input.context?.trim()) parts.push(input.context.trim());

  const p = input.player;
  const said = [p.say?.trim() ? `says "${p.say.trim()}"${p.to ? ` to ${p.to}` : ''}` : '', p.do?.trim() ? `tries: ${p.do.trim()}` : ''].filter(Boolean).join(' · ');
  const who = `The player${player ? ` (${h(holders.get(player.objectId)?.handle)})` : ''}`;
  // Words and actions in the order they were typed (docs/10 §6).
  const ordered = mixedBeats(p.beats)
    ? `${who}, in this order${p.to ? ` (speaking to ${p.to})` : ''}:\n${p.beats!.map((b, i) => `${i + 1}. ${b.kind === 'say' ? `says "${b.text}"` : `tries: ${b.text}`}`).join('\n')}`
    : `${who}: ${said || 'waits.'}`;
  const playerLine = `${ordered}${p.ooc?.trim() ? `\nNote to you from the player (out of character): ${p.ooc.trim()}` : ''}`;
  parts.push(playerLine);
  const everyone = [...input.presentIds, ...(player ? [player.objectId] : [])];
  if (player) parts.push(sheetBlock(deps, storyId, defs, holders.get(player.objectId)!, false, everyone).join('\n'));

  const byId = new Map(input.declarations.map((d) => [d.objectId, d]));
  const present = input.presentIds.filter((id) => id !== player?.objectId && holders.has(id));
  if (present.length) {
    const blocks = present.map((oid) => {
      const lines = sheetBlock(deps, storyId, defs, holders.get(oid)!, true, everyone);
      const d = byId.get(oid);
      if (!d || d.status === 'idle') lines.push('  This round: not acting.');
      else if (d.status === 'unavailable') lines.push('  This round: unavailable (voice them briefly yourself, in character).');
      else if (d.beats?.length) {
        // In the order the character gave (docs/10 §6).
        const seq = d.beats.map((b) => (b.kind === 'say' ? `says "${b.text}"` : `tries: ${b.text}`)).join(' → ');
        lines.push(`  This round, in this order${d.to ? ` (speaking to ${d.to})` : ''}: ${seq}${d.state?.trim() ? ` · feels: "${d.state.trim()}"` : ''}`);
      } else {
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
    // Said outright, or the narrator falls back on the order of its own earlier rounds (settled after a play test).
    const acting = (input.order ?? []).filter((oid) => present.includes(oid));
    if (acting.length >= 2) parts.push(`Order this round: ${acting.map((oid) => h(holders.get(oid)?.handle)).join(' → ')}. Tell what they say and do in this order; a quick reaction may still cut in.`);
  }

  // Places and things with their #handles, so the block reuses them instead of naming them afresh (docs/10 §5.1d).
  const scene = story.currentSceneId ? deps.stories.getScene(story.currentSceneId) : undefined;
  const things = placesAndThings(deps, storyId, scene);
  if (things) parts.push(things);
  const world = valueLine(deps, storyId, defs, holders.get('world')!, { kind: 'narrator' }, true);
  if (world) parts.push(`The world: ${world}`);
  parts.push(`Time: ${formatGameClock(story.clockMin)}`);

  // The narrator's own notes, recalled by the same rules as characters' thoughts.
  const active = new Set<string>(input.situationTags ?? []);
  for (const oid of present) active.add(`#${holders.get(oid)?.handle}`);
  const declared = [p.say ?? '', p.do ?? '', ...input.declarations.flatMap((d) => [d.say ?? '', d.intent ?? ''])].join('\n');
  const chosen = chooseThoughts(deps, storyId, NARRATOR_OWNER, threadWindow(deps, recap, log), active, declared, story.settings.minds.thoughtRecallTokens);
  const notes = [...chosen.pinnedNew, ...chosen.recalled];
  if (notes.length) parts.push(`Your notes in mind:\n${notes.map(chosen.render).join('\n')}`);

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

/**
 * A thought changed by hand (advanced mode, docs/11 §5.10c), told to its mind with its next round. Its thread still
 * holds the old version (an agenda is shown once per window), so untold it would go on acting on it, or write it back.
 */
export function tellOfHandEdit(deps: ThreadDeps, before: Thought, after: Thought, change: 'forgot' | 'restored' | 'edited'): void {
  const session = deps.agents
    .listSessions(before.storyId)
    .find((s) => (before.owner === NARRATOR_OWNER ? s.role === 'narrator' : s.role === 'character' && s.npcObjectId === before.owner));
  if (!session || !deps.threads.log(session.id).length) return; // it hasn't seen its thoughts yet: its next round shows them as they are
  const lens = thoughtLens(deps, before.storyId);
  const handle = thoughtHandle(before);
  const visible = (t: Thought) => JSON.stringify([t.text, t.kind, t.importance, t.about, [...t.tags].sort(), t.confidence, t.hope, t.horizon]);
  const text =
    change === 'forgot'
      ? `You have let go of ${handle} (${before.kind}): "${before.text}" It is no longer on your mind; don't take it up again unless something new brings it back.`
      : change === 'restored'
        ? `${handle} is on your mind again: ${lens.render(after)}`
        : visible(before) === visible(after)
          ? ''
          : `Your thought ${handle} has changed${after.formerText && after.formerText !== before.formerText ? ` (it said: "${after.formerText}")` : ''}. It now reads: ${lens.render(after)}`;
  if (text) deps.threads.append(session.id, { role: 'user', content: text, kind: 'pending', turnId: null });
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
  const defs = deps.variables.listDefs(storyId);
  const holders = holdersFor(deps, storyId);
  const oneLine = (text: string | undefined, words: number) => (text?.trim() ? clampWords(text.replace(/\s+/g, ' ').trim(), words).text.replace(/[.\s]+$/, '') : undefined);
  return {
    location: loc ? { handle: deps.memory.ensureHandle(loc.id) ?? '', name: loc.name, line: oneLine(loc.summary, 25) } : undefined,
    present: [...present]
      .map((oid) => {
        const obj = deps.memory.getObject(oid);
        if (!obj) return undefined;
        const sheet = deps.sheets.get(oid);
        const holder = holders.get(oid);
        // Only what anyone present may see: public variables (docs/11 §1).
        const visibly = holder ? valueLine(deps, storyId, defs, holder, { kind: 'character', id: objectId }, false) : '';
        return {
          handle: deps.memory.ensureHandle(oid) ?? '',
          name: obj.name,
          ...(knowsName(deps, storyId, objectId, oid) ? {} : { nameKnown: false }),
          appearance: sheet?.appearance ?? '',
          ...(sheet?.pronouns ? { pronouns: sheet.pronouns } : {}),
          ...(visibly ? { visibly } : {}),
          // Anyone present can see someone is asleep or out cold (docs/10 §5.1f).
          ...(sheet && sheet.awareness !== 'awake' ? { awareness: sheet.awareness } : {}),
        };
      })
      .filter((x): x is HereInfo['present'][number] => !!x),
    items: (scene?.itemHandles ?? [])
      .map((handle) => {
        const obj = deps.memory.findByHandle(storyId, handle);
        if (!obj) return undefined;
        const line = oneLine(obj.summary, 15);
        return { handle: obj.handle ?? handle, name: obj.name, ...(line ? { line } : {}) };
      })
      .filter((x): x is HereInfo['items'][number] => !!x),
  };
}
