import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createStoryStore } from '../src/db/stores/storyStore.ts';
import { createSummaryStore } from '../src/db/stores/summaryStore.ts';
import { createMemoryStore } from '../src/db/stores/memoryStore.ts';
import { createContextBuilder } from '../src/orchestrator/contextBuilder.ts';
import { estimateTokens } from '../src/util/tokens.ts';

describe('contextBuilder v2/v3', () => {
  let db: Db;
  let stories: ReturnType<typeof createStoryStore>;
  let summaries: ReturnType<typeof createSummaryStore>;
  let memory: ReturnType<typeof createMemoryStore>;
  let build: ReturnType<typeof createContextBuilder>;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    stories = createStoryStore(db);
    summaries = createSummaryStore(db);
    memory = createMemoryStore(db);
    build = createContextBuilder({ stories, summaries, memory });
  });
  afterEach(() => db.close());

  it('v2: prompt stays bounded as turn count grows (only last K raw turns)', () => {
    const story = stories.createStory({ title: 'Long', settings: { premise: 'A long tale.' } });
    // 60 turns, each with sizeable narration.
    for (let i = 0; i < 60; i++) {
      const t = stories.appendTurn({ storyId: story.id, playerInput: `player action ${i}` });
      stories.updateTurn(t.id, { narration: `Narration paragraph number ${i}. `.repeat(20), status: 'complete' });
    }
    const fresh = stories.getStory(story.id)!;
    const ctx = build.forStoryteller(fresh, 'what now?');
    // Default K=6 → at most 6*2 + 1 messages.
    expect(ctx.messages.length).toBeLessThanOrEqual(13);
    // Earliest turns must NOT appear verbatim.
    const joined = ctx.messages.map((m) => m.content).join('\n');
    expect(joined).not.toContain('player action 0');
    expect(joined).toContain('player action 59');
  });

  it('v2: digest and scene summary are injected into the system prompt', () => {
    const story = stories.createStory({ title: 'S', settings: { premise: 'P' } });
    const fresh = stories.getStory(story.id)!;
    summaries.upsertStoryDigest(story.id, 'DIGEST: the hero seeks the crown.', 0);
    summaries.upsertSceneSummary(story.id, fresh.currentSceneId!, 'SCENE: they stand in the throne room.', 0);
    const ctx = build.forStoryteller(stories.getStory(story.id)!, 'look around');
    expect(ctx.system).toContain('DIGEST: the hero seeks the crown.');
    expect(ctx.system).toContain('SCENE: they stand in the throne room.');
  });

  it('v3: a relevant memory fact is injected even if absent from summaries', () => {
    const story = stories.createStory({ title: 'M', settings: { premise: 'P' } });
    const obj = memory.createObject({ storyId: story.id, type: 'item', name: 'the Obsidian Key', aliases: [], summary: '', salience: 0.9, status: 'active' });
    memory.addFact({ objectId: obj.id, category: 'properties', detailLevel: 'hidden', content: 'The Obsidian Key opens the vault beneath the chapel.', confidence: 1 });
    const ctx = build.forStoryteller(stories.getStory(story.id)!, 'I examine the Obsidian Key');
    // Storyteller scope sees even the hidden fact via the retrieved-memory block.
    expect(ctx.system).toContain('opens the vault beneath the chapel');
  });

  it('v3: prompt remains within a sane budget with memory + summaries', () => {
    const story = stories.createStory({ title: 'B', settings: { premise: 'P' } });
    summaries.upsertStoryDigest(story.id, 'x '.repeat(2000), 0);
    for (let i = 0; i < 20; i++) {
      const o = memory.createObject({ storyId: story.id, type: 'lore', name: `Lore ${i}`, aliases: [], summary: '', salience: 0.5, status: 'active' });
      memory.addFact({ objectId: o.id, category: 'history', detailLevel: 'visible', content: `Lore fact ${i} `.repeat(30), confidence: 1 });
    }
    const ctx = build.forStoryteller(stories.getStory(story.id)!, 'Lore 3 and Lore 4');
    const total = estimateTokens(ctx.system) + ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(total).toBeLessThan(10_000); // budgets keep it flat, not proportional to memory size
  });
});
