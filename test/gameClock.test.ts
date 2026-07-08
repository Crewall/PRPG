import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { LlmDriver } from '../src/llm/types.ts';
import { formatGameClock, formatGameClockShort, CLOCK_START_MIN, DEFAULT_TURN_MINUTES } from '../src/util/gameClock.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

const noopEmitter: TurnEmitter = { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };

function driver(replies: string[]): LlmDriver {
  let i = 0;
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const sys = req.system;
      let text: string;
      if (sys.includes('Memory Scribe')) {
        text = JSON.stringify({
          newObjects: [{ tempId: 't1', type: 'event', name: 'The cellar discovery', aliases: [], summary: '' }],
          newFacts: [{ objectId: 't1', category: 'what-happened', detailLevel: 'known', content: 'The player found the hidden cellar door.', confidence: 0.9, knownBy: ['player'] }],
          salienceUpdates: [],
          mergeSuggestions: [],
        });
      } else if (sys.includes('Story Scribe')) {
        text = JSON.stringify({ sceneSummary: 'Things happened.', storyDigest: 'Things happened.' });
      } else {
        text = replies[Math.min(i++, replies.length - 1)];
        onDelta?.(text);
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('the hidden in-game clock', () => {
  let dir: string;
  let app: App | undefined;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prpg-clock-')); });
  afterEach(() => { app?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('formats day/hour/minute from minute 0 = Day 1, 00:00', () => {
    expect(formatGameClock(0)).toBe('Day 1, 00:00');
    expect(formatGameClock(CLOCK_START_MIN)).toBe('Day 1, 08:00');
    expect(formatGameClock(1440 + 14 * 60 + 30)).toBe('Day 2, 14:30');
    expect(formatGameClockShort(1440 + 14 * 60 + 30)).toBe('d2 14:30');
  });

  it('advances by the default per turn, or by an advance_time directive; facts get stamped', async () => {
    app = createApp(config, {
      driverFactory: () => driver([
        'You look around the tavern.',
        'You sleep until dawn.\n\n```directives\n{"directives":[{"type":"advance_time","minutes":480}]}\n```',
      ]),
      dbPath: join(dir, 'c.db'),
      startWorker: false,
    });
    const story = app.stories.createStory({ title: 'Clock' });
    expect(story.clockMin).toBe(CLOCK_START_MIN);

    await app.pipeline.run(story.id, 'I look around.', noopEmitter);
    let fresh = app.stories.getStory(story.id)!;
    expect(fresh.clockMin).toBe(CLOCK_START_MIN + DEFAULT_TURN_MINUTES);

    const turn2 = await app.pipeline.run(story.id, 'I go to sleep.', noopEmitter);
    fresh = app.stories.getStory(story.id)!;
    expect(fresh.clockMin).toBe(CLOCK_START_MIN + DEFAULT_TURN_MINUTES + 480);
    expect(turn2!.meta.clockMin).toBe(fresh.clockMin);
    // The advance_time fence never reaches the player.
    expect(turn2!.narration).not.toContain('advance_time');

    // The memory scribe's facts carry the in-game stamp of their SOURCE turn
    // (the first turn's clock, not the clock after later turns).
    await app.worker.drain();
    const event = app.memory.findByName(story.id, 'The cellar discovery')!;
    const facts = app.memory.listFacts(event.id);
    expect(facts[0].gameTimeMin).toBe(CLOCK_START_MIN + DEFAULT_TURN_MINUTES);
    // …and scoped views expose the stamp for prompt rendering.
    const view = app.memory.getObjectView(event.id, { kind: 'storyteller' })!;
    expect(view.facts[0].gameTimeMin).toBe(CLOCK_START_MIN + DEFAULT_TURN_MINUTES);
  });

  it('rewind restores the pre-turn clock', async () => {
    app = createApp(config, {
      driverFactory: () => driver(['A week passes on the road.\n\n```directives\n{"directives":[{"type":"advance_time","minutes":4320}]}\n```']),
      dbPath: join(dir, 'r.db'),
      startWorker: false,
    });
    const story = app.stories.createStory({ title: 'Rewind' });
    await app.pipeline.run(story.id, 'I travel east.', noopEmitter);
    expect(app.stories.getStory(story.id)!.clockMin).toBe(CLOCK_START_MIN + 4320);
    await app.pipeline.rewind(story.id);
    expect(app.stories.getStory(story.id)!.clockMin).toBe(CLOCK_START_MIN);
  });
});
