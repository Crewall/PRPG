import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import { VariableDef, STATE_KEY, VarOpKind, normalizeAppliesTo, relationParts, validateDefs } from '../minds/variables.ts';
import type { Viewer } from '../minds/variables.ts';
import { SCENARIO_TEMPLATES } from '../minds/templates.ts';
import { applyChanges, applyThoughtOps, createCharacter, editThought, mindsView, thoughtLens, updateSheet } from '../minds/service.ts';
import { HOPES, HORIZONS, THOUGHT_KINDS, fades } from '../minds/thoughts.ts';
import type { MindsDeps } from '../minds/service.ts';
import { wordCount } from '../minds/text.ts';
import { AWARENESS, awarenessNote } from '../minds/presence.ts';
import { setTie } from '../minds/ties.ts';
import { buildCharacterCall, buildNarratorCall, characterVariableLines, hereFromScene, narratorVariableLines, queueForCharacter, queueForNarrator, tellOfHandEdit, NARRATOR_OWNER } from '../minds/builders.ts';
import type { ThreadDeps } from '../minds/builders.ts';

// Minds engine data layer API (docs/10 §11, docs/11): scenario variables,
// character sheets, values, the change log and thoughts. `?advanced=1` is the
// advanced-mode view (everything); otherwise the player's normal view.

const APPEARANCE_MAX_WORDS = 40;
const CONCEPT_MAX_WORDS = 80;

