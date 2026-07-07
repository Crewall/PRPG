import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap', context_planner: 'cheap' },
});

function silentEmitter(): TurnEmitter {
  return { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };
}

interface Capture {
  plannerCalls: number;
  storytellerReq: ChatRequest | null;
}

/** Dispatches on the system prompt: planner gets a JSON plan, storyteller echoes. */
function dispatchDriver(cap: Capture): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      let text: string;
      if (req.system.includes('Context Planner')) {
        cap.plannerCalls++;
        text = JSON.stringify({ queries: ['heron amulet'], focusObjects: ['Marta'], depth: 'minor' });
      } else {
        cap.storytellerReq = req;
        text = 'The story continues.';
        onDelta?.(text);
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('summary-driven storyteller context (feature 4)', () => {
  let dir: string;
  let app: App;
  let cap: Capture;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-'));
    cap = { plannerCalls: 0, storytellerReq: null };
    app = createApp(config, { driverFactory: () => dispatchDriver(cap), dbPath: join(dir, 'test.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStory(summaryDriven: boolean, plannerEnabled = true) {
    const story = app.stories.createStory({
      title: 'S',
      settings: { premise: 'A quiet harbor town.', context: { summaryDriven, plannerEnabled }, budgets: { recentTurns: 6, digestTokens: 800, sceneSummaryTokens: 300, retrievedMemoryTokens: 1500 } },
    });
    // Six completed turns of raw history.
    for (let i = 0; i < 6; i++) {
      const t = app.stories.appendTurn({ storyId: story.id, playerInput: `input ${i}`, status: 'complete' });
      app.stories.updateTurn(t.id, { narration: `narration ${i}`, status: 'complete' });
    }
    app.summaries.upsertStoryDigest(story.id, 'Digest: the amulet was stolen from the shrine.', 5);
    // Memory: a character (with a minor-tier nuance) and a goal.
    const marta = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Marta', aliases: [], summary: 'The innkeeper.', salience: 0.9, status: 'active' });
    app.memory.addFact({ objectId: marta.id, category: 'appearance', detailLevel: 'visible', tier: 'minor', content: 'Marta hums old sea shanties when nervous', confidence: 1 });
    app.memory.addFact({ objectId: marta.id, category: 'goals', detailLevel: 'known', tier: 'major', content: 'Marta wants the heron amulet returned', confidence: 1 });
    return app.stories.getStory(story.id)!;
  }

  it('replaces raw history with summary + goals + planner-picked memory', async () => {
    const story = seedStory(true);
    await app.pipeline.run(story.id, 'What should we do next?', silentEmitter());

    expect(cap.plannerCalls).toBe(1);
    const req = cap.storytellerReq!;
    // Only the latest completed exchange + the new input — not the 6-turn history.
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0].content).toBe('input 5');
    expect(req.messages[1].content).toBe('narration 5');
    // Summary, goals and the planner's focus object made it into the system prompt.
    expect(req.system).toContain('Digest: the amulet was stolen');
    expect(req.system).toContain('## Current goals');
    expect(req.system).toContain('heron amulet returned');
    expect(req.system).toContain('## In focus this turn');
    expect(req.system).toContain('sea shanties'); // minor tier included (depth: 'minor')
  });

  it('planner off → still summary-driven, no planner call', async () => {
    const story = seedStory(true, false);
    await app.pipeline.run(story.id, 'Onward.', silentEmitter());
    expect(cap.plannerCalls).toBe(0);
    expect(cap.storytellerReq!.messages).toHaveLength(3);
    expect(cap.storytellerReq!.system).toContain('## Current goals');
  });

  it('default mode keeps the raw last-K history and never calls the planner', async () => {
    const story = seedStory(false);
    await app.pipeline.run(story.id, 'Onward.', silentEmitter());
    expect(cap.plannerCalls).toBe(0);
    // Last-K window (K=6, which includes the just-opened streaming turn):
    // 5 completed pairs + the streaming turn's input + the new input.
    expect(cap.storytellerReq!.messages).toHaveLength(12);
    expect(cap.storytellerReq!.system).not.toContain('## Current goals');
  });
});
