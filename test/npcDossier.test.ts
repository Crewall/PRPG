import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { promoteNpc, rebuildNpcMind } from '../src/orchestrator/npc.ts';
import { createContextBuilder } from '../src/orchestrator/contextBuilder.ts';
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

    const deps = { stories: app.stories, agents: app.agents, memory: app.memory, npcProfiles: app.npcProfiles, jobs: app.jobs, registry: app.registry, events: app.events };
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

  it('parses the raw story, stores a prose portrait, and fits a full sheet (cap > 20)', async () => {
    // A driver that returns a rich dossier: 25 facts + a portrait.
    const richDriver = (): LlmDriver => ({
      kind: 'anthropic',
      async chat(req) {
        let text = '...';
        if (req.system.includes('character dossier') || req.system.includes('dossier of')) {
          const oid = /object id is `([^`]+)`/.exec(req.system)?.[1];
          text = JSON.stringify({
            portrait: 'A broad-shouldered innkeeper with a fishhook-shaped scar, voice like gravel, fiercely protective of her regulars.',
            newFacts: [
              'brews famously bitter ale', 'hums sea shanties while working', 'distrusts anyone in noble dress', 'feeds the stray cats behind the inn',
              'counts every coin twice', 'sharpens the kitchen knives nightly', 'recites old harvest prayers', 'collects smooth river stones',
              'fears deep water since childhood', 'loves violent thunderstorms', 'mends torn cloaks for regulars', 'barters fiercely with merchants',
              'naps at noon behind the bar', 'whistles perpetually off-key', 'keeps a hidden second ledger', 'waters the geraniums at dawn',
              'avoids the harbor docks entirely', 'swears in the Old Tongue when angry', 'plays knucklebones on slow nights', 'salts her food excessively',
              'remembers every unpaid debt', 'hates the smell of cheap perfume', 'trusts only the blacksmith', 'dreams aloud of the southern coast',
              'limps slightly in cold weather',
            ].map((content) => ({
              objectId: oid, category: 'personality', detailLevel: 'known', tier: 'mid', content, knownBy: [],
            })),
          });
        }
        return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
      },
    });
    const dir2 = mkdtempSync(join(tmpdir(), 'prpg-rich-'));
    const app2 = createApp(config, { driverFactory: () => richDriver(), dbPath: join(dir2, 't.db'), startWorker: false });
    const story = app2.stories.createStory({ title: 'Rich' });
    // Canon lives in raw turns, not in any summary.
    const t1 = app2.stories.appendTurn({ storyId: story.id, playerInput: 'I look at the innkeeper.' });
    app2.stories.updateTurn(t1.id, { narration: 'She turns — a scar shaped like a fishhook curls down her cheek.', status: 'complete' });
    const marta = app2.memory.createObject({ storyId: story.id, type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.7, status: 'active' });
    const deps2 = { stories: app2.stories, agents: app2.agents, memory: app2.memory, npcProfiles: app2.npcProfiles, jobs: app2.jobs, registry: app2.registry, events: app2.events };
    promoteNpc(deps2, story.id, marta.id);
    await app2.worker.drain();

    // The raised cap let the whole sheet in (old per-turn clamp was 20).
    expect(app2.memory.listFacts(marta.id).length).toBeGreaterThan(20);
    // The portrait landed on the profile.
    expect(app2.npcProfiles.get(marta.id)?.personality).toContain('fishhook-shaped scar');
    // The dossier request carried the VERBATIM story text.
    const dossierReq = app2.threadLog
      .query(story.id, { role: 'scribe_memory' })
      .filter((l) => l.direction === 'request')
      .map((l) => (l.payload as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n'))
      .find((c) => c.includes('VERBATIM'));
    expect(dossierReq).toBeDefined();
    expect(dossierReq).toContain('scar shaped like a fishhook');

    // The portrait now leads the NPC's consult persona.
    const contexts = createContextBuilder({ stories: app2.stories, summaries: app2.summaries, memory: app2.memory, npcProfiles: app2.npcProfiles });
    const ctx = contexts.forNpc(app2.stories.getStory(story.id)!, marta.id, { situation: 'greet', playerInput: 'hello', moment: '', wasDormant: false });
    expect(ctx.system).toContain('Your portrait — who you are');
    expect(ctx.system).toContain('fishhook-shaped scar');

    // Manual rebuild in structured mode re-queues a dossier pass.
    expect(rebuildNpcMind(deps2, story.id, marta.id)).toBe(true);
    expect(app2.jobs.countPending()).toBe(1);
    app2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});
