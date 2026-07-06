import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import { StorySettings } from '../domain.ts';
import { NewMemoryObject, NewFact, DetailLevel } from '../memory/model.ts';
import type { KnowledgeScope } from '../memory/model.ts';

const CreateStoryBody = z.object({
  title: z.string().min(1).default('Untitled Story'),
  seed: z.string().default(''),
  settings: StorySettings.partial().optional(),
});

const PatchStoryBody = z.object({
  title: z.string().min(1).optional(),
  settings: StorySettings.partial().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

// Register REST routes under /api. Layer 1: stories CRUD + turns page + a couple
// of system/debug reads. Memory/rules/agents endpoints arrive in later layers.
export async function registerHttpRoutes(server: FastifyInstance, app: App): Promise<void> {
  const { stories, threadLog, registry, config } = app;

  server.get('/api/system/health', async () => ({
    ok: true,
    version: '0.1.0',
    providers: Object.keys(config.providers),
    profiles: registry.listProfiles(),
  }));

  server.get('/api/system/models', async () => ({
    profiles: Object.entries(config.modelProfiles).map(([name, p]) => ({ name, provider: p.provider, model: p.model })),
    roles: config.roles,
  }));

  server.post('/api/stories', async (req, reply) => {
    const body = CreateStoryBody.parse(req.body);
    const settings = StorySettings.parse({ ...(body.settings ?? {}), premise: body.seed || body.settings?.premise || '' });
    const story = stories.createStory({ title: body.title, settings });
    reply.code(201);
    return story;
  });

  server.get('/api/stories', async () => stories.listStories());

  server.get('/api/stories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = stories.getStory(id);
    if (!story) {
      reply.code(404);
      return { error: 'not found' };
    }
    const scene = story.currentSceneId ? stories.getScene(story.currentSceneId) : null;
    return { ...story, scene };
  });

  server.patch('/api/stories/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = PatchStoryBody.parse(req.body);
    const updated = stories.updateStory(id, body);
    if (!updated) {
      reply.code(404);
      return { error: 'not found' };
    }
    return updated;
  });

  server.delete('/api/stories/:id', async (req) => {
    const { id } = req.params as { id: string };
    const hard = (req.query as { hard?: string }).hard === 'true';
    stories.deleteStory(id, hard);
    return { ok: true };
  });

  server.get('/api/stories/:id/turns', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { from?: string; limit?: string };
    return stories.listTurns(id, {
      fromIndex: q.from ? Number(q.from) : 0,
      limit: q.limit ? Number(q.limit) : 200,
    });
  });

  // Debug: thread log for a story (the "hidden threads visible" requirement).
  server.get('/api/stories/:id/threadlog', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { turnId?: string; role?: string; limit?: string };
    return threadLog.query(id, { turnId: q.turnId, role: q.role, limit: q.limit ? Number(q.limit) : 200 });
  });

  // ---- Layer 2: scenes & summaries ----
  const { pipeline, summaries, jobs, memory, suggestions } = app;

  server.post('/api/stories/:id/scenes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: string };
    if (!stories.getStory(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    pipeline.newScene(id, { title: body.title });
    const story = stories.getStory(id)!;
    return { ok: true, scene: story.currentSceneId ? stories.getScene(story.currentSceneId) : null };
  });

  server.get('/api/stories/:id/summaries', async (req) => {
    const { id } = req.params as { id: string };
    return summaries.listForStory(id);
  });

  server.post('/api/stories/:id/jobs/:jobId/retry', async (req) => {
    const { jobId } = req.params as { jobId: string };
    jobs.retry(jobId);
    return { ok: true };
  });

  server.get('/api/stories/:id/jobs/failed', async (req) => {
    const { id } = req.params as { id: string };
    return jobs.listFailed(id);
  });

  // ---- Layer 3: memory ----
  // Resolve a KnowledgeScope from query params; 'storyteller' requires debug mode.
  function resolveScope(storyId: string, scopeParam?: string, npcObjectId?: string): KnowledgeScope {
    const story = stories.getStory(storyId);
    const debug = !!story?.settings.debug.showThreads;
    if (scopeParam === 'storyteller') return debug ? { kind: 'storyteller' } : { kind: 'player' };
    if (scopeParam === 'perception') return { kind: 'perception' };
    if (scopeParam === 'npc' && npcObjectId) return { kind: 'npc', npcObjectId };
    return { kind: 'player' };
  }

  server.get('/api/stories/:id/memory/objects', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { type?: string; query?: string; scope?: string };
    let objects = memory.listObjects(id, { type: q.type });
    if (q.query) {
      const needle = q.query.toLowerCase();
      objects = objects.filter((o) => o.name.toLowerCase().includes(needle) || o.aliases.some((a) => a.toLowerCase().includes(needle)));
    }
    const scope = resolveScope(id, q.scope);
    // Return list with a scoped view (so the player list respects disclosure).
    return objects.map((o) => ({ object: o, view: memory.getObjectView(o.id, scope) }));
  });

  server.get('/api/memory/objects/:oid', async (req, reply) => {
    const { oid } = req.params as { oid: string };
    const q = req.query as { scope?: string; npcObjectId?: string; categories?: string };
    const obj = memory.getObject(oid);
    if (!obj) {
      reply.code(404);
      return { error: 'not found' };
    }
    const scope = resolveScope(obj.storyId, q.scope, q.npcObjectId);
    const categories = q.categories ? q.categories.split(',') : undefined;
    return memory.getObjectView(oid, scope, { categories });
  });

  server.post('/api/stories/:id/memory/objects', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = NewMemoryObject.omit({ storyId: true }).parse(req.body);
    const obj = memory.createObject({ ...body, storyId: id });
    reply.code(201);
    return obj;
  });

  server.patch('/api/memory/objects/:oid', async (req, reply) => {
    const { oid } = req.params as { oid: string };
    const body = z
      .object({ name: z.string().optional(), aliases: z.array(z.string()).optional(), summary: z.string().optional(), salience: z.number().optional(), status: z.string().optional() })
      .parse(req.body);
    const updated = memory.updateObject(oid, body as never);
    if (!updated) {
      reply.code(404);
      return { error: 'not found' };
    }
    return updated;
  });

  server.delete('/api/memory/objects/:oid', async (req) => {
    const { oid } = req.params as { oid: string };
    memory.deleteObject(oid);
    return { ok: true };
  });

  server.get('/api/memory/objects/:oid/facts', async (req) => {
    const { oid } = req.params as { oid: string };
    const q = req.query as { includeSuperseded?: string };
    return memory.listFacts(oid, { includeSuperseded: q.includeSuperseded === 'true' });
  });

  server.post('/api/memory/objects/:oid/facts', async (req, reply) => {
    const { oid } = req.params as { oid: string };
    const body = NewFact.omit({ objectId: true }).parse(req.body);
    if (!memory.getObject(oid)) {
      reply.code(404);
      return { error: 'object not found' };
    }
    reply.code(201);
    return memory.addFact({ ...body, objectId: oid });
  });

  server.patch('/api/memory/facts/:fid', async (req, reply) => {
    const { fid } = req.params as { fid: string };
    const body = z
      .object({ category: z.string().optional(), subcategory: z.string().optional(), detailLevel: DetailLevel.optional(), content: z.string().optional(), confidence: z.number().optional(), superseded: z.boolean().optional() })
      .parse(req.body);
    const updated = memory.updateFact(fid, body);
    if (!updated) {
      reply.code(404);
      return { error: 'not found' };
    }
    return updated;
  });

  server.delete('/api/memory/facts/:fid', async (req) => {
    const { fid } = req.params as { fid: string };
    const fact = memory.getFact(fid);
    if (fact) memory.updateFact(fid, { superseded: true });
    return { ok: true };
  });

  // Grant/revoke a knower link (and optional distortion) for a fact.
  server.post('/api/memory/facts/:fid/knowledge', async (req, reply) => {
    const { fid } = req.params as { fid: string };
    const body = z
      .object({ action: z.enum(['grant', 'revoke']).default('grant'), knowerType: z.enum(['player', 'npc']), npcObjectId: z.string().optional(), distortion: z.string().optional() })
      .parse(req.body);
    if (!memory.getFact(fid)) {
      reply.code(404);
      return { error: 'fact not found' };
    }
    const knower = { type: body.knowerType, npcObjectId: body.npcObjectId };
    if (body.action === 'revoke') {
      memory.unlinkKnowledge(fid, knower);
      return { ok: true };
    }
    return memory.linkKnowledge(fid, knower, { distortion: body.distortion });
  });

  // ---- Layer 3b: suggestion inbox ----
  server.get('/api/stories/:id/memory/suggestions', async (req) => {
    const { id } = req.params as { id: string };
    return suggestions.listPending(id);
  });

  server.post('/api/memory/suggestions/:sid', async (req, reply) => {
    const { sid } = req.params as { sid: string };
    const body = z.object({ action: z.enum(['accept', 'reject']) }).parse(req.body);
    const sug = suggestions.get(sid);
    if (!sug) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (body.action === 'accept' && sug.type === 'merge' && sug.keepId && sug.mergeId) {
      // Fold merge target's facts into keep, then delete the merged object.
      const keep = memory.getObject(sug.keepId);
      const merge = memory.getObject(sug.mergeId);
      if (keep && merge) {
        for (const f of memory.listFacts(merge.id, { includeSuperseded: true })) {
          memory.addFact({ objectId: keep.id, category: f.category, subcategory: f.subcategory ?? undefined, detailLevel: f.detailLevel, content: f.content, confidence: f.confidence });
        }
        memory.updateObject(keep.id, { aliases: Array.from(new Set([...keep.aliases, merge.name, ...merge.aliases])) });
        memory.deleteObject(merge.id);
      }
    }
    suggestions.setStatus(sid, body.action === 'accept' ? 'accepted' : 'rejected');
    return { ok: true };
  });

  // ---- Layer 3c: /look — perception scope (only `visible` facts) ----
  server.get('/api/stories/:id/look', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string };
    if (!q.name) {
      reply.code(400);
      return { error: 'name required' };
    }
    const obj = memory.findByName(id, q.name);
    if (!obj) {
      reply.code(404);
      return { error: `You see nothing here called "${q.name}".` };
    }
    return memory.getObjectView(obj.id, { kind: 'perception' });
  });

  server.get('/api/system/settings', async () => app.settings.all());
}