export async function registerMindsRoutes(server: FastifyInstance, app: App): Promise<void> {
  const deps: MindsDeps = { stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts, names: app.names, ties: app.ties, met: app.met };

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
  /** Apply a ties map from the sheet editor: keys are object ids or #handles of characters in this story. */
  const setTies = (storyId: string, holder: string, ties: Record<string, string>) => {
    for (const [key, label] of Object.entries(ties)) {
      const other = app.sheets.get(key)?.storyId === storyId ? key : app.memory.findByHandle(storyId, key.replace(/^#/, ''))?.id;
      if (other && other !== holder && app.sheets.get(other)) setTie(deps, storyId, holder, other, label, null);
    }
  };
  const isOwner = (storyId: string, owner: string) => owner === 'narrator' || app.sheets.get(owner)?.storyId === storyId;

  server.get('/api/minds/templates', async () => SCENARIO_TEMPLATES);

  // The character you played last (docs/11 §2.1): the "Who do you play?" form of a new story starts from it.
  server.get('/api/minds/last-player', async (req) => {
    const exclude = (req.query as { exclude?: string }).exclude ?? '';
    const r = app.db
      .prepare(
        `SELECT cs.pronouns AS pronouns, cs.known_as AS known_as, cs.appearance AS appearance, cs.description AS description,
                mo.name AS name, s.title AS story_title
         FROM character_sheets cs JOIN memory_objects mo ON mo.id = cs.object_id JOIN stories s ON s.id = cs.story_id
         WHERE cs.is_player = 1 AND cs.story_id <> ? AND trim(mo.name) <> ''
         ORDER BY cs.updated_at DESC LIMIT 1`,
      )
      .get<Record<string, string>>(exclude);
    if (!r) return { none: true };
    return { name: r.name, pronouns: r.pronouns ?? '', knownAs: r.known_as ?? '', appearance: r.appearance ?? '', description: r.description ?? '', storyTitle: r.story_title ?? '' };
  });

  // ---- Scenario variable definitions ----

  server.get('/api/stories/:id/variables/defs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    return app.variables.listDefs(id);
  });

  /** Validate a definition list from the scenario editor: the defs in order, or the first problem. */
  const parseDefs = (body: unknown): { defs: VariableDef[] } | { error: string } => {
    const parsed = z.object({ defs: z.array(z.unknown()) }).safeParse(body);
    if (!parsed.success) return { error: 'expected { defs: [...] }' };
    const defs: VariableDef[] = [];
    for (const [i, raw] of parsed.data.defs.entries()) {
      const d = VariableDef.safeParse(raw);
      if (!d.success) return { error: `variable ${i + 1}: ${d.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')}` };
      defs.push({ ...d.data, appliesTo: normalizeAppliesTo(d.data.appliesTo), order: i });
    }
    try {
      validateDefs(defs);
    } catch (err) {
      return { error: (err as Error).message };
    }
    return { defs };
  };

  server.put('/api/stories/:id/variables/defs', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const r = parseDefs(req.body);
    if ('error' in r) {
      reply.code(400);
      return r;
    }
    app.variables.replaceDefs(id, r.defs);
    return app.variables.listDefs(id);
  });

  // The scenario editor's live preview (docs/11 §4.8): how a character, the player character's sheet and the
  // narrator will read these definitions — without saving them.
  server.post('/api/stories/:id/variables/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const r = parseDefs(req.body);
    if ('error' in r) {
      reply.code(400);
      return r;
    }
    return {
      character: characterVariableLines(r.defs, { id: 'preview', isPlayer: false, handle: 'someone' }),
      narrator: narratorVariableLines(r.defs),
    };
  });

  // ---- Places and things (docs/10 §5.1d) ----

  server.get('/api/stories/:id/minds/places', async (req, reply) => {
    const { id } = req.params as { id: string };
    const story = storyOr404(id, reply);
    if (!story) return { error: 'story not found' };
    const adv = viewerOf(id, req.query).kind === 'advanced';
    const scene = story.currentSceneId ? app.stories.getScene(story.currentSceneId) : undefined;
    const inView = new Set(scene?.itemHandles ?? []);
    const mentions = (handle: string) =>
      app.db
        .prepare(`SELECT count(*) AS n FROM thought_tags tt JOIN thoughts t ON t.id = tt.thought_id WHERE t.story_id = ? AND t.status = 'active' AND tt.tag = ?`)
        .get<{ n: number }>(id, `#${handle}`)!.n;
    return app.memory
      .listObjects(id)
      .filter((o) => o.type !== 'character')
      .map((o) => {
        const handle = o.handle ?? app.memory.ensureHandle(o.id) ?? '';
        return {
          objectId: o.id,
          handle,
          name: o.name,
          type: o.type,
          aliases: o.aliases,
          line: o.summary,
          gone: o.status === 'destroyed',
          here: scene?.locationObjectId === o.id,
          inView: inView.has(handle),
          updatedAt: o.updatedAt,
          ...(adv ? { mentions: mentions(handle) } : {}),
        };
      })
      .sort((a, b) => Number(a.gone) - Number(b.gone) || Number(b.here) - Number(a.here) || Number(b.inView) - Number(a.inView) || b.updatedAt - a.updatedAt);
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
    pronouns: z.string().max(40).optional(),
    knownAs: z.string().max(60).optional(),
    /** The narrator's hand-over: who they are (docs/11 §2.3). */
    concept: z.string().optional(),
    /** Their nature: 3–6 traits as nuanced phrases (docs/11 §2.7). */
    nature: z.string().max(600).optional(),
    /** Ties from this character's side, keyed by the other's object id or #handle; "" removes one (docs/11 §2.6). */
    ties: z.record(z.string(), z.string().max(120)).optional(),
    /** Advanced: whether the player knows this character's name (docs/11 §2.5). */
    playerKnowsName: z.boolean().optional(),
    state: z.string().optional(),
    tierId: z.string().nullable().optional(),
    /** In the current scene or not (docs/10 §5.1f). */
    here: z.boolean().optional(),
    /** awake | asleep | unconscious (docs/10 §5.1f). */
    awareness: z.enum(AWARENESS).optional(),
  });
  const checkLengths = (id: string, b: z.infer<typeof SheetBody>): string | undefined => {
    const max = app.stories.getStory(id)!.settings.minds.descriptionMaxWords;
    if (b.description !== undefined && wordCount(b.description) > max) return `the description is over ${max} words`;
    if (b.concept !== undefined && wordCount(b.concept) > CONCEPT_MAX_WORDS) return `"who they are" is over ${CONCEPT_MAX_WORDS} words — the description holds the rest`;
    if (b.appearance !== undefined && wordCount(b.appearance) > APPEARANCE_MAX_WORDS) return `the appearance is over ${APPEARANCE_MAX_WORDS} words — keep it to what anyone sees at a glance`;
    return undefined;
  };

  server.post('/api/stories/:id/minds', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    // `here`: added by the player during play (docs/11 §2.2): they join the scene now, the narrator is told to bring
    // them in, and a mind is written for them like for anyone the narrator brings in.
    const body = SheetBody.extend({ name: z.string().min(1), here: z.boolean().optional() }).safeParse(req.body);
    if (!body.success) {
      reply.code(400);
      return { error: 'a character needs a name' };
    }
    const tooLong = checkLengths(id, body.data);
    if (tooLong) {
      reply.code(400);
      return { error: tooLong };
    }
    const { playerKnowsName, ties, concept, nature, here, ...fields } = body.data;
    if (app.memory.findByName(id, body.data.name.trim())) {
      reply.code(409);
      return { error: `there is already someone called ${body.data.name.trim()} in this story` };
    }
    const sheet = createCharacter(deps, id, { ...fields, name: body.data.name.trim() });
    const oid = sheet.objectId;
    if (concept !== undefined || nature !== undefined) updateSheet(deps, id, oid, { ...(concept !== undefined ? { concept: concept.trim() } : {}), ...(nature !== undefined ? { nature: nature.trim() } : {}) });
    if (ties) setTies(id, oid, ties);
    const pc = app.sheets.player(id)?.objectId;
    if (playerKnowsName && pc && pc !== oid) app.names.learn(id, pc, oid, null);
    if (!fields.isPlayer && app.stories.getStory(id)?.settings.engine === 'minds') {
      const story = app.stories.getStory(id)!;
      const scene = story.currentSceneId ? app.stories.getScene(story.currentSceneId) : undefined;
      if (here && scene) setHere(id, oid, true, 'added');
      // Their mind, written like for anyone the narrator brings in; what the player wrote is never overwritten.
      app.jobs.enqueue('minds_seed', { storyId: id, payload: { objectId: oid } });
    }
    reply.code(201);
    return { ...(app.sheets.get(oid) ?? sheet), handle: app.memory.getObject(oid)?.handle ?? null };
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
    const { state, name, playerKnowsName, ties, here, awareness, ...patch } = body.data;
    if ((here === false || awareness) && app.sheets.get(oid)!.isPlayer) {
      reply.code(400);
      return { error: 'your character is always here and awake' };
    }
    if (here !== undefined) setHere(id, oid, here);
    if (awareness) setAwareness(id, oid, awareness);
    if (name) app.memory.updateObject(oid, { name });
    if (ties) setTies(id, oid, ties);
    if (patch.concept !== undefined) patch.concept = patch.concept.trim();
    if (patch.nature !== undefined) patch.nature = patch.nature.trim();
    if (playerKnowsName !== undefined) {
      const pc = app.sheets.player(id)?.objectId;
      if (pc && pc !== oid) {
        if (playerKnowsName) app.names.learn(id, pc, oid, null);
        else app.names.forget(pc, oid);
      }
    }
    // State goes through the rules so the change is logged ($state history).
    if (state !== undefined) applyChanges(deps, id, [{ change: { holder: oid, key: STATE_KEY, op: 'set', value: state }, by: 'user' }]);
    return updateSheet(deps, id, oid, patch);
  });

  // ---- Here or not, awake or not, by hand (docs/10 §5.1f) ----

  const placeName = (storyId: string) => {
    const story = app.stories.getStory(storyId)!;
    const scene = story.currentSceneId ? app.stories.getScene(story.currentSceneId) : undefined;
    return { scene, loc: scene?.locationObjectId ? app.memory.getObject(scene.locationObjectId)?.name : undefined };
  };
  /** Into or out of the current scene, telling the character and the narrator. */
  function setHere(storyId: string, oid: string, here: boolean, why: 'added' | 'moved' = 'moved'): void {
    const { scene, loc } = placeName(storyId);
    if (!scene || scene.activeNpcIds.includes(oid) === here) return;
    const obj = app.memory.getObject(oid)!;
    const sheet = app.sheets.get(oid)!;
    if (here) {
      app.stories.addActiveNpc(scene.id, oid);
      queueForCharacter(threadDeps, storyId, oid, `You have just arrived${loc ? ` at ${loc}` : ''}.`, null);
      const who = `#${obj.handle} ${obj.name}${sheet.pronouns ? ` (${sheet.pronouns})` : ''}${sheet.appearance ? ` — ${sheet.appearance}` : ''}`;
      queueForNarrator(
        threadDeps,
        storyId,
        why === 'added'
          ? `Note: the player added a character who is here now: ${who}.${sheet.concept ? ` Who they are: ${sheet.concept}.` : ''} Bring them in naturally in your next prose, and give them a brief.`
          : `Note: #${obj.handle} (${obj.name}) is here now (the player brought them into the scene). Bring them in naturally in your next prose, and give them a brief.`,
        null,
      );
    } else {
      app.stories.removeActiveNpc(scene.id, oid);
      queueForCharacter(threadDeps, storyId, oid, `You are no longer ${loc ? `at ${loc}` : 'here'}: you have gone elsewhere.`, null);
      queueForNarrator(threadDeps, storyId, `Note: #${obj.handle} is no longer here (the player moved them out of the scene). Don't bring them back unless the story does.`, null);
    }
  }
  /** Asleep, unconscious or awake, telling the character and the narrator. */
  function setAwareness(storyId: string, oid: string, to: (typeof AWARENESS)[number]): void {
    const from = app.sheets.get(oid)!.awareness;
    if (from === to) return;
    app.sheets.upsert(storyId, oid, { awareness: to });
    queueForCharacter(threadDeps, storyId, oid, awarenessNote(from, to), null);
    queueForNarrator(threadDeps, storyId, `Note: #${app.memory.getObject(oid)?.handle} is now ${to} (set by the player).`, null);
  }

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
    return app.variables
      .listChanges(id, { holder: q.holder, limit: q.limit ? Math.min(1000, Number(q.limit)) : undefined })
      .map((r) => {
        const pair = relationParts(r.holder);
        const nameOf = (id: string) => app.memory.getObject(id)?.name ?? id;
        return { ...r, holderName: r.holder === 'world' ? 'the world' : pair ? `${nameOf(pair.from)} → ${nameOf(pair.to)}` : nameOf(r.holder) };
      });
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
    // Each thought with its current importance (fading applied) and who it is about (docs/11 §5.7, §5.10).
    const lens = thoughtLens(deps, id);
    return {
      thoughts: app.thoughts.list(id, q.owner, { includeRevoked: q.includeRevoked === '1' || q.includeRevoked === 'true' }).map((t) => {
        const about = t.about ? app.memory.getObject(t.about) : undefined;
        return {
          ...t,
          current: t.status === 'active' ? lens.current(t) : 0,
          fades: fades(t),
          aboutHandle: about?.handle ?? null,
          aboutName: about?.name ?? null,
          revisesSeq: t.revises ? (app.thoughts.get(t.revises)?.seq ?? null) : null,
        };
      }),
      vocabulary: app.thoughts.vocabulary(id, q.owner),
      fadeHours: lens.fadeHours,
      fadeRounds: lens.fadeRounds,
    };
  });

  server.post('/api/stories/:id/thoughts', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!storyOr404(id, reply)) return { error: 'story not found' };
    const body = z
      .object({
        owner: z.string(),
        text: z.string().min(1),
        tags: z.array(z.string()).default([]),
        pin: z.boolean().default(false),
        kind: z.enum(THOUGHT_KINDS).optional(),
        importance: z.number().int().min(1).max(10).optional(),
        /** The object id or #handle it is about. */
        about: z.string().optional(),
        /** Expectations (docs/11 §5.11). */
        confidence: z.number().int().min(1).max(10).optional(),
        hope: z.enum(HOPES).optional(),
        horizon: z.enum(HORIZONS).optional(),
      })
      .safeParse(req.body);
    if (!body.success || !isOwner(id, body.data.owner)) {
      reply.code(400);
      return { error: "expected { owner, text, tags?, pin?, kind?, importance?, about? } with owner 'narrator' or a character of this story" };
    }
    if (body.data.about && app.sheets.get(body.data.about)) body.data.about = app.memory.getObject(body.data.about)?.handle ?? body.data.about;
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
    const body = z
      .object({
        revoked: z.literal(true).optional(),
        /** Bring a faded, forgotten or revised thought back to mind (renewed now). */
        restore: z.literal(true).optional(),
        pinned: z.boolean().optional(),
        text: z.string().min(1).optional(),
        kind: z.enum(THOUGHT_KINDS).optional(),
        importance: z.number().int().min(1).max(10).optional(),
        /** An object id or #handle; null clears it. */
        about: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        confidence: z.number().int().min(1).max(10).optional(),
        hope: z.enum(HOPES).optional(),
        horizon: z.enum(HORIZONS).optional(),
      })
      .parse(req.body ?? {});
    // Every change here is by hand (docs/11 §5.10c): marked, so a rewind keeps it, and told to the mind.
    let change: 'forgot' | 'restored' | 'edited' | undefined;
    if (body.revoked && t.status === 'active') {
      app.thoughts.revoke(tid, null);
      change = 'forgot';
    }
    if (body.restore && t.status !== 'active') {
      app.thoughts.setStatus(tid, 'active', null);
      app.thoughts.renew([tid], app.stories.getStory(t.storyId)?.clockMin ?? null);
      change = 'restored';
    }
    if (body.pinned !== undefined) app.thoughts.setPinned(tid, body.pinned);
    const { text, kind, importance, about, tags, confidence, hope, horizon } = body;
    if ([text, kind, importance, about, tags, confidence, hope, horizon].some((x) => x !== undefined)) {
      editThought(deps, t.storyId, t, { text, kind, importance, about, tags, confidence, hope, horizon });
      // An edit is the user deciding it matters now: it starts fading from here.
      app.thoughts.renew([tid], app.stories.getStory(t.storyId)?.clockMin ?? null);
      change ??= 'edited';
    }
    if (change || body.pinned !== undefined) app.thoughts.markHandEdited(tid);
    const after = app.thoughts.get(tid)!;
    if (change) tellOfHandEdit(threadDeps, t, after, change);
    return after;
  });
}
