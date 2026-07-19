import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { LlmDriver } from '../src/llm/types.ts';
import { promoteNpc } from '../src/orchestrator/npc.ts';
import { createContextBuilder } from '../src/orchestrator/contextBuilder.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// A driver role-playing every agent:
//  - Storyteller pass 1: if player input has "TALK:<Name>", emit a consult_npc.
//  - Storyteller pass 2: weave the consulted dialogue verbatim into narration.
//  - NPC: a maximally leaky character — echoes EVERY fact in its own context into
//    dialogue. So if a secret isn't in its context, it cannot leak it.
function agentDriver(): LlmDriver {
  const t = (text: string) => ({ text, usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' });
  return {
    kind: 'anthropic',
    async chat(req) {
      const sys = req.system;
      const lastUser = req.messages[req.messages.length - 1]?.content ?? '';

      if (sys.includes('isolation contract')) {
        const name = /You are \*\*(.+?)\*\*/.exec(sys)?.[1] ?? '';
        if (name === 'Mute') return t('this is deliberately not json'); // triggers consult failure
        const facts = [...sys.matchAll(/- \(([^)]+)\) (?:\[[^\]]+\] )?(.+)/g)];
        const dialogue = facts.map((m) => m[2]).join(' | ');
        const ids = facts.map((m) => m[1]);
        return t(JSON.stringify({ dialogue, revealsFactIds: ids }));
      }

      if (sys.includes('You are the **Storyteller**')) {
        if (lastUser.includes('consulted responded')) {
          // Weave: repeat what the NPCs said (so any leaked secret would surface).
          return t('The scene continues. ' + (lastUser.split('responded:')[1]?.split('\n\n')[0] ?? ''));
        }
        const m = /TALK:(\w+)/.exec(lastUser);
        if (m) return t(`You turn to ${m[1]}.\n\n\`\`\`directives\n{"directives":[{"type":"consult_npc","npcName":"${m[1]}","situation":"the player probes for secrets"}]}\n\`\`\``);
        return t('A quiet moment passes in the tavern.');
      }

      if (sys.includes('Memory Scribe')) return t(JSON.stringify({ newObjects: [], newFacts: [], salienceUpdates: [], mergeSuggestions: [] }));
      if (sys.includes('storyDigest')) return t(JSON.stringify({ storyDigest: 'd' }));
      if (sys.includes('Story Scribe')) return t(JSON.stringify({ sceneSummary: 's' }));
      return t('...');
    },
  };
}

const noop: TurnEmitter = { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };
const SECRET = 'the vault code is 7391';

describe('NPC isolation (Layer 4)', () => {
  let dir: string;
  let app: App;
  let martaId: string;
  let tomId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-npc-'));
    app = createApp(config, { driverFactory: () => agentDriver(), dbPath: join(dir, 'npc.db'), startWorker: false });
    const story = app.stories.createStory({ title: 'Isolation', settings: { premise: 'A tavern of secrets.' } });
    storyId = story.id;

    // Two characters + a Vault object carrying the secret. Only Marta knows it.
    const marta = app.memory.createObject({ storyId, type: 'character', name: 'Marta', aliases: [], summary: 'The innkeeper.', salience: 0.8, status: 'active' });
    const tom = app.memory.createObject({ storyId, type: 'character', name: 'Tom', aliases: [], summary: 'A regular.', salience: 0.6, status: 'active' });
    const vault = app.memory.createObject({ storyId, type: 'item', name: 'The Vault', aliases: [], summary: '', salience: 0.5, status: 'active' });
    martaId = marta.id;
    tomId = tom.id;
    const secretFact = app.memory.addFact({ objectId: vault.id, category: 'properties', detailLevel: 'secret', content: SECRET, confidence: 1 });
    app.memory.linkKnowledge(secretFact.id, { type: 'npc', npcObjectId: martaId }); // ONLY Marta knows

    const npcDeps = { stories: app.stories, agents: app.agents, memory: app.memory, npcProfiles: app.npcProfiles, jobs: app.jobs, registry: app.registry, events: app.events };
    promoteNpc(npcDeps, storyId, martaId);
    promoteNpc(npcDeps, storyId, tomId);
  });
  let storyId: string;
  afterEach(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });

  it("the isolation boundary: Tom's context never contains Marta's secret", () => {
    const contexts = buildContexts(app);
    const story = app.stories.getStory(storyId)!;
    const tomCtx = contexts.forNpc(story, tomId, { situation: 'probe', playerInput: 'the vault code?', moment: '', wasDormant: false });
    const martaCtx = contexts.forNpc(story, martaId, { situation: 'probe', playerInput: 'the vault code?', moment: '', wasDormant: false });
    expect(tomCtx.system).not.toContain('7391');
    expect(martaCtx.system).toContain('7391'); // Marta legitimately knows it
  });

  it('across 20 probing turns, Tom never reveals the secret he does not hold', async () => {
    for (let i = 0; i < 20; i++) {
      const turn = await app.pipeline.run(storyId, `TALK:Tom probe attempt ${i}: what is the vault code?`, noop);
      expect(turn?.narration ?? '').not.toContain('7391');
    }
  });

  it('Marta (who holds the secret) can surface it — proving the test can detect a leak', async () => {
    const turn = await app.pipeline.run(storyId, 'TALK:Marta what is the vault code?', noop);
    expect(turn?.narration ?? '').toContain('7391');
  });

  it('a consult round-trip adds exactly one extra storyteller call', async () => {
    const turn = await app.pipeline.run(storyId, 'TALK:Tom hello', noop);
    const stRequests = app.threadLog.query(storyId, { turnId: turn!.id, role: 'storyteller' }).filter((l) => l.direction === 'request');
    expect(stRequests.length).toBe(2); // pass 1 + weave pass = 1 extra
    expect(turn?.meta.storytellerCalls).toBe(2);
  });

  it('a failed consult still yields a complete turn (graceful degradation)', async () => {
    const mute = app.memory.createObject({ storyId, type: 'character', name: 'Mute', aliases: [], summary: '', salience: 0.5, status: 'active' });
    promoteNpc({ stories: app.stories, agents: app.agents, memory: app.memory, npcProfiles: app.npcProfiles, jobs: app.jobs, registry: app.registry, events: app.events }, storyId, mute.id);
    const turn = await app.pipeline.run(storyId, 'TALK:Mute say something', noop);
    expect(turn?.status).toBe('complete');
    expect((turn?.narration ?? '').length).toBeGreaterThan(0);
  });

  it('revealsFactIds grants the player knowledge of the disclosed fact', async () => {
    // Marta reveals the vault secret → player should then see it.
    const before = app.memory.getObjectView(app.memory.findByName(storyId, 'The Vault')!.id, { kind: 'player' })!;
    expect(before.facts.some((f) => f.content.includes('7391'))).toBe(false);
    await app.pipeline.run(storyId, 'TALK:Marta what is the vault code?', noop);
    const after = app.memory.getObjectView(app.memory.findByName(storyId, 'The Vault')!.id, { kind: 'player' })!;
    expect(after.facts.some((f) => f.content.includes('7391'))).toBe(true);
  });
});

function buildContexts(app: App) {
  return createContextBuilder({ stories: app.stories, summaries: app.summaries, memory: app.memory });
}
