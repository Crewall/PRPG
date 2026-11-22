import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import { VariableDef, STATE_KEY, VarOpKind, normalizeAppliesTo, validateDefs } from '../minds/variables.ts';
import type { Viewer } from '../minds/variables.ts';
import { SCENARIO_TEMPLATES } from '../minds/templates.ts';
import { applyChanges, applyThoughtOps, createCharacter, mindsView, updateSheet } from '../minds/service.ts';
import type { MindsDeps } from '../minds/service.ts';
import { wordCount } from '../minds/text.ts';
import { buildCharacterCall, buildNarratorCall, hereFromScene, NARRATOR_OWNER } from '../minds/builders.ts';
import type { ThreadDeps } from '../minds/builders.ts';

// Minds engine data layer API (docs/10 §11, docs/11): scenario variables,
// character sheets, values, the change log and thoughts. `?advanced=1` is the
// advanced-mode view (everything); otherwise the player's normal view.

const APPEARANCE_MAX_WORDS = 40;

export async function registerMindsRoutes(server: FastifyInstance, app: App): Promise<void> {
  const deps: MindsDeps = { stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts };

  const storyOr404 = (id: string, reply: { code(n: number): unknown }) => {
    const story = app.stories.getStory(id);
    if (!story) reply.code(404);
    return story;
  };
  const viewerOf = (storyId: string, query: unknown): Viewer => {
    const advanced = (query as { advanced?: string })?.advanced;
    if (advanced === '1' || advanced === 'true') return { kind: 'advanced' };
    return { kind: 'player', playerId: app.sheets.player(storyId)?.objectId ?? null };
  };
  const isOwner = (storyId: string, owner: string) => owner === 'narrator' || app.sheets.get(owner)?.storyId === storyId;

  server.get('/api/minds/templates', async () => SCENARIO_TEMPLATES);

  // ---- Scenario variable definitions ----

  server.get('/api/stories/:id/variables/defs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    return app.variables.listDefs(id);
  });

  server.put('/api/stories/:id/variables/defs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const body = z.object({ defs: z.array(z.unknown()) }).safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'expected { defs: [...] }' };
    }
    const defs: VariableDef[] = [];
    for (const [i, raw] of body.data.defs.entries()) {
      const parsed = VariableDef.safeParse(raw);
      if (!parsed.success) {
        reply.code(400);
        return { error: `variable ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')}` };
      }
      defs.push({ ...parsed.data, appliesTo: normalizeAppliesTo(parsed.data.appliesTo), order: i });
    }
    try {
      validateDefs(defs);
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
    app.variables.replaceDefs(id, defs);
    return app.variables.listDefs(id);
  });

  // ---- Sheets ----

  server.get('/api/stories/:id/minds', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    return mindsView(deps, id, viewerOf(id, req.query));
  });

  const SheetBody = z.object({
    name: z.string().min(1).optional(),
    isPlayer: z.boolean().optional(),
    description: z.string().optional(),
    appearance: z.string().optional(),
    state: z.string().optional(),
    tierId: z.string().nullable().optional(),
  });
  const checkLengths = (id: string, b: z.infer<typeof SheetBody>): string | undefined => {
    const max = app.stories.getStory(id)!.settings.minds.descriptionMaxWords;
    if (b.description !== undefined && wordCount(b.description) > max) return `the description is over ${max} words`;
    if (b.appearance !== undefined && wordCount(b.appearance) > APPEARANCE_MAX_WORDS) return `the appearance is over ${APPEARANCE_MAX_WORDS} words — keep it to what anyone sees at a glance`;
    return undefined;
  };

  server.post('/api/stories/:id/minds', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const body = SheetBody.extend({ name: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'a character needs a name' };
    }
    const tooLong = checkLengths(id, body.data);
    if (tooLong) {
      reply.code(400);
      return { error: tooLong };
    }
    const sheet = createCharacter(deps, id, { ...body.data, name: body.data.name });
    reply.code(201);
    return { ...sheet, handle: app.memory.getObject(sheet.objectId)?.handle ?? null };
  });

  server.patch('/api/stories/:id/minds/:oid', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    if (app.sheets.get(oid)?.storyId !== id) {
      reply.code(404);
      return { error: 'no such character in this story' };
    }
    const body = SheetBody.safeParse(req.body ?? {});
    if (!body.success) {
      reply.code(400);
      return { error: body.error.issues.map((x) => x.message).join('; ') };
    }
    const tooLong = checkLengths(id, body.data);
    if (tooLong) {
      reply.code(400);
      return { error: tooLong };
    }
    const { state, name, ...patch } = body.data;
    if (name) app.memory.updateObject(oid, { name });
    // State goes through the rules so the change is logged ($state history).
    if (state !== undefined) applyChanges(deps, id, [{ change: { holder: oid, key: STATE_KEY, op: 'set', value: state }, by: 'user' }]);
    return updateSheet(deps, id, oid, patch);
  });

  // ---- Values and the change log ----

  server.patch('/api/stories/:id/variables/values', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const body = z
      .object({ changes: z.array(z.object({ holder: z.string(), key: z.string(), op: VarOpKind.default('set'), value: z.unknown().optional() })) })
      .safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'expected { changes: [{ holder, key, op?, value }] }' };
    }
    const outcomes = applyChanges(
      deps,
      id,
      body.data.changes.map((c) => ({ change: { holder: c.holder, key: c.key, op: c.op, value: c.value }, by: 'user' as const })),
    );
    return outcomes.map((o) => ({ holder: o.proposal.change.holder, key: o.proposal.change.key, result: o.result, old: o.old, new: o.new, reason: o.reason }));
  });

  server.get('/api/stories/:id/variables/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const q = req.query as { holder?: string; limit?: string };
    return app.variables.listChanges(id, { holder: q.holder, limit: q.limit ? Math.min(1000, Number(q.limit)) : undefined });
  });

  // ---- Thoughts (advanced mode) ----

  server.get('/api/stories/:id/thoughts', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const q = req.query as { owner?: string; includeRevoked?: string };
    if (!q.owner || !isOwner(id, q.owner)) {
      reply.code(400);
      return { error: "owner must be 'narrator' or a character of this story" };
    }
    return {
      thoughts: app.thoughts.list(id, q.owner, { includeRevoked: q.includeRevoked === '1' || q.includeRevoked === 'true' }),
      vocabulary: app.thoughts.vocabulary(id, q.owner),
    };
  });

  server.post('/api/stories/:id/thoughts', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const body = z.object({ owner: z.string(), text: z.string().min(1), tags: z.array(z.string()).default([]), pin: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success || !isOwner(id, body.data.owner)) {
      reply.code(400);
      return { error: "expected { owner, text, tags?, pin? } with owner 'narrator' or a character of this story" };
    }
    const { owner, ...op } = body.data;
    const result = applyThoughtOps(deps, id, owner, { remember: [op] }, 'user');
    reply.code(result.added.length ? 201 : 200);
    return result;
  });

  // ---- POV (advanced mode, docs/10 §10) ----

  const threadDeps: ThreadDeps = { ...deps, db: app.db, agents: app.agents, threads: app.threads, verbosityOverride: () => app.settingsService.verbosityOverride() };
  const sessionFor = (storyId: string, oid: string) =>
    app.agents.listSessions(storyId).find((s) => (oid === NARRATOR_OWNER ? s.role === 'narrator' : s.role === 'character' && s.npcObjectId === oid));

  // What one mind has experienced: its thread (recap, log, items waiting for its next round).
  server.get('/api/stories/:id/pov/:oid', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    if (!isOwner(id, oid)) {
      reply.code(404);
      return { error: "not 'narrator' or a character of this story" };
    }
    const session = sessionFor(id, oid);
    if (!session) return { recap: null, log: [], pending: [] };
    const strip = (m: { role: string; content: string; turnId: string | null; createdAt: number }) => ({ role: m.role, content: m.content, turnId: m.turnId, createdAt: m.createdAt });
    return {
      recap: app.threads.recap(session.id)?.content ?? null,
      log: app.threads.log(session.id).map(strip),
      pending: app.threads.pending(session.id).map(strip),
    };
  });

  // The exact prompt: 'next' is built by the same function the round uses; 'last' is what was actually sent.
  server.get('/api/stories/:id/pov/:oid/prompt', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const story = storyOr404(id, reply);
    if (!story) return { error: 'story not found' };
    if (!isOwner(id, oid)) {
      reply.code(404);
      return { error: "not 'narrator' or a character of this story" };
    }
    const which = (req.query as { which?: string }).which === 'last' ? 'last' : 'next';
    if (which === 'last') {
      const session = sessionFor(id, oid);
      const last = session ? app.threadLog.query(id, { limit: 500 }).find((e) => e.sessionId === session.id && e.direction === 'request') : undefined;
      return last ? { which, sentAt: last.createdAt, ...(last.payload as object) } : { which, none: true };
    }
    const scene = story.currentSceneId ? app.stories.getScene(story.currentSceneId) : undefined;
    const call =
      oid === NARRATOR_OWNER
        ? buildNarratorCall(threadDeps, { storyId: id, player: {}, presentIds: scene?.activeNpcIds ?? [], declarations: [] })
        : buildCharacterCall(threadDeps, { storyId: id, objectId: oid, here: hereFromScene(threadDeps, id, oid) });
    return { which, system: call.ctx.system, messages: call.ctx.messages };
  });

  server.patch('/api/thoughts/:tid', async (req, reply) => {
    const { tid } = req.params as { tid: string };
    const t = app.thoughts.get(tid);
    if (!t) {
      reply.code(404);
      return { error: 'thought not found' };
    }
    const body = z.object({ revoked: z.literal(true).optional(), pinned: z.boolean().optional() }).parse(req.body ?? {});
    if (body.revoked && t.status === 'active') app.thoughts.revoke(tid, null);
    if (body.pinned !== undefined) app.thoughts.setPinned(tid, body.pinned);
    return app.thoughts.get(tid);
  });
}
