import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { strong: { provider: 'anthropic', model: 'm' }, cheap: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'strong', npc: 'cheap', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
});

// Editing/deleting any past message: text edits land in place, an emptied
// exchange drops the whole turn, and memory is never touched.
describe('transcript message edit & delete', () => {
  let app: App;
  let dir: string;
  let storyId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-turnedit-'));
    app = createApp(config, { dbPath: join(dir, 't.db'), startWorker: false });
    storyId = app.stories.createStory({ title: 'Edit me' }).id;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('setTurnText rewrites player input and narration in place', () => {
    const t = app.stories.appendTurn({ storyId, playerInput: 'I knock.' });
    app.stories.updateTurn(t.id, { narration: 'The door creaks open.', status: 'complete' });

    app.stories.setTurnText(t.id, { playerInput: 'I pound on the door.' });
    app.stories.setTurnText(t.id, { narration: 'It flies open with a bang.' });

    const after = app.stories.getTurn(t.id)!;
    expect(after.playerInput).toBe('I pound on the door.');
    expect(after.narration).toBe('It flies open with a bang.');
  });

  it('deleting a turn removes it and its transcript messages but not memory', () => {
    const obj = app.memory.createObject({ storyId, type: 'character', name: 'Guard', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const fact = app.memory.addFact({ objectId: obj.id, category: 'state', detailLevel: 'known', content: 'On duty.', confidence: 1 });
    const session = app.agents.ensureSession(storyId, 'storyteller', 'strong');
    const t = app.stories.appendTurn({ storyId, playerInput: 'hi' });
    app.stories.updateTurn(t.id, { narration: 'hello', status: 'complete' });
    app.agents.appendMessage(session.id, { role: 'user', content: 'hi', turnId: t.id });
    app.agents.appendMessage(session.id, { role: 'assistant', content: 'hello', turnId: t.id });

    app.stories.deleteTurn(t.id);
    app.agents.deleteMessagesForTurn(t.id);

    expect(app.stories.getTurn(t.id)).toBeUndefined();
    expect(app.agents.countMessages(session.id)).toBe(0);
    // Memory is untouched — the whole point of the accepted-staleness contract.
    expect(app.memory.getObject(obj.id)).toBeDefined();
    expect(app.memory.getFact(fact.id)).toBeDefined();
  });
});
