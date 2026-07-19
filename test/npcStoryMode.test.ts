import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { StorySettings } from '../src/domain.ts';
import { mentionsNpc, shouldInvokeNpc } from '../src/orchestrator/npcRound.ts';
import { npcEnter } from '../src/orchestrator/npc.ts';
import type { NpcProfile } from '../src/db/stores/npcProfileStore.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'cheap', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

function emitter(): TurnEmitter {
  return { accepted() {}, status() {}, delta() {}, final() {}, rejected() {}, error() {} };
}

/**
 * Deterministic driver for NPC Story Mode turns. Distinguishes the call by the
 * system prompt: NPC round calls carry the npc-story template ("private notes"),
 * the storyteller call everything else. Marta engages; Old Tom stays silent.
 */
function modeDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const sys = req.system ?? '';
      const reply = (text: string) => ({ text, usage: { inputTokens: 5, outputTokens: 10 }, model: req.model });
      if (sys.includes('Your private notes')) {
        const name = /You are \*\*(.+?)\*\*/.exec(sys)?.[1] ?? '?';
        if (name === 'Marta') {
          return reply(
            JSON.stringify({
              dialogue: 'Not here. Back room.',
              intent: 'slip the ledger under the counter',
              innerState: 'nervous',
              // Message count varies per turn (witnessed block appears from
              // turn 2 on) — makes notes distinguishable across turns.
              notes: `- I hid the ledger\n- context had ${req.messages.length} message(s)`,
            }),
          );
        }
        return reply(JSON.stringify({ dialogue: '', notes: '' })); // silent Old Tom
      }
      const text =
        `The taproom hushes. [roundBlock:${sys.includes('The characters act this round')}]` +
        ` [heardMarta:${sys.includes('Not here. Back room.')}]` +
        ` [consultOffer:${sys.includes('you may consult them')}]`;
      if (onDelta) for (const ch of text.match(/.{1,16}/g) ?? []) onDelta(ch);
      return reply(text);
    },
  };
}

