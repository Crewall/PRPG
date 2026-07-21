import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import { StorySettings, DEFAULT_TONE } from '../domain.ts';
import { VERBOSITY_STYLE } from '../orchestrator/contextBuilder.ts';
import { NewMemoryObject, NewFact, DetailLevel, FactTier } from '../memory/model.ts';
import { findNearDuplicate } from '../memory/similarity.ts';
import type { KnowledgeScope } from '../memory/model.ts';
import { promoteNpc, demoteNpc, enterOrCreateNpc, rebuildNpcMind } from '../orchestrator/npc.ts';
import { mergeMemoryObjects, enqueueMemoryRescan } from '../orchestrator/memoryHandlers.ts';
import { runPlayerInterview } from '../orchestrator/playerIntake.ts';
import { EDITABLE_PROMPTS } from '../config/settingsService.ts';
import { defaultPrompt, renderPrompt } from '../agents/prompts.ts';
import { callJson } from '../llm/jsonCall.ts';
import { rollSeeds, parseSeeds, defaultSeedsText } from '../util/seeds.ts';
import { anthropicDriver } from '../llm/anthropicDriver.ts';
import { openaiDriver } from '../llm/openaiDriver.ts';

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

  // Premise randomizer: the ENGINE rolls N (1–12) seed elements (true random),
  // a storyteller-caliber model weaves them into a premise + genre + title. A
  // filled-in title and/or genre is kept fixed and fed to the model as a
  // constraint the premise must respect.
  const RandomStory = z.object({ title: z.string(), genre: z.string(), premise: z.string() });
  const RandomBody = z.object({
    count: z.number().int().min(1).max(12).optional(),
    title: z.string().optional(),
    genre: z.string().optional(),
  });
  server.post('/api/stories/randomize', async (req, reply) => {
    try {
      const body = RandomBody.parse(req.body ?? {});
      const n = body.count ?? 5;
      const override = app.settingsService.seedsOverride();
      const seeds = rollSeeds(n, override ? { seeds: parseSeeds(override) } : {});
      const fixedTitle = body.title?.trim();
      const fixedGenre = body.genre?.trim();
      const fixed = [
        fixedTitle ? `Fixed title (keep exactly): ${fixedTitle}` : '',
        fixedGenre ? `Fixed genre (keep exactly): ${fixedGenre}` : '',
      ].filter(Boolean);
      const bound = registry.getForRole('storyteller');
      const result = await callJson(
        bound,
        {
          system: renderPrompt('story-randomizer', { count: String(n) }),
          messages: [
            {
              role: 'user',
              content:
                `The ${n} rolled seed element${n === 1 ? '' : 's'}:\n${seeds.map((s) => `- ${s}`).join('\n')}` +
                (fixed.length ? `\n\n${fixed.join('\n')}` : ''),
            },
          ],
        },
        RandomStory,
      );
      // Honor the fixed fields verbatim regardless of what the model echoed.
      return { seeds, title: fixedTitle || result.title, genre: fixedGenre || result.genre, premise: result.premise };
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  server.post('/api/stories', async (req, reply) => {
    const body = CreateStoryBody.parse(req.body);
    // New stories inherit the global default tone (Settings → Storyteller style)
    // unless one was passed explicitly.
    const toneDefault = app.settingsService.toneDefault();
    const merged = { ...(body.settings ?? {}), premise: body.seed || body.settings?.premise || '' };
    if (!merged.tone && toneDefault) merged.tone = toneDefault;
    const settings = StorySettings.parse(merged);
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

  // Feature 1: delete the latest exchange (halting any in-flight generation)
  // and restore the pre-message state; returns the prompt for editing.
  server.post('/api/stories/:id/rewind', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await pipeline.rewind(id);
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Edit any past message: rewrite a turn's player input and/or narration text
  // (the transcript ✎ control). Memory is left as-is; if both sides end up
  // empty the turn is dropped entirely (same as deleting the message).
  server.patch('/api/stories/:id/turns/:turnId', async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const body = z.object({ playerInput: z.string().optional(), narration: z.string().optional() }).parse(req.body ?? {});
    const turn = stories.getTurn(turnId);
    if (!turn || turn.storyId !== id) {
      reply.code(404);
      return { error: 'turn not found' };
    }
    const updated = stories.setTurnText(turnId, body)!;
    if (!updated.playerInput.trim() && !updated.narration.trim()) {
      stories.deleteTurn(turnId);
      app.agents.deleteMessagesForTurn(turnId);
      return { ok: true, deleted: true };
    }
    return { ok: true, turn: updated };
  });

  // Delete any past message/exchange: drop the turn and its transcript
  // messages. Memory is untouched (accepted staleness).
  server.delete('/api/stories/:id/turns/:turnId', async (req, reply) => {
    const { id, turnId } = req.params as { id: string; turnId: string };
    const turn = stories.getTurn(turnId);
    if (!turn || turn.storyId !== id) {
      reply.code(404);
      return { error: 'turn not found' };
    }
    stories.deleteTurn(turnId);
    app.agents.deleteMessagesForTurn(turnId);
    return { ok: true, deleted: true };
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
    const q = req.query as { scope?: string; npcObjectId?: string; categories?: string; maxFacts?: string };
    const obj = memory.getObject(oid);
    if (!obj) {
      reply.code(404);
      return { error: 'not found' };
    }
    const scope = resolveScope(obj.storyId, q.scope, q.npcObjectId);
    const categories = q.categories ? q.categories.split(',') : undefined;
    const maxFacts = q.maxFacts ? Math.min(1000, Number(q.maxFacts) || 0) || undefined : undefined;
    return memory.getObjectView(oid, scope, { categories, maxFacts });
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
    // Deleting a character that is in the current scene would leave a stale
    // roster id behind (and a dangling NPC session) — demote it first.
    const obj = memory.getObject(oid);
    if (obj) demoteNpc(npcDeps, obj.storyId, oid);
    memory.deleteObject(oid);
    return { ok: true };
  });

  // Feature: merge another object INTO :oid (duplicate entities — "the woman"
  // and "Kate"). Lossless: facts, knowledge links, scene rosters, NPC sessions
  // and aliases all follow; the merged object is deleted.
  const handlerDeps = { db: app.db, stories, summaries, agents: app.agents, threadLog, memory, npcProfiles: app.npcProfiles, suggestions, jobs, registry, events: app.events };
  server.post('/api/memory/objects/:oid/merge', async (req, reply) => {
    const { oid } = req.params as { oid: string };
    const { mergeId } = z.object({ mergeId: z.string().min(1) }).parse(req.body);
    if (!mergeMemoryObjects(handlerDeps, oid, mergeId)) {
      reply.code(400);
      return { error: 'cannot merge — objects must both exist and belong to the same story' };
    }
    return { ok: true, keep: memory.getObject(oid) };
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
    // Feature 6: something (very) similar already recorded → return it instead.
    const dup = findNearDuplicate(memory.listFacts(oid), body.content);
    if (dup) return { ...dup, duplicate: true };
    reply.code(201);
    return memory.addFact({ ...body, objectId: oid });
  });

  server.patch('/api/memory/facts/:fid', async (req, reply) => {
    const { fid } = req.params as { fid: string };
    const body = z
      .object({ category: z.string().optional(), subcategory: z.string().optional(), detailLevel: DetailLevel.optional(), tier: FactTier.optional(), content: z.string().optional(), confidence: z.number().optional(), superseded: z.boolean().optional() })
      .parse(req.body);
    const updated = memory.updateFact(fid, body);
    if (!updated) {
      reply.code(404);
      return { error: 'not found' };
    }
    return updated;
  });

  // Default: soft-delete (mark superseded, keeps history). ?hard=true removes it.
  server.delete('/api/memory/facts/:fid', async (req) => {
    const { fid } = req.params as { fid: string };
    const hard = (req.query as { hard?: string }).hard === 'true';
    const fact = memory.getFact(fid);
    if (fact) {
      if (hard) memory.deleteFact(fid);
      else memory.updateFact(fid, { superseded: true });
    }
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

  // Manual memory cleanup: run the maintenance job (unify duplicate entities,
  // consolidate facts, decay salience) now instead of waiting for the cadence.
  server.post('/api/stories/:id/memory/maintenance', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!stories.getStory(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    const job = jobs.enqueue('memory_maintenance', { storyId: id, payload: {} });
    return { ok: true, jobId: job.id };
  });

  // Manual re-scan (the "re-scan turns" button): re-run the memory scribe
  // over the last few exchanges when a pass missed something. Safe to repeat —
  // near-duplicate facts are filtered on apply.
  server.post('/api/stories/:id/memory/rescan', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!stories.getStory(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    const body = z.object({ turns: z.number().int().min(1).max(20).default(5) }).parse(req.body ?? {});
    const enqueued = enqueueMemoryRescan({ stories, jobs }, id, body.turns);
    return { ok: true, enqueued };
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
      // Lossless merge: facts, knowledge links, scene rosters, sessions, aliases.
      mergeMemoryObjects(handlerDeps, sug.keepId, sug.mergeId);
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

  // ---- Layer 4: NPC agents (promote/demote, session list) ----
  const npcDeps = { stories, agents: app.agents, memory, npcProfiles: app.npcProfiles, jobs, registry, events: app.events };

  server.get('/api/stories/:id/agents', async (req) => {
    const { id } = req.params as { id: string };
    return app.agents.listSessions(id).map((s) => ({
      ...s,
      messageCount: app.agents.countMessages(s.id),
      npc: s.npcObjectId ? memory.getObject(s.npcObjectId)?.name : undefined,
    }));
  });

  // What this NPC knows about the world — the RECORDED knowledge links
  // (fact ↔ knower, with distortions), not an on-the-fly guess. Debug-gated:
  // an NPC's knowledge includes secrets the player must not see.
  server.get('/api/stories/:id/npcs/:oid/knowledge', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    const story = stories.getStory(id);
    if (!story || !memory.getObject(oid)) {
      reply.code(404);
      return { error: 'not found' };
    }
    if (!story.settings.debug.showThreads) {
      return { available: false, reason: 'enable Debug to inspect NPC knowledge (it can include secrets)' };
    }
    const world = memory
      .npcKnowledge(id, oid)
      .map((k) => ({
        objectId: k.objectId,
        objectName: k.objectName,
        category: k.fact.category,
        detailLevel: k.fact.detailLevel,
        tier: k.fact.tier,
        content: k.content,
        distorted: k.content !== k.fact.content, // they believe a distortion
      }));
    return { available: true, world };
  });

  // Player-dossier interview: 1–3 rounds of Q&A on its own AI thread, ending
  // in the player character being created in memory.
  server.post('/api/stories/:id/player/interview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ exchanges: z.array(z.object({ question: z.string(), answer: z.string() })).max(6).default([]) })
      .parse(req.body ?? {});
    if (!stories.getStory(id)) {
      reply.code(404);
      return { error: 'not found' };
    }
    // Abort the (potentially slow) model call if the client actually
    // disconnects. We watch the RESPONSE stream, not the request: Node emits the
    // request stream's 'close' as soon as the POST body is read (instantly for a
    // small JSON), which would abort every interview on the spot. The response
    // stream's 'close' only fires early — before it finished writing — on a real
    // client disconnect.
    const ac = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) ac.abort(new Error('client cancelled the interview'));
    });
    try {
      const deps = { db: app.db, stories, summaries, agents: app.agents, threadLog, memory, npcProfiles: app.npcProfiles, suggestions, jobs, registry, events: app.events };
      return await runPlayerInterview(deps, id, body.exchanges, { signal: ac.signal });
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  server.post('/api/stories/:id/npcs/:oid/promote', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    if (!promoteNpc(npcDeps, id, oid)) {
      reply.code(404);
      return { error: 'character not found' };
    }
    return { ok: true };
  });

  server.post('/api/stories/:id/npcs/:oid/demote', async (req) => {
    const { id, oid } = req.params as { id: string; oid: string };
    demoteNpc(npcDeps, id, oid);
    return { ok: true };
  });

  // Manual "rebuild from story" (the dossier's ⟳ control): re-run the
  // mode-appropriate mind-builder for one character, focused parse-first.
  server.post('/api/stories/:id/npcs/:oid/rebuild', async (req, reply) => {
    const { id, oid } = req.params as { id: string; oid: string };
    if (!rebuildNpcMind(npcDeps, id, oid)) {
      reply.code(404);
      return { error: 'character not found' };
    }
    return { ok: true };
  });

  // Manual "add major character" by name (the Present bar's + control):
  // resolves an existing character or creates one, then promotes — no trip
  // through the memory browser needed (which NPC Story Mode leaves idle).
  server.post('/api/stories/:id/npcs/enter', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const obj = enterOrCreateNpc(npcDeps, id, body.name);
    if (!obj) {
      reply.code(400);
      return { error: 'could not add the character — does the story exist?' };
    }
    return { ok: true, object: obj };
  });

  // ---- NPC Story Mode: narrative profiles (docs/09). The player's window
  // into — and repair tool for — each NPC's head. ----

  server.get('/api/stories/:id/npc-profiles', async (req) => {
    const { id } = req.params as { id: string };
    return app.npcProfiles.listForStory(id).map((p) => ({
      ...p,
      name: app.memory.getObject(p.objectId)?.name ?? '(unknown)',
    }));
  });

  server.put('/api/npc-profiles/:oid', async (req, reply) => {
    const { oid } = req.params as { oid: string };
    const body = z.object({ personality: z.string().optional(), notes: z.string().optional() }).parse(req.body);
    const obj = app.memory.getObject(oid);
    if (!obj) {
      reply.code(404);
      return { error: 'character not found' };
    }
    const updated = app.npcProfiles.upsert(obj.storyId, oid, body);
    // The player is the game master of their own game — manual mind edits are
    // journaled like manual memory edits, so the debug thread view shows them.
    threadLog.log({
      storyId: obj.storyId,
      agentRole: 'user',
      direction: 'request',
      payload: { action: 'npc-profile-edit', objectId: oid, ...body },
    });
    app.events.emit({ t: 'npc.profile.updated', storyId: obj.storyId, objectIds: [oid] });
    return { ...updated, name: obj.name };
  });

  server.get('/api/system/settings', async () => app.settings.all());

  // ---- Settings: providers/keys, favourites, per-role models & params, prompts ----
  const svc = app.settingsService;

  server.get('/api/settings/config', async () => svc.publicView());

  const SaveConfigBody = z.object({
    providers: z
      .object({
        anthropic: z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() }).optional(),
        openai_compat: z.object({ apiKey: z.string().optional(), baseUrl: z.string().optional() }).optional(),
      })
      .optional(),
    favourites: z.array(z.object({ id: z.string(), label: z.string(), provider: z.enum(['anthropic', 'openai_compat']), model: z.string() })).optional(),
    roles: z.record(z.string(), z.object({ favouriteId: z.string(), temperature: z.number(), maxTokens: z.number().int() })).optional(),
    performance: z
      .object({
        jobConcurrency: z.number().int().min(1).max(16).optional(),
        requestTimeoutMs: z.number().int().min(10_000).max(600_000).optional(),
      })
      .optional(),
  });

  server.put('/api/settings/config', async (req, reply) => {
    const body = SaveConfigBody.parse(req.body);
    try {
      svc.update(body as never);
      return svc.publicView();
    } catch (err) {
      reply.code(400);
      return { error: (err as Error).message };
    }
  });

  // Test a provider key with a tiny live completion. Accepts an ad-hoc apiKey/
  // baseUrl to test a key before saving; otherwise uses the saved provider.
  const TestBody = z.object({
    provider: z.enum(['anthropic', 'openai_compat']),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
  });
  server.post('/api/settings/test', async (req) => {
    const body = TestBody.parse(req.body);
    const rt = svc.get();
    const saved = rt.providers[body.provider];
    const apiKey = body.apiKey?.trim() || saved?.apiKey;
    const baseUrl = body.baseUrl?.trim() || saved?.baseUrl || undefined;
    if (!apiKey) return { ok: false, error: 'no API key set for this provider' };
    const model = body.model || rt.favourites.find((f) => f.provider === body.provider)?.model;
    if (!model) return { ok: false, error: 'no model to test — add a favourite for this provider first' };

    const driver =
      body.provider === 'anthropic'
        ? anthropicDriver({ apiKey, baseUrl: baseUrl || 'https://api.anthropic.com', timeoutMs: 30_000 })
        : openaiDriver({ apiKey, baseUrl: baseUrl || 'https://api.openai.com/v1', timeoutMs: 30_000 });
    const t0 = Date.now();
    try {
      const res = await driver.chat({ model, system: 'Connectivity test.', messages: [{ role: 'user', content: 'Reply with the single word: OK' }], maxTokens: 5, temperature: 0 });
      return { ok: true, latencyMs: Date.now() - t0, model, sample: res.text.trim().slice(0, 40) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, model, error: (err as Error).message };
    }
  });

  // Rate-limit / credits check (OpenRouter-style `GET {baseUrl}/key`).
  // Anthropic has no equivalent endpoint, so this is openai_compat only.
  server.get('/api/settings/limits/:provider', async (req) => {
    const { provider } = req.params as { provider: string };
    if (provider !== 'openai_compat') {
      return { supported: false, error: 'Limit check is only available for the OpenAI-compatible provider (OpenRouter).' };
    }
    const saved = svc.get().providers.openai_compat;
    if (!saved?.apiKey) return { supported: true, ok: false, error: 'no API key saved for this provider' };
    const base = (saved.baseUrl?.trim() || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/key`, {
        headers: { authorization: `Bearer ${saved.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { supported: true, ok: false, error: `HTTP ${res.status} from ${base}/key` };
      const json = (await res.json()) as { data?: Record<string, unknown> };
      return { supported: true, ok: true, key: json.data ?? json };
    } catch (err) {
      return { supported: true, ok: false, error: (err as Error).message };
    }
  });

  // Prompts (editable per role).
  server.get('/api/settings/prompts', async () =>
    EDITABLE_PROMPTS.map((p) => ({ ...p, overridden: svc.get().prompts[p.name] !== undefined })),
  );

  server.get('/api/settings/prompts/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!EDITABLE_PROMPTS.some((p) => p.name === name)) {
      reply.code(404);
      return { error: 'unknown prompt' };
    }
    const override = svc.get().prompts[name];
    return { name, content: override ?? defaultPrompt(name), default: defaultPrompt(name), overridden: override !== undefined };
  });

  server.put('/api/settings/prompts/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!EDITABLE_PROMPTS.some((p) => p.name === name)) {
      reply.code(404);
      return { error: 'unknown prompt' };
    }
    const { content } = z.object({ content: z.string() }).parse(req.body);
    svc.update({ prompts: { ...svc.get().prompts, [name]: content } });
    return { ok: true };
  });

  server.delete('/api/settings/prompts/:name', async (req) => {
    const { name } = req.params as { name: string };
    const prompts = { ...svc.get().prompts };
    delete prompts[name];
    svc.update({ prompts });
    return { ok: true };
  });

  // Story-beginning randomizer: the editable seed phrases (one per line). The
  // shipped src/data/story-seeds.txt is the default; an override lives in
  // settings so it's editable in-app (no file hunting on Termux).
  server.get('/api/settings/seeds', async () => {
    const def = defaultSeedsText();
    const override = svc.get().seeds;
    const overridden = !!(override && override.trim());
    return { content: overridden ? override : def, default: def, overridden, count: parseSeeds(overridden ? override : def).length };
  });

  server.put('/api/settings/seeds', async (req, reply) => {
    const { content } = z.object({ content: z.string() }).parse(req.body);
    // Blank (or identical to the shipped default) clears the override.
    const seeds = content.trim() && content !== defaultSeedsText() ? content : '';
    if (content.trim() && parseSeeds(content).length === 0) {
      reply.code(400);
      return { error: 'need at least one seed phrase' };
    }
    svc.update({ seeds });
    return { ok: true, count: parseSeeds(seeds || defaultSeedsText()).length };
  });

  // Storyteller style: the burned-in prompt insertions behind {{verbosity}} and
  // {{tone}}. Exposes the built-in defaults plus any override so they can be
  // viewed and edited (Settings → Storyteller style).
  const STEPS = ['1', '2', '3', '4', '5'];
  server.get('/api/settings/style', async () => {
    const vOverride = svc.get().verbosity ?? {};
    const verbosity = Object.fromEntries(STEPS.map((s) => [s, (vOverride[s] ?? '').trim() || VERBOSITY_STYLE[Number(s)]]));
    const verbosityDefault = Object.fromEntries(STEPS.map((s) => [s, VERBOSITY_STYLE[Number(s)]]));
    const overriddenSteps = STEPS.filter((s) => (vOverride[s] ?? '').trim() && vOverride[s].trim() !== VERBOSITY_STYLE[Number(s)]);
    return {
      verbosity,
      verbosityDefault,
      verbosityOverridden: overriddenSteps.length > 0,
      tone: svc.toneDefault() ?? DEFAULT_TONE,
      toneDefault: DEFAULT_TONE,
      toneOverridden: !!svc.toneDefault(),
    };
  });

  server.put('/api/settings/style', async (req) => {
    const body = z
      .object({ verbosity: z.record(z.string(), z.string()).optional(), tone: z.string().optional() })
      .parse(req.body ?? {});
    const patch: { verbosity?: Record<string, string>; tone?: string } = {};
    if (body.verbosity) {
      // Store only the steps that actually differ from the built-in default.
      patch.verbosity = Object.fromEntries(
        STEPS.map((s) => [s, (body.verbosity![s] ?? '').trim()]).filter(([s, v]) => v && v !== VERBOSITY_STYLE[Number(s)]),
      );
    }
    if (body.tone !== undefined) patch.tone = body.tone.trim() === DEFAULT_TONE ? '' : body.tone.trim();
    svc.update(patch);
    return { ok: true };
  });
}
