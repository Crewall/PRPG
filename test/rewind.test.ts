import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

function echoDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const text = `Narration for: ${req.messages[req.messages.length - 1]?.content.slice(0, 20)}`;
      onDelta?.(text);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

/** A driver that never answers until its request is aborted. */
function hangingDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    chat(req) {
      return new Promise((_res, rej) => {
        req.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    },
  };
}

function silentEmitter(): TurnEmitter {
  return { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };
}

describe('rewind (features 1 + 1a)', () => {
  let dir: string;
  let app: App;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-'));
    app = createApp(config, { driverFactory: () => echoDriver(), dbPath: join(dir, 'test.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores summaries, memory and transcript to the pre-message state', async () => {
    const story = app.stories.createStory({ title: 'R' });
    await app.pipeline.run(story.id, 'first move', silentEmitter());

    // Simulate the post-turn-1 scribes: a scene summary and a memory object+fact.
    const sceneId = app.stories.getStory(story.id)!.currentSceneId!;
    app.summaries.upsertSceneSummary(story.id, sceneId, 'summary after turn 1', 0);
    const bram = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Bram', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const ring = app.memory.addFact({ objectId: bram.id, category: 'inventory', detailLevel: 'visible', tier: 'major', content: 'Bram wears a silver ring', confidence: 1 });
    app.memory.linkKnowledge(ring.id, { type: 'player' });

    // Turn 2 (snapshot captured at its start), then simulate its scribes mutating everything.
    await app.pipeline.run(story.id, 'second move', silentEmitter());
    app.summaries.upsertSceneSummary(story.id, sceneId, 'OVERWRITTEN after turn 2', 1);
    app.summaries.upsertStoryDigest(story.id, 'new digest', 1);
    app.memory.supersedeFact(ring.id, { objectId: bram.id, category: 'inventory', detailLevel: 'visible', content: 'Bram lost his ring', confidence: 1 });
    app.memory.createObject({ storyId: story.id, type: 'item', name: 'Stray Object', aliases: [], summary: '', salience: 0.5, status: 'active' });
    app.stories.setActiveNpcs(sceneId, [bram.id]);

    const result = await app.pipeline.rewind(story.id);
    expect(result.restored).toBe(true);
    expect(result.playerInput).toBe('second move');

    // Turn 2 is gone; turn 1 intact.
    const turns = app.stories.listTurns(story.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].playerInput).toBe('first move');

    // Summaries back to the pre-message state.
    expect(app.summaries.getSceneSummary(sceneId)?.content).toBe('summary after turn 1');
    expect(app.summaries.getStoryDigest(story.id)).toBeUndefined();

    // Memory: superseded fact live again, replacement gone, stray object gone.
    const facts = app.memory.listFacts(bram.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Bram wears a silver ring');
    expect(facts[0].superseded).toBe(false);
    expect(facts[0].tier).toBe('major');
    expect(app.memory.findByName(story.id, 'Stray Object')).toBeUndefined();
    // Knowledge link survived the restore.
    expect(app.memory.linksForFacts([ring.id]).get(ring.id)).toHaveLength(1);
    // FTS reindexed consistently: old content findable, new content not.
    expect(app.memory.ftsSearch(story.id, 'silver ring')).toHaveLength(1);
    expect(app.memory.ftsSearch(story.id, 'lost')).toHaveLength(0);

    // Scene NPC roster restored.
    expect(app.stories.getScene(sceneId)?.activeNpcIds).toEqual([]);

    // Storyteller transcript back to one exchange.
    const st = app.agents.listSessions(story.id).find((s) => s.role === 'storyteller')!;
    expect(app.agents.countMessages(st.id)).toBe(2);
  });

  it('rewinds repeatedly down to an empty story, then refuses', async () => {
    const story = app.stories.createStory({ title: 'R2' });
    await app.pipeline.run(story.id, 'one', silentEmitter());
    await app.pipeline.run(story.id, 'two', silentEmitter());

    expect((await app.pipeline.rewind(story.id)).playerInput).toBe('two');
    expect((await app.pipeline.rewind(story.id)).playerInput).toBe('one');
    expect(app.stories.listTurns(story.id)).toHaveLength(0);
    await expect(app.pipeline.rewind(story.id)).rejects.toThrow(/nothing to rewind/);
  });

  it('halts an in-flight response and deletes its turn', async () => {
    const hangApp = createApp(config, { driverFactory: () => hangingDriver(), dbPath: join(dir, 'hang.db'), startWorker: false });
    try {
      const story = hangApp.stories.createStory({ title: 'H' });
      const pending = hangApp.pipeline.run(story.id, 'stuck prompt', silentEmitter());
      await new Promise((r) => setTimeout(r, 25)); // let the turn reach the (hanging) LLM

      const result = await hangApp.pipeline.rewind(story.id);
      expect(result.playerInput).toBe('stuck prompt');

      const cancelled = await pending;
      expect(cancelled?.status).toBe('rejected');
      expect(hangApp.stories.listTurns(story.id)).toHaveLength(0);
    } finally {
      hangApp.close();
    }
  });

  it('drops queued post-turn jobs on rewind', async () => {
    const story = app.stories.createStory({ title: 'J' });
    await app.pipeline.run(story.id, 'go', silentEmitter());
    expect(app.jobs.countPending()).toBeGreaterThan(0); // scribes queued by the turn
    await app.pipeline.rewind(story.id);
    expect(app.jobs.countPending()).toBe(0);
  });
});