describe('NPC Story Mode', () => {
  describe('settings', () => {
    it('is off by default and round-trips through the schema', () => {
      const def = StorySettings.parse({});
      expect(def.npcStories.enabled).toBe(false);
      expect(def.npcStories.notesTokens).toBe(300);
      const on = StorySettings.parse({ npcStories: { enabled: true } });
      expect(on.npcStories.enabled).toBe(true);
      expect(on.npcStories.maxNpcsPerRound).toBe(4); // defaults fill in
    });
  });

  describe('mechanical skip gate', () => {
    const marta = { name: 'Marta', aliases: ['the barmaid'] };
    const profile = (patch: Partial<NpcProfile>): NpcProfile => ({
      objectId: 'o1', storyId: 's1', personality: 'gruff', notes: '- x',
      lastPresentTurnIdx: -1, lastActedTurnIdx: -1, createdAt: 0, updatedAt: 0, ...patch,
    });

    it('matches names, aliases and distinctive words — with word boundaries', () => {
      expect(mentionsNpc('I wave to Marta.', marta)).toBe(true);
      expect(mentionsNpc('I ask the barmaid for ale.', marta)).toBe(true);
      expect(mentionsNpc('Nothing about her here.', marta)).toBe(false);
      const tom = { name: 'Old Tom', aliases: [] };
      expect(mentionsNpc('Tom nods.', tom)).toBe(true);
      expect(mentionsNpc('tomorrow we ride', tom)).toBe(false); // boundary, not substring
    });

    it('invokes when there is something new for the NPC, skips otherwise', () => {
      const base = { obj: marta, playerInput: 'I stare at the fire.', lastNarration: 'Rain drums the roof.', turnIndex: 5 };
      // No mind yet → must act.
      expect(shouldInvokeNpc({ ...base, profile: undefined })).toBe(true);
      expect(shouldInvokeNpc({ ...base, profile: profile({ personality: '' }) })).toBe(true);
      // Just (re-)entered.
      expect(shouldInvokeNpc({ ...base, profile: profile({ lastPresentTurnIdx: 2 }) })).toBe(true);
      // Addressed by the player / put in play by the narrator.
      expect(shouldInvokeNpc({ ...base, playerInput: 'Marta, another round!', profile: profile({ lastPresentTurnIdx: 4 }) })).toBe(true);
      expect(shouldInvokeNpc({ ...base, lastNarration: 'Marta eyes the stranger.', profile: profile({ lastPresentTurnIdx: 4 }) })).toBe(true);
      // Conversation in flight.
      expect(shouldInvokeNpc({ ...base, profile: profile({ lastPresentTurnIdx: 4, lastActedTurnIdx: 4 }) })).toBe(true);
      // Present, established, unaddressed, idle → nothing new, skip.
      expect(shouldInvokeNpc({ ...base, profile: profile({ lastPresentTurnIdx: 4, lastActedTurnIdx: 1 }) })).toBe(false);
    });
  });

  describe('pipeline integration', () => {
    let dir: string;
    let app: App;
    let storyId: string;
    let martaId: string;
    let tomId: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'prpg-npcmode-'));
      app = createApp(config, { driverFactory: () => modeDriver(), dbPath: join(dir, 't.db'), startWorker: false });
      const story = app.stories.createStory({ title: 'Flagon', settings: { npcStories: { enabled: true, notesTokens: 300, presentTurns: 4, maxNpcsPerRound: 4 } } });
      storyId = story.id;
      martaId = app.memory.createObject({ storyId, type: 'character', name: 'Marta', aliases: [], summary: '', salience: 0.5, status: 'active' }).id;
      tomId = app.memory.createObject({ storyId, type: 'character', name: 'Old Tom', aliases: [], summary: '', salience: 0.5, status: 'active' }).id;
      app.npcProfiles.upsert(storyId, martaId, { personality: 'Sharp-tongued, protective of her regulars.', notes: '- The ledger is hidden' });
      app.npcProfiles.upsert(storyId, tomId, { personality: 'Taciturn drunk.', notes: '- Prefers to be left alone' });
      app.stories.setActiveNpcs(story.currentSceneId!, [martaId, tomId]);
    });
    afterEach(() => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('runs NPCs first and weaves their replies in a single live storyteller pass', async () => {
      const turn = await app.pipeline.run(storyId, 'Marta, where is the ledger? Tom, you saw nothing.', emitter());
      expect(turn?.status).toBe('complete');
      // The storyteller saw the round block with Marta's words, and no consult offer.
      expect(turn?.narration).toContain('[roundBlock:true]');
      expect(turn?.narration).toContain('[heardMarta:true]');
      expect(turn?.narration).toContain('[consultOffer:false]');
      expect(turn?.meta.storytellerCalls).toBe(1);
      // Presence stamped for the excerpt builder.
      expect(turn?.meta.presentNpcIds).toEqual(expect.arrayContaining([martaId, tomId]));
      // Marta acted: notes rewritten, acted-marker set. Tom stayed silent: notes kept.
      const marta = app.npcProfiles.get(martaId)!;
      expect(marta.notes).toContain('I hid the ledger');
      expect(marta.lastActedTurnIdx).toBe(turn!.index);
      expect(marta.lastPresentTurnIdx).toBe(turn!.index);
      const tom = app.npcProfiles.get(tomId)!;
      expect(tom.notes).toBe('- Prefers to be left alone');
      expect(tom.lastActedTurnIdx).toBe(-1);
      expect(tom.lastPresentTurnIdx).toBe(turn!.index);
    });

    it('bypasses the memory scribe but keeps the story scribe', async () => {
      await app.pipeline.run(storyId, 'Marta! Tom!', emitter());
      const types = app.db.prepare(`SELECT type FROM jobs`).all<{ type: string }>().map((r) => r.type);
      expect(types).toContain('scribe_story');
      expect(types).not.toContain('scribe_memory');
    });

    it('isolates NPCs: one mind never sees another NPC\'s notes', async () => {
      await app.pipeline.run(storyId, 'Marta and Tom, listen up.', emitter());
      const npcRequests = app.threadLog.query(storyId, { role: 'npc' }).filter((l) => l.direction === 'request');
      expect(npcRequests.length).toBeGreaterThanOrEqual(2);
      for (const req of npcRequests) {
        const sys = (req.payload as { system: string }).system;
        if (sys.includes('You are **Marta**')) expect(sys).not.toContain('Prefers to be left alone');
        if (sys.includes('You are **Old Tom**')) expect(sys).not.toContain('The ledger is hidden');
      }
    });

    it('skips an idle NPC on later rounds and shows them as present-but-quiet', async () => {
      // Turn 1: both addressed. Tom stays silent (driver), so he has never "acted".
      await app.pipeline.run(storyId, 'Marta and Tom, hello.', emitter());
      // Turn 2: only Marta is in play (player + last narration never mention Tom).
      await app.pipeline.run(storyId, 'Marta, pour me one.', emitter());
      const npcRequests = app.threadLog.query(storyId, { role: 'npc' }).filter((l) => l.direction === 'request');
      const tomCalls = npcRequests.filter((l) => (l.payload as { system: string }).system.includes('You are **Old Tom**'));
      expect(tomCalls).toHaveLength(1); // turn 1 only — turn 2 was skipped
      // The storyteller still knows he is there.
      const stRequests = app.threadLog.query(storyId, { role: 'storyteller' }).filter((l) => l.direction === 'request');
      const lastSys = (stRequests[0].payload as { system: string }).system; // query is newest-first
      expect(lastSys).toContain('not engaging this round');
      expect(lastSys).toContain('Old Tom');
    });

    it('gives the excerpt witnessed turns and truncates oversized notes', async () => {
      await app.pipeline.run(storyId, 'Marta, talk to me.', emitter());
      const before = app.npcProfiles.get(martaId)!.notes;
      await app.pipeline.run(storyId, 'Marta, go on.', emitter());
      const after = app.npcProfiles.get(martaId)!.notes;
      // The witnessed-turns block appeared in round 2, changing the message count.
      expect(after).not.toBe(before);
      const martaReqs = app.threadLog
        .query(storyId, { role: 'npc' })
        .filter((l) => l.direction === 'request' && (l.payload as { system: string }).system.includes('You are **Marta**'));
      const round2 = martaReqs[0].payload as { messages: { content: string }[] }; // newest first
      expect(round2.messages.some((m) => m.content.includes('Recent moments you witnessed'))).toBe(true);
      // Notes cap: server-side truncation to notesTokens.
      app.stories.updateStory(storyId, { settings: { npcStories: { enabled: true, notesTokens: 10, presentTurns: 4, maxNpcsPerRound: 4 } } });
      await app.pipeline.run(storyId, 'Marta, once more.', emitter());
      const clamped = app.npcProfiles.get(martaId)!.notes;
      expect(clamped.length).toBeLessThanOrEqual(10 * 4 + 2); // tokens×4 chars + ellipsis
    });

    it('rewind restores the pre-turn notes', async () => {
      await app.pipeline.run(storyId, 'Marta, first.', emitter());
      const afterTurn1 = app.npcProfiles.get(martaId)!.notes;
      await app.pipeline.run(storyId, 'Marta, second.', emitter());
      expect(app.npcProfiles.get(martaId)!.notes).not.toBe(afterTurn1);
      const r = await app.pipeline.rewind(storyId);
      expect(r.restored).toBe(true);
      expect(app.npcProfiles.get(martaId)!.notes).toBe(afterTurn1);
    });

    it('npc_enter with an unknown name creates the roster object and queues a seed', () => {
      const deps = { stories: app.stories, agents: app.agents, memory: app.memory, npcProfiles: app.npcProfiles, jobs: app.jobs, registry: app.registry, events: app.events };
      expect(npcEnter(deps, storyId, 'Guard Captain Held')).toBe(true);
      const obj = app.memory.findByName(storyId, 'Guard Captain Held');
      expect(obj).toBeDefined();
      expect(app.npcProfiles.get(obj!.id)).toBeDefined();
      const types = app.db.prepare(`SELECT type, payload_json FROM jobs WHERE type = 'npc_seed'`).all<{ type: string; payload_json: string }>();
      expect(types.some((j) => JSON.parse(j.payload_json).objectId === obj!.id)).toBe(true);
    });

    it('npc_seed converts an existing fact sheet mechanically (no LLM)', async () => {
      const heldId = app.memory.createObject({ storyId, type: 'character', name: 'Held', aliases: [], summary: 'The guard captain.', salience: 0.5, status: 'active' }).id;
      app.memory.addFact({ objectId: heldId, category: 'personality', detailLevel: 'visible', content: 'Brusque and by-the-book.', confidence: 1 });
      app.memory.addFact({ objectId: heldId, category: 'goals', detailLevel: 'known', content: 'Wants the ledger thief found.', confidence: 1 });
      app.memory.linkKnowledge(
        app.memory.listFacts(heldId).find((f) => f.category === 'goals')!.id,
        { type: 'npc', npcObjectId: heldId },
      );
      app.jobs.enqueue('npc_seed', { storyId, payload: { objectId: heldId } });
      await app.worker.drain();
      const profile = app.npcProfiles.get(heldId)!;
      expect(profile.personality).toContain('Brusque and by-the-book');
      expect(profile.notes).toContain('Wants the ledger thief found');
    });
  });
});
