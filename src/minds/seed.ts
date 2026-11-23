import type { Job } from '../db/stores/jobStore.ts';
import type { JobHandler } from '../orchestrator/postTurn.ts';
import type { VariableDef } from './variables.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { renderRecentStory } from '../orchestrator/handlers.ts';
import { formatGameClock } from '../util/gameClock.ts';
import { applyChanges, applyThoughtOps, holdersFor } from './service.ts';
import { STATE_KEY, appliesTo, renderRange } from './variables.ts';
import { knowsName, namesOn } from './names.ts';
import { hereFromScene, renderHere } from './builders.ts';
import { setTie, tieSummary } from './ties.ts';
import { clampWords, clampWordsKeepLines } from './text.ts';
import type { Proposal } from './variables.ts';
import type { RoundDeps } from './round.ts';

// minds_seed (docs/11 §2.3): give a character the narrator just introduced a
// mind — description, state, starting values and 3–10 thoughts — parsing what
// the story has established first and inventing second. It reads the frame
// (premise, genre, tone, time, place), who the player character is, the
// narrator's hand-over and ties, what the newcomer perceived on arriving, the
// people around them as they know them, the narrator's recap and the recent
// story. Never the narrator's secret notes, nor anyone else's private sheet.
// Never overwrites what the user wrote.

/** Whose names the newcomer knows (docs/11 §2.5): the others are strangers, written as their #handles. */
function namesNote(deps: RoundDeps, storyId: string, objectId: string, name: string): string {
  const lines = deps.sheets
    .listForStory(storyId)
    .filter((s) => s.objectId !== objectId && deps.memory.getObject(s.objectId))
    .map((s) => {
      const o = deps.memory.getObject(s.objectId)!;
      return knowsName(deps, storyId, objectId, s.objectId) ? `- #${o.handle} ${o.name}: ${name} knows this name` : `- #${o.handle} (${s.knownAs || 'a stranger'}): ${name} doesn't know this name; write #${o.handle}, never the name`;
    });
  return `People in the story, as ${name} knows them:\n${lines.join('\n') || '(nobody yet)'}`;
}

const VISIBILITY: Record<VariableDef['visibility'], string> = {
  public: 'public: everyone present sees it',
  self: 'self: only they and the narrator know it',
  hidden: "hidden: only the narrator knows it — they don't, so their thoughts must not mention it",
};

/** A seeded text as stored: escaped line breaks ("\n" written out) become real ones. */
export const unescapeText = (text: string): string => text.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, ' ').trim();

/** What the newcomer perceived so far: its round messages (the narrator's briefs, the words heard), most recent last. */
function perceived(deps: RoundDeps, storyId: string, objectId: string): string[] {
  const sessionId = deps.agents.ensureSession(storyId, 'character', 'minds', objectId).id;
  return [...deps.threads.log(sessionId), ...deps.threads.pending(sessionId)]
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => clampWords(m.content.trim(), 200).text);
}

/** The seeder's user message: everything the story has established about the newcomer and its world. */
export function seedContext(deps: RoundDeps, storyId: string, objectId: string): string {
  const story = deps.stories.getStory(storyId)!;
  const s = story.settings;
  const obj = deps.memory.getObject(objectId)!;
  const sheet = deps.sheets.get(objectId)!;
  const handle = obj.handle ?? deps.memory.ensureHandle(objectId)!;
  const name = obj.name;
  const holder = holdersFor(deps, storyId).get(objectId) ?? { id: objectId, isPlayer: false };
  const defs = deps.variables.listDefs(storyId).filter((d) => appliesTo(d, holder));

  const player = deps.sheets.player(storyId);
  const playerObj = player ? deps.memory.getObject(player.objectId) : undefined;
  const playerTag = playerObj ? `#${playerObj.handle ?? deps.memory.ensureHandle(playerObj.id)}` : '';
  const playerLine = playerObj
    ? `${playerTag} ${playerObj.name}${player!.pronouns ? ` (${player!.pronouns})` : ''}${player!.appearance.trim() ? ` — ${player!.appearance.trim()}` : ''}`
    : '';

  const own = [
    `- Handle: #${handle}`,
    `- Look: ${sheet.appearance.trim() || '(not described yet)'}`,
    `- Pronouns: ${sheet.pronouns.trim() || '(not given)'}`,
    ...(namesOn(deps, storyId) ? [`- Known to strangers as: ${sheet.knownAs.trim() || '(not set)'}`] : []),
    `- Who they are (the narrator's hand-over; canon): ${sheet.concept.trim() || '(not given)'}`,
  ];
  const ties = tieSummary(deps, objectId);
  own.push(`- Their people (canon): ${ties.length ? ties.join(', ') : '(none recorded)'}`);
  if (sheet.description.trim()) own.push(`- Description written so far (rewrite it, keep what it establishes): ${sheet.description.trim()}`);

  const narratorSession = deps.agents.ensureSession(storyId, 'narrator', 'minds').id;
  const recap = deps.threads.recap(narratorSession)?.content.trim();
  const seen = perceived(deps, storyId, objectId);
  const variables = defs.map((d) => `- ${d.key} (${renderRange(d)}; ${VISIBILITY[d.visibility]}): ${d.description || d.label}`);

  return [
    `The premise: ${s.premise.trim() || '(none given)'}`,
    `Genre: ${s.genre || '(any)'} · Tone: ${s.tone || '(any)'} · Now: ${formatGameClock(story.clockMin)}`,
    playerLine
      ? `The player character: ${playerLine}\nThe narration speaks to the player as "you": in the story text, "you" is always ${playerTag}, never ${name}.`
      : 'The player character has not been introduced yet. In the story text, "you" is the player, never ' + name + '.',
    `${name}, as the narrator brought them in:\n${own.join('\n')}`,
    `What ${name} perceived on arriving (their first messages, most recent last):\n${seen.length ? seen.map((m) => `---\n${m}`).join('\n') : '(nothing yet)'}`,
    `Around ${name} now, as ${name} perceives it:\n${renderHere(hereFromScene(deps, storyId, objectId))}`,
    ...(namesOn(deps, storyId) ? [namesNote(deps, storyId, objectId, name)] : []),
    ...(recap ? [`The story before the recent part (the narrator's recap):\n${recap}`] : []),
    `The story so far (most recent last):\n${renderRecentStory(deps.stories, storyId, 3000, playerObj ? `Player (${playerTag})` : 'Player') || '(nothing yet)'}`,
    `Variables ${name} holds:\n${variables.join('\n') || '(none)'}`,
    `Create the mind for ${name} (#${handle}). Reply as JSON.`,
  ].join('\n\n');
}

