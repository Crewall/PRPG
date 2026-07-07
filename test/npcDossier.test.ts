import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { promoteNpc } from '../src/orchestrator/npc.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// The dossier prompt carries the character's object id; echo it back with a
// sheet covering the required categories (one duplicating an existing fact).
function dossierDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req) {
      let text = '...';
      if (req.system.includes('character dossier')) {
        const oid = /object id is `([^`]+)`/.exec(req.system)?.[1];
        text = JSON.stringify({
          newFacts: [
            { objectId: oid, category: 'personality', detailLevel: 'known', tier: 'major', content: 'Gruff but fair, softens around children', knownBy: [] },
            { objectId: oid, category: 'appearance', detailLevel: 'visible', tier: 'major', content: 'Marta wears a red scarf around her neck', knownBy: [] }, // dup of existing
            { objectId: oid, category: 'inventory', detailLevel: 'known', tier: 'mid', content: 'Carries a ring of cellar keys', knownBy: [] },
            { objectId: oid, category: 'abilities', detailLevel: 'known', tier: 'mid', content: 'Skilled brewer; poor swimmer', knownBy: [] },
            { objectId: oid, category: 'state', detailLevel: 'visible', tier: 'mid', content: 'Tired after a long night shift', knownBy: [] },
            { objectId: oid, category: 'goals', detailLevel: 'hidden', tier: 'major', content: 'Wants to buy the tavern from its absentee owner', knownBy: [] },
          ],
        });
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('NPC dossier at elevation', () => {
  let dir: string;
  let app: App;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-'));
    app = createApp(config, { driverFactory: () => dossierDriver(), dbPath: join(dir, 'test.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('first promotion builds a character sheet as memory facts (deduped)', async () => {
    const story = app.stories.createStory({ title: 'N' });
    const marta = app.memory.createObject({ storyId: story.id, type: 'character', name: 'Marta', aliases: [], summary: 'The innkeeper.', salience: 0.7, status: 'active' });
    app.memory.addFact({ objectId: marta.id, category: 'appearance', detailLevel: 'visible', tier: 'major', content: 'Marta wears a red scarf', confidence: 1 });

    const deps = { stories: app.stories, agents: app.agents, memory: app.memory, jobs: app.jobs, registry: app.registry, events: app.events };
    promoteNpc(deps, story.id, marta.id);
    await app.worker.drain();

    const facts = app.memory.listFacts(marta.id);
    const categories = new Set(facts.map((f) => f.category));
    for (const c of ['personality', 'appearance', 'inventory', 'abilities', 'state', 'goals']) expect(categories).toContain(c);
    // The near-duplicate appearance fact was NOT added twice.
    expect(facts.filter((f) => f.content.toLowerCase().includes('red scarf'))).toHaveLength(1);
    // The concealed goal stays storyteller-only.
    const playerView = app.memory.getObjectView(marta.id, { kind: 'player' })!;
    expect(playerView.facts.some((f) => f.content.includes('buy the tavern'))).toBe(false);

    // Re-promotion (e.g. npc_enter after dormancy) does not enqueue another dossier.
    promoteNpc(deps, story.id, marta.id);
    expect(app.jobs.countPending()).toBe(0);
  });
});
