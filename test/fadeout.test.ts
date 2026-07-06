import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// Scene scribe drops a detail into fadedOut; the archive pass (memory scribe)
// then objectifies it. Dispatch on the system prompt.
function dispatchDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req) {
      let text: string;
      if (req.system.includes('CURRENT SCENE')) {
        text = JSON.stringify({
          sceneSummary: 'The trek continues toward the pass.',
          fadedOut: ['Bram the innkeeper lent the party his mule, Clover.'],
        });
      } else if (req.system.includes('Memory Scribe')) {
        text = JSON.stringify({
          newObjects: [{ tempId: 't1', type: 'character', name: 'Bram', aliases: [], summary: 'Innkeeper who helped the party.' }],
          newFacts: [
            { objectId: 't1', category: 'relations', detailLevel: 'known', tier: 'minor', content: 'Lent the party his mule, Clover.', confidence: 0.9, knownBy: ['player'] },
          ],
          salienceUpdates: [],
          mergeSuggestions: [],
        });
      } else {
        text = 'narration';
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('summary fade-out → memory archive (feature 3)', () => {
  let dir: string;
  let app: App;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-'));
    app = createApp(config, { driverFactory: () => dispatchDriver(), dbPath: join(dir, 'test.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('details dropped from the scene summary are objectified into memory', async () => {
    const story = app.stories.createStory({ title: 'F' });
    const turn = app.stories.appendTurn({ storyId: story.id, playerInput: 'we ride on', status: 'complete' });
    app.stories.updateTurn(turn.id, { narration: 'You ride on.', status: 'complete' });

    app.jobs.enqueue('scribe_story', { storyId: story.id, turnId: turn.id, payload: { mode: 'scene', turnId: turn.id } });
    await app.worker.drain(); // runs the scene job AND the archive_faded job it enqueues

    expect(app.summaries.getSceneSummary(turn.sceneId!)?.content).toContain('trek continues');

    const bram = app.memory.findByName(story.id, 'Bram');
    expect(bram).toBeDefined();
    const facts = app.memory.listFacts(bram!.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain('Clover');
    expect(facts[0].tier).toBe('minor');
    expect(facts[0].sourceTurnId).toBeNull(); // archived, not tied to a turn
    // The player keeps knowledge of what they lived through.
    expect(app.memory.linksForFacts([facts[0].id]).get(facts[0].id)?.[0]?.knowerType).toBe('player');
  });
});