export function createMindsSeedHandler(deps: RoundDeps): JobHandler {
  return async (job: Job) => {
    const storyId = job.storyId!;
    const objectId = job.payload.objectId as string;
    const force = !!job.payload.force;
    const story = deps.stories.getStory(storyId);
    const obj = deps.memory.getObject(objectId);
    const sheet = deps.sheets.get(objectId);
    if (!story || !obj || !sheet) return; // deleted or rewound meanwhile
    if (sheet.seeded && !force) return;

    const handle = obj.handle ?? deps.memory.ensureHandle(objectId)!;
    const holder = holdersFor(deps, storyId).get(objectId) ?? { id: objectId, isPlayer: false };
    const defs = deps.variables.listDefs(storyId).filter((d) => appliesTo(d, holder));
    const maxWords = story.settings.minds.descriptionMaxWords;
    const bound = deps.registry.getForRole('seeder', story.settings.roles.seeder);
    const session = deps.agents.ensureSession(storyId, 'seeder', bound.name, objectId);
    const reply = await new MindAgent({ session, bound, threadLog: deps.threadLog, storyId }).seed(
      {
        system: renderPrompt('minds-seed', { name: obj.name, handle: `#${handle}`, maxWords: String(Math.min(200, maxWords)) }),
        messages: [{ role: 'user', content: seedContext(deps, storyId, objectId) }],
      },
      { maxTokens: 2000 },
    );

    const now = deps.sheets.get(objectId);
    if (!now || !deps.memory.getObject(objectId)) return; // removed while generating
    const description = clampWordsKeepLines(unescapeText(reply.description), maxWords);
    const state = clampWords(unescapeText(reply.state).replace(/\s*\n\s*/g, ' '), 40).text;
    deps.db.transaction(() => {
      deps.sheets.upsert(storyId, objectId, {
        ...(description && (force || !now.description.trim()) ? { description } : {}),
        ...(reply.appearance && !now.appearance.trim() ? { appearance: unescapeText(reply.appearance) } : {}),
        ...(reply.pronouns && !now.pronouns.trim() ? { pronouns: reply.pronouns } : {}),
        seeded: true,
      });
      const proposals: Proposal[] = [];
      if (state && (force || !now.state.trim())) proposals.push({ change: { holder: objectId, key: STATE_KEY, op: 'set', value: state }, by: 'seed' });
      for (const [key, value] of Object.entries(reply.values)) {
        if (defs.some((d) => d.key === key)) proposals.push({ change: { holder: objectId, key, op: 'set', value }, by: 'seed' });
      }
      if (proposals.length) applyChanges(deps, storyId, proposals, job.turnId ?? null);
      // Ties the story established but the narrator didn't record (docs/11 §2.6): added, never changed.
      const had = new Set((deps.ties?.of(objectId) ?? []).map((t) => t.other));
      for (const [key, label] of Object.entries(reply.ties)) {
        const other = deps.memory.findByHandle(storyId, key.replace(/^#/, ''));
        if (other && other.id !== objectId && !had.has(other.id) && deps.sheets.get(other.id)) setTie(deps, storyId, objectId, other.id, label, job.turnId ?? null);
      }
      const thoughts = reply.thoughts.map((t) => ({ ...t, text: unescapeText(t.text).replace(/\s*\n\s*/g, ' ') })).filter((t) => t.text);
      if (thoughts.length) applyThoughtOps(deps, storyId, objectId, { remember: thoughts }, 'seed', job.turnId ?? null);
    });
    deps.events.emit({ t: 'minds.updated', storyId, objectIds: [objectId] });
  };
}
