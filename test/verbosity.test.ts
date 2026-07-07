import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { ChatRequest, LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

const silent: TurnEmitter = { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };

describe('storyteller verbosity + PC sheet in context', () => {
  let dir: string;
  let app: App;
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(cap: { req: ChatRequest | null }) {
    dir = mkdtempSync(join(tmpdir(), 'prpg-v-'));
    const driver: LlmDriver = {
      kind: 'anthropic',
      async chat(req) {
        if (req.system.includes('You are the **Storyteller**')) cap.req = req;
        return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
      },
    };
    app = createApp(config, { driverFactory: () => driver, dbPath: join(dir, 't.db'), startWorker: false });
  }

  it('verbosity 1 → terse instruction; 5 → expansive', async () => {
    const cap = { req: null as ChatRequest | null };
    boot(cap);
    const s1 = app.stories.createStory({ title: 'V1', settings: { verbosity: 1 } });
    await app.pipeline.run(s1.id, 'hello', silent);
    expect(cap.req!.system).toContain('TERSE: one short paragraph');

    const s5 = app.stories.createStory({ title: 'V5', settings: { verbosity: 5 } });
    await app.pipeline.run(s5.id, 'hello', silent);
    expect(cap.req!.system).toContain('expansive replies');
  });

  it('default verbosity 3 and PC sheet section when a player character exists', async () => {
    const cap = { req: null as ChatRequest | null };
    boot(cap);
    const story = app.stories.createStory({ title: 'V3' });
    const pc = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Kael', aliases: [], summary: 'A cartographer.', salience: 0.9, status: 'active' });
    app.memory.addFact({ objectId: pc.id, category: 'abilities', detailLevel: 'known', tier: 'major', content: 'Expert climber', confidence: 1 });
    app.stories.updateStory(story.id, { settings: { playerObjectId: pc.id } });

    await app.pipeline.run(story.id, 'hello', silent);
    expect(cap.req!.system).toContain('1–4 short paragraphs');
    expect(cap.req!.system).toContain("## The player's character");
    expect(cap.req!.system).toContain('Expert climber');
  });
});
