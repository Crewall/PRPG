import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { runPlayerInterview } from '../src/orchestrator/playerIntake.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// Interviewer: one question, then a finished dossier for "Kael".
function intakeDriver(): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req) {
      let text = '...';
      if (req.system.includes('Character Interviewer')) {
        const user = req.messages[req.messages.length - 1]?.content ?? '';
        if (user.includes('(no questions asked yet')) {
          text = JSON.stringify({ done: false, nextQuestion: 'Who are you, and what brings you to the frontier?' });
        } else {
          text = JSON.stringify({
            done: true,
            playerName: 'Kael',
            delta: {
              newObjects: [{ tempId: 'pc', type: 'character', name: 'Kael', aliases: [], summary: 'A disgraced cartographer seeking redemption.' }],
              newFacts: [
                { objectId: 'pc', category: 'personality', detailLevel: 'known', tier: 'major', content: 'Methodical and stubborn', confidence: 0.9, knownBy: ['player'] },
                { objectId: 'pc', category: 'appearance', detailLevel: 'visible', tier: 'major', content: 'Weathered coat covered in map tubes', confidence: 0.9, knownBy: ['player'] },
                { objectId: 'pc', category: 'inventory', detailLevel: 'visible', tier: 'mid', content: 'Carries surveying tools and climbing gear', confidence: 0.9, knownBy: ['player'] },
                { objectId: 'pc', category: 'abilities', detailLevel: 'known', tier: 'mid', content: 'Expert climber and mapmaker; poor liar', confidence: 0.9, knownBy: ['player'] },
                { objectId: 'pc', category: 'state', detailLevel: 'visible', tier: 'mid', content: 'Road-worn but healthy', confidence: 0.9, knownBy: ['player'] },
                { objectId: 'pc', category: 'goals', detailLevel: 'known', tier: 'major', content: 'Wants to chart the pass no one returned from', confidence: 0.9, knownBy: ['player'] },
              ],
              salienceUpdates: [],
              mergeSuggestions: [],
            },
          });
        }
      }
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

describe('player dossier interview', () => {
  let dir: string;
  let app: App;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-pc-'));
    app = createApp(config, { driverFactory: () => intakeDriver(), dbPath: join(dir, 't.db'), startWorker: false });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps() {
    const { db, stories, summaries, agents, threadLog, registry, events, memory, suggestions, jobs } = app;
    return { db, stories, summaries, agents, threadLog, registry, events, memory, suggestions, jobs };
  }

  it('asks, then creates the player character and marks it on the story', async () => {
    const story = app.stories.createStory({ title: 'PC', settings: { premise: 'The frontier.' } });

    const r1 = await runPlayerInterview(deps(), story.id, []);
    expect(r1.done).toBe(false);
    if (!r1.done) {
      expect(r1.question).toContain('Who are you');
      expect(r1.round).toBe(1);
    }

    const r2 = await runPlayerInterview(deps(), story.id, [{ question: 'Who are you?', answer: 'Kael, a disgraced cartographer.' }]);
    expect(r2.done).toBe(true);
    if (r2.done) expect(r2.name).toBe('Kael');

    // The story now knows its player character…
    const updated = app.stories.getStory(story.id)!;
    const pcId = updated.settings.playerObjectId!;
    expect(pcId).toBeTruthy();
    // …with a full sheet, all of it known to the player.
    const facts = app.memory.listFacts(pcId);
    expect(new Set(facts.map((f) => f.category))).toEqual(new Set(['personality', 'appearance', 'inventory', 'abilities', 'state', 'goals']));
    const view = app.memory.getObjectView(pcId, { kind: 'player' })!;
    expect(view.facts.length).toBe(6);

    // The interviewer ran on its own agent thread.
    expect(app.agents.listSessions(story.id).some((s) => s.role === 'player_intake')).toBe(true);
    // And the storyteller context now carries the PC sheet.
    expect(updated.settings.playerObjectId).toBe(pcId);
  });
});
