import type { Job } from '../db/stores/jobStore.ts';
import type { JobHandler } from '../orchestrator/postTurn.ts';
import { MindAgent } from '../agents/mindAgent.ts';
import { renderPrompt } from '../agents/prompts.ts';
import { renderRecentStory } from '../orchestrator/handlers.ts';
import { applyChanges, applyThoughtOps, holdersFor } from './service.ts';
import { STATE_KEY, appliesTo, renderRange } from './variables.ts';
import type { Proposal } from './variables.ts';
import type { RoundDeps } from './round.ts';

// minds_seed (docs/11 §2.3): give a character the narrator just introduced a
// mind — description, state, starting values and 3–10 thoughts — parsing the
// story first and inventing second. Never overwrites what the user wrote.

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
    const bound = deps.registry.getForRole('seeder', story.settings.roles.seeder);
    const session = deps.agents.ensureSession(storyId, 'seeder', bound.name, objectId);
    const user = [
      `The premise: ${story.settings.premise.trim() || '(none given)'}`,
      `How ${obj.name} was introduced: ${sheet.appearance || '(no description yet)'}`,
      `The story so far (most recent last):\n${renderRecentStory(deps.stories, storyId) || '(nothing yet)'}`,
      `Variables ${obj.name} holds:\n${defs.map((d) => `- ${d.key} (${renderRange(d)}): ${d.description || d.label}`).join('\n') || '(none)'}`,
      `Create the mind for ${obj.name}. Reply as JSON.`,
    ].join('\n\n');
    const reply = await new MindAgent({ session, bound, threadLog: deps.threadLog, storyId }).seed(
      { system: renderPrompt('minds-seed', { name: obj.name, handle: `#${handle}` }), messages: [{ role: 'user', content: user }] },
      { maxTokens: 1500 },
    );

    const now = deps.sheets.get(objectId);
    if (!now || !deps.memory.getObject(objectId)) return; // removed while generating
    deps.db.transaction(() => {
      deps.sheets.upsert(storyId, objectId, {
        ...(reply.description && (force || !now.description.trim()) ? { description: reply.description } : {}),
        ...(reply.appearance && !now.appearance.trim() ? { appearance: reply.appearance } : {}),
        ...(reply.pronouns && !now.pronouns.trim() ? { pronouns: reply.pronouns } : {}),
        seeded: true,
      });
      const proposals: Proposal[] = [];
      if (reply.state && (force || !now.state.trim())) proposals.push({ change: { holder: objectId, key: STATE_KEY, op: 'set', value: reply.state }, by: 'seed' });
      for (const [key, value] of Object.entries(reply.values)) {
        if (defs.some((d) => d.key === key)) proposals.push({ change: { holder: objectId, key, op: 'set', value }, by: 'seed' });
      }
      if (proposals.length) applyChanges(deps, storyId, proposals, job.turnId ?? null);
      if (reply.thoughts.length) applyThoughtOps(deps, storyId, objectId, { remember: reply.thoughts }, 'seed', job.turnId ?? null);
    });
    deps.events.emit({ t: 'minds.updated', storyId, objectIds: [objectId] });
  };
}
