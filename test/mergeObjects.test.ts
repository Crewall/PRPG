import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { mergeMemoryObjects } from '../src/orchestrator/memoryHandlers.ts';
import { NewMemoryObject, NewFact } from '../src/memory/model.ts';
import { scriptedDriver } from './fixtures/drivers.ts';

const obj = (o: Record<string, unknown>) => NewMemoryObject.parse(o);
const fact = (f: Record<string, unknown>) => NewFact.parse(f);

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

describe('mergeMemoryObjects (entity merge)', () => {
  let dir: string;
  let app: App;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-merge-'));
    app = createApp(config, { driverFactory: () => scriptedDriver([]), dbPath: join(dir, 'm.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    return {
      db: app.db, stories: app.stories, summaries: app.summaries, agents: app.agents, threadLog: app.threadLog,
      memory: app.memory, suggestions: app.suggestions, jobs: app.jobs, registry: app.registry, events: app.events,
    };
  }

  it('re-points facts, knowledge, scene roster, sessions and aliases; deletes the duplicate', () => {
    const story = app.stories.createStory({ title: 'T' });
    const kate = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'Kate', aliases: ['your companion'], summary: 'A sharp-eyed traveler.', salience: 0.5 }));
    const woman = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'the woman', aliases: ['the voice behind the door'], summary: '', salience: 0.9 }));
    const witness = app.memory.createObject(obj({ storyId: story.id, type: 'character', name: 'Old Tom', salience: 0.4 }));

    const f1 = app.memory.addFact(fact({ objectId: woman.id, category: 'appearance', detailLevel: 'visible', content: 'Wears a storm-grey cloak.' }));
    app.memory.linkKnowledge(f1.id, { type: 'player' });
    // Duplicate content on both objects, with a knower only on the duplicate.
    const kept = app.memory.addFact(fact({ objectId: kate.id, category: 'state', detailLevel: 'known', content: 'Kate is wounded in the left arm.' }));
    const dupe = app.memory.addFact(fact({ objectId: woman.id, category: 'state', detailLevel: 'known', content: 'Kate is wounded in her left arm.' }));
    app.memory.linkKnowledge(dupe.id, { type: 'npc', npcObjectId: witness.id });
    // The duplicate is also a KNOWER of a fact about someone else.
    const tomFact = app.memory.addFact(fact({ objectId: witness.id, category: 'history', detailLevel: 'known', content: 'Old Tom once sailed the strait.' }));
    app.memory.linkKnowledge(tomFact.id, { type: 'npc', npcObjectId: woman.id });

    // Scene roster + NPC session reference the duplicate.
    const scene = app.stories.getScene(app.stories.getStory(story.id)!.currentSceneId!)!;
    app.stories.setActiveNpcs(scene.id, [woman.id]);
    app.agents.ensureSession(story.id, 'npc', 'm', woman.id);

    expect(mergeMemoryObjects(deps(), kate.id, woman.id)).toBe(true);

    // The duplicate is gone; Kate holds its names.
    expect(app.memory.getObject(woman.id)).toBeUndefined();
    const merged = app.memory.getObject(kate.id)!;
    expect(merged.aliases).toEqual(expect.arrayContaining(['your companion', 'the woman', 'the voice behind the door']));
    expect(merged.salience).toBe(0.9);

    // Facts moved; near-duplicate superseded but its knower copied to the survivor.
    const facts = app.memory.listFacts(kate.id);
    expect(facts.map((f) => f.content)).toContain('Wears a storm-grey cloak.');
    expect(facts.find((f) => f.id === dupe.id)).toBeUndefined(); // superseded
    const links = app.memory.linksForFacts([kept.id]).get(kept.id) ?? [];
    expect(links.some((l) => l.knowerNpcObjectId === witness.id)).toBe(true);

    // Kate (as knower) inherited the merged object's knowledge of the world.
    const known = app.memory.npcKnowledge(story.id, kate.id);
    expect(known.some((k) => k.fact.id === tomFact.id)).toBe(true);

    // Scene roster and the NPC session now point at Kate.
    expect(app.stories.getScene(scene.id)!.activeNpcIds).toEqual([kate.id]);
    const sessions = app.agents.listSessions(story.id).filter((s) => s.role === 'npc');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].npcObjectId).toBe(kate.id);
  });

  it('refuses cross-story and self merges', () => {
    const s1 = app.stories.createStory({ title: 'A' });
    const s2 = app.stories.createStory({ title: 'B' });
    const a = app.memory.createObject(obj({ storyId: s1.id, type: 'character', name: 'A' }));
    const b = app.memory.createObject(obj({ storyId: s2.id, type: 'character', name: 'B' }));
    expect(mergeMemoryObjects(deps(), a.id, b.id)).toBe(false);
    expect(mergeMemoryObjects(deps(), a.id, a.id)).toBe(false);
    expect(mergeMemoryObjects(deps(), a.id, 'nope')).toBe(false);
  });
});
