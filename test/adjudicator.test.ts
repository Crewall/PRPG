import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import { clampChance, outcomeFromRoll } from '../src/orchestrator/resolution.ts';
import type { ChatRequest, LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap', adjudicator: 'cheap' },
});

interface Capture {
  adjudicatorCalls: number;
  weaveReq: ChatRequest | null;
}

// Storyteller: emits a lead-in + resolve_action on pass 1, a continuation on
// the weave. Adjudicator: 70% success chance with a concrete complication.
function driver(cap: Capture, opts: { adjudicatorThrows?: boolean } = {}): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const lastUser = req.messages[req.messages.length - 1]?.content ?? '';
      let text: string;
      if (req.system.includes('You are the **Adjudicator**')) {
        cap.adjudicatorCalls++;
        if (opts.adjudicatorThrows) throw new Error('adjudicator model down');
        text = JSON.stringify({ assessment: 'wet stone, but geared and helped', successChance: 70, keyFactors: ['climbing gear', 'rain'], complication: 'the guard above hears scraping' });
      } else if (lastUser.includes('Fate has decided')) {
        cap.weaveReq = req;
        text = 'Your fingers find the last hold and you haul yourself over the parapet.';
        onDelta?.(text);
      } else {
        text = 'You size up the rain-slick wall and start to climb.\n\n```directives\n{"directives":[{"type":"resolve_action","actor":"the player","action":"climb the courtyard wall","factors":["rain-slick stone","has climbing gear"]}]}\n```';
        onDelta?.(text);
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

function silentEmitter(deltas?: string[]): TurnEmitter {
  return { accepted() {}, status() {}, delta(t) { deltas?.push(t); }, final() {}, rejected() {}, error() {} };
}

describe('outcome bands (engine dice)', () => {
  it('maps margins to bands and clamps chances', () => {
    expect(clampChance(100)).toBe(98);
    expect(clampChance(-5)).toBe(2);
    expect(outcomeFromRoll(70, 10)).toBe('critical-success'); // margin 60
    expect(outcomeFromRoll(70, 70)).toBe('success'); // margin 0
    expect(outcomeFromRoll(70, 80)).toBe('partial'); // margin -10
    expect(outcomeFromRoll(70, 100)).toBe('failure'); // margin -30
    expect(outcomeFromRoll(20, 90)).toBe('critical-failure'); // margin -70
  });
});

describe('adjudicated turns', () => {
  let dir: string;
  let app: App;
  afterEach(() => {
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(cap: Capture, rng: () => number, driverOpts: { adjudicatorThrows?: boolean } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'prpg-adj-'));
    app = createApp(config, { driverFactory: () => driver(cap, driverOpts), dbPath: join(dir, 't.db'), startWorker: false, rng });
    return app;
  }

  it('resolves an uncertain action: hidden roll, continuation weave, meta record', async () => {
    const cap: Capture = { adjudicatorCalls: 0, weaveReq: null };
    boot(cap, () => 0.3); // d100 = 31 vs chance 70 → margin 39 → success
    const story = app.stories.createStory({ title: 'A' });
    const deltas: string[] = [];
    const turn = await app.pipeline.run(story.id, 'I climb the wall.', silentEmitter(deltas));

    expect(turn?.status).toBe('complete');
    expect(cap.adjudicatorCalls).toBe(1);
    // Final narration = streamed lead-in + continuation; directive stripped.
    expect(turn?.narration).toContain('size up the rain-slick wall');
    expect(turn?.narration).toContain('haul yourself over the parapet');
    expect(turn?.narration).not.toContain('directives');
    // The streamed deltas cover both parts (lead-in was never re-sent).
    const streamed = deltas.join('');
    expect(streamed).toContain('size up the rain-slick wall');
    expect(streamed).toContain('haul yourself over the parapet');
    // The weave saw qualitative guidance, never numbers.
    expect(cap.weaveReq!.messages.at(-1)!.content).toContain('succeeds — grant the goal cleanly');
    expect(cap.weaveReq!.messages.at(-1)!.content).not.toMatch(/\b70\b|\b31\b/);
    // Dice recorded in meta (debug/logs only).
    const rolls = turn?.meta.rolls as { chance: number; roll: number; outcome: string }[];
    expect(rolls).toHaveLength(1);
    expect(rolls[0]).toMatchObject({ chance: 70, roll: 31, outcome: 'success' });
    expect(turn?.meta.storytellerCalls).toBe(2);
    // Adjudicator call is in the thread log for debugging.
    expect(app.threadLog.query(story.id).some((l) => l.agentRole === 'adjudicator')).toBe(true);
  });

  it('a bad roll produces a failure band with the complication attached', async () => {
    const cap: Capture = { adjudicatorCalls: 0, weaveReq: null };
    boot(cap, () => 0.97); // d100 = 98 vs 70 → margin -28 → failure
    const story = app.stories.createStory({ title: 'B' });
    const turn = await app.pipeline.run(story.id, 'I climb the wall.', silentEmitter());
    expect((turn?.meta.rolls as { outcome: string }[])[0].outcome).toBe('failure');
    expect(cap.weaveReq!.messages.at(-1)!.content).toContain('fail forward');
    expect(cap.weaveReq!.messages.at(-1)!.content).toContain('guard above hears scraping');
  });

  it('adjudicator off → no referee call, directive ignored, prompt section absent', async () => {
    const cap: Capture = { adjudicatorCalls: 0, weaveReq: null };
    boot(cap, () => 0.3);
    const story = app.stories.createStory({ title: 'C', settings: { adjudicator: { enabled: false } } });
    const turn = await app.pipeline.run(story.id, 'I climb the wall.', silentEmitter());
    expect(cap.adjudicatorCalls).toBe(0);
    expect(cap.weaveReq).toBeNull();
    expect(turn?.narration).toContain('size up the rain-slick wall');
    expect(turn?.meta.rolls).toBeUndefined();
    // The storyteller was never told about resolve_action.
    const req = app.threadLog.query(story.id, { role: 'storyteller' }).find((l) => l.direction === 'request');
    expect((req!.payload as { system: string }).system).not.toContain('resolve_action');
  });

  it('referee failure degrades: storyteller decides, turn still completes', async () => {
    const cap: Capture = { adjudicatorCalls: 0, weaveReq: null };
    boot(cap, () => 0.3, { adjudicatorThrows: true });
    const story = app.stories.createStory({ title: 'D' });
    const turn = await app.pipeline.run(story.id, 'I climb the wall.', silentEmitter());
    expect(turn?.status).toBe('complete');
    expect(cap.weaveReq!.messages.at(-1)!.content).toContain('referee is unavailable');
    expect(turn?.meta.rolls).toBeUndefined();
  });
});
