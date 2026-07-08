import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Storyteller } from '../src/agents/storyteller.ts';
import { callJson, JsonCallError } from '../src/llm/jsonCall.ts';
import { scriptedDriver, asBound } from './fixtures/drivers.ts';
import type { ThreadLog } from '../src/db/stores/threadLog.ts';
import type { AgentSession } from '../src/domain.ts';

// An empty (0-token) model reply must never be treated as a finished response:
// the agent retries, and only after the retries are exhausted does the call
// fail (so the turn is marked error, not complete-with-nothing).

const session: AgentSession = { id: 's1', storyId: 'st1', role: 'storyteller', npcObjectId: null, modelProfile: 'test', state: 'active' };
const threadLog = { log() {} } as unknown as ThreadLog;

function storyteller(replies: string[]) {
  return new Storyteller({ session, bound: asBound(scriptedDriver(replies)), threadLog, storyId: 'st1' });
}

describe('empty reply handling (free-text invoke)', () => {
  it('retries an empty reply and returns the eventual text', async () => {
    const agent = storyteller(['', '   \n', 'You step into the hall.']);
    const deltas: string[] = [];
    const text = await agent.narrate({ system: 's', messages: [{ role: 'user', content: 'go' }] }, (d) => deltas.push(d));
    expect(text).toBe('You step into the hall.');
    // Whitespace deltas from failed attempts may leak, but the real text streams once.
    expect(deltas.join('').trim()).toBe('You step into the hall.');
  });

  it('fails the call when every attempt comes back empty', async () => {
    const agent = storyteller(['', '', '']);
    await expect(agent.narrate({ system: 's', messages: [{ role: 'user', content: 'go' }] })).rejects.toThrow(/empty reply/);
  });
});

describe('empty reply handling (JSON calls)', () => {
  const Schema = z.object({ ok: z.boolean() });

  it('re-requests on an empty reply without burning the repair round', async () => {
    // '{' is what the Anthropic prefill yields on an empty completion.
    const bound = asBound(scriptedDriver(['{', 'not json at all', '{"ok": true}']));
    const out = await callJson(bound, { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema);
    expect(out.ok).toBe(true);
  });

  it('fails after exhausting empty retries', async () => {
    const bound = asBound(scriptedDriver(['', '{', '']));
    await expect(callJson(bound, { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema)).rejects.toBeInstanceOf(JsonCallError);
  });
});
