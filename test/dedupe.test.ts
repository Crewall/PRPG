import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { applyMemoryDelta } from '../src/orchestrator/memoryHandlers.ts';
import { MemoryDelta } from '../src/agents/scribeMemory.ts';
import { isNearDuplicate } from '../src/memory/similarity.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

const noopDriver = (): LlmDriver => ({ kind: 'anthropic', async chat(req) { return { text: 'x', usage: { inputTokens: 0, outputTokens: 0 }, model: req.model }; } });

describe('memory dedupe (feature 6)', () => {
  it('isNearDuplicate: catches rephrasings, spares short distinct facts', () => {
    expect(isNearDuplicate('Bram wears a silver ring', 'bram wears a silver ring.')).toBe(true);
    expect(isNearDuplicate('Bram wears a silver ring on his finger', 'Bram wears a silver ring')).toBe(true);
    expect(isNearDuplicate('Bram wears a silver ring', 'Marta owns the tavern')).toBe(false);
    expect(isNearDuplicate('on duty', 'off duty')).toBe(false); // short → exact only
  });

  describe('through the pipeline', () => {
    let dir: string;
    let app: App;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'prpg-'));
      app = createApp(config, { driverFactory: noopDriver, dbPath: join(dir, 'test.db'), startWorker: false });
    });
    afterEach(() => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    function handlerDeps() {
      const { db, stories, summaries, agents, threadLog, registry, events, memory, npcProfiles, suggestions, jobs } = app;
      return { db, stories, summaries, agents, threadLog, registry, events, memory, npcProfiles, suggestions, jobs };
    }

    it('applyMemoryDelta skips near-duplicates but still extends knowledge', () => {
      const story = app.stories.createStory({ title: 'D' });
      const bram = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Bram', aliases: [], summary: '', salience: 0.5, status: 'active' });
      const orig = app.memory.addFact({ objectId: bram.id, category: 'inventory', detailLevel: 'known', content: 'Bram wears a heavy silver ring', confidence: 1 });

      const delta = MemoryDelta.parse({
        newFacts: [
          // Near-duplicate of the existing fact, now witnessed by the player.
          { objectId: bram.id, category: 'inventory', detailLevel: 'known', content: 'Bram is wearing a heavy silver ring.', knownBy: ['player'] },
          // Genuinely new information.
          { objectId: bram.id, category: 'state', detailLevel: 'visible', content: 'Bram limps on his left leg', knownBy: [] },
        ],
      });
      applyMemoryDelta(handlerDeps(), story.id, null, delta);

      const facts = app.memory.listFacts(bram.id);
      expect(facts).toHaveLength(2); // no third, duplicate fact
      expect(facts.some((f) => f.content.includes('limps'))).toBe(true);
      // The knownBy of the skipped duplicate landed on the ORIGINAL fact.
      expect(app.memory.linksForFacts([orig.id]).get(orig.id)?.some((l) => l.knowerType === 'player')).toBe(true);
    });

    it('supersede is never blocked by similarity to the fact it replaces', () => {
      const story = app.stories.createStory({ title: 'D2' });
      const bram = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Bram', aliases: [], summary: '', salience: 0.5, status: 'active' });
      const orig = app.memory.addFact({ objectId: bram.id, category: 'appearance', detailLevel: 'visible', content: 'Bram wears a red woolen coat today', confidence: 1 });

      const delta = MemoryDelta.parse({
        newFacts: [{ objectId: bram.id, category: 'appearance', detailLevel: 'visible', content: 'Bram wears a torn red woolen coat today', knownBy: [], supersedesFactId: orig.id }],
      });
      applyMemoryDelta(handlerDeps(), story.id, null, delta);

      const live = app.memory.listFacts(bram.id);
      expect(live).toHaveLength(1);
      expect(live[0].content).toContain('torn');
      expect(live[0].supersedesId).toBe(orig.id);
    });
  });
});
