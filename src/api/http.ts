import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import { StorySettings } from '../domain.ts';

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
}
