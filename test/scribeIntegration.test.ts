import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { LlmDriver } from '../src/llm/types.ts';
import type { ServerEvent } from '../src/util/events.ts';
import { createContextBuilder } from '../src/orchestrator/contextBuilder.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// One driver that role-plays every agent by inspecting the system prompt.
function multiAgentDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req) {
      const sys = req.system;
      let text: string;
      if (sys.includes('Memory Scribe')) {
        text = JSON.stringify({
          newObjects: [{ tempId: 't1', type: 'character', name: 'Marta', aliases: ['the innkeeper'], summary: 'The innkeeper of the Rusty Flagon.' }],
          newFacts: [
            { objectId: 't1', category: 'appearance', detailLevel: 'visible', content: 'A stout woman with grey hair.', confidence: 0.9, knownBy: ['player'] },
            { objectId: 't1', category: 'history', detailLevel: 'secret', content: 'Marta hid the stolen ledger in the cellar.', confidence: 0.8, knownBy: [] },
          ],
          salienceUpdates: [],
          mergeSuggestions: [],
        });
      } else if (sys.includes('Story Scribe') && sys.includes('storyDigest')) {
        text = JSON.stringify({ storyDigest: 'Premise: a traveler at the Rusty Flagon. Open threads: the stolen ledger. Current: talking to Marta.' });
      } else if (sys.includes('Story Scribe')) {
        text = JSON.stringify({ sceneSummary: 'The traveler greets Marta the innkeeper at the Rusty Flagon.' });
      } else {
        text = 'You step up to the bar. Marta the innkeeper eyes you warily and asks what you want.';
      }
      return { text, usage: { inputTokens: 5, outputTokens: 5 }, model: req.model };
    },
  };
}

const noopEmitter: TurnEmitter = { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };

describe('post-turn scribes integration (Layers 2 + 3b)', () => {
  let dir: string;
  let app: App;
  let events: ServerEvent[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-si-'));
    app = createApp(config, { driverFactory: () => multiAgentDriver(), dbPath: join(dir, 'si.db'), startWorker: false });
    events = [];
    app.events.on((e) => events.push(e));
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a completed turn produces a scene summary and extracted memory', async () => {
    const story = app.stories.createStory({ title: 'Flagon', settings: { premise: 'A rainy tavern.' } });
    await app.pipeline.run(story.id, 'I greet Marta the innkeeper.', noopEmitter);

    // Two jobs were enqueued (scribe_story + scribe_memory); run them.
    await app.worker.drain();

    // scribe_story wrote a scene summary.
    const fresh = app.stories.getStory(story.id)!;
    const sceneSummary = app.summaries.getSceneSummary(fresh.currentSceneId!);
    expect(sceneSummary?.content).toContain('Marta');

    // scribe_memory created the object + facts with correct disclosure.
    const marta = app.memory.findByName(story.id, 'the innkeeper');
    expect(marta?.name).toBe('Marta');
    const playerView = app.memory.getObjectView(marta!.id, { kind: 'player' })!;
    const stView = app.memory.getObjectView(marta!.id, { kind: 'storyteller' })!;
    expect(playerView.facts.map((f) => f.content)).toContain('A stout woman with grey hair.');
    // The secret ledger fact is hidden from the player (no knower link) but not the storyteller.
    expect(playerView.facts.some((f) => f.content.includes('ledger'))).toBe(false);
    expect(stView.facts.some((f) => f.content.includes('ledger'))).toBe(true);

    // Events fired for UI refresh.
    expect(events.some((e) => e.t === 'summary.updated')).toBe(true);
    expect(events.some((e) => e.t === 'memory.updated')).toBe(true);
  });

  it('a manual new scene folds the closed scene into the story digest', async () => {
    const story = app.stories.createStory({ title: 'Flagon2', settings: { premise: 'A rainy tavern.' } });
    await app.pipeline.run(story.id, 'I greet Marta.', noopEmitter);
    await app.worker.drain(); // scene summary now exists

    app.pipeline.newScene(story.id, { title: 'The Cellar' });
    await app.worker.drain(); // digest fold job runs

    const digest = app.summaries.getStoryDigest(story.id);
    expect(digest?.content).toContain('ledger');
    // The story advanced to a new open scene.
    const fresh = app.stories.getStory(story.id)!;
    expect(app.stories.getScene(fresh.currentSceneId!)?.title).toBe('The Cellar');
  });

  it('the extracted memory feeds the next storyteller prompt (retrieval loop closes)', async () => {
    const story = app.stories.createStory({ title: 'Flagon3', settings: { premise: 'A rainy tavern.' } });
    await app.pipeline.run(story.id, 'I greet Marta the innkeeper.', noopEmitter);
    await app.worker.drain();

    // Build the next context — the storyteller (omniscient scope) should now see
    // the secret ledger fact retrieved from memory, even though no summary mentions it.
    const contexts = createContextBuilder({ stories: app.stories, summaries: app.summaries, memory: app.memory });
    const ctx = contexts.forStoryteller(app.stories.getStory(story.id)!, 'I ask Marta about the ledger.');
    expect(ctx.system).toContain('ledger');
  });
});
