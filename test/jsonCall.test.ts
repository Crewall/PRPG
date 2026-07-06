import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { callJson, extractJson, JsonCallError } from '../src/llm/jsonCall.ts';
import { scriptedDriver, asBound } from './fixtures/drivers.ts';

const Schema = z.object({ ok: z.boolean(), name: z.string() });

describe('extractJson', () => {
  it('extracts a balanced object from noisy text', () => {
    expect(extractJson('Sure! {"a": 1} done')).toBe('{"a": 1}');
  });
  it('strips code fences', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });
  it('handles braces inside strings', () => {
    expect(extractJson('{"a": "a } b"}')).toBe('{"a": "a } b"}');
  });
});

describe('callJson repair-retry', () => {
  it('returns valid JSON on first try', async () => {
    const bound = asBound(scriptedDriver(['{"ok": true, "name": "Marta"}']));
    const out = await callJson(bound, { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema);
    expect(out).toEqual({ ok: true, name: 'Marta' });
  });

  it('repairs invalid JSON on the second try', async () => {
    let attempts = 0;
    const driver = scriptedDriver(['not json at all', '{"ok": true, "name": "fixed"}']);
    const wrapped = { kind: driver.kind, chat: (req: any, onDelta: any) => { attempts++; return driver.chat(req, onDelta); } };
    const out = await callJson(asBound(wrapped as any), { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema);
    expect(out.name).toBe('fixed');
    expect(attempts).toBe(2);
  });

  it('repairs a schema-invalid reply on the second try', async () => {
    const bound = asBound(scriptedDriver(['{"ok": "yes"}', '{"ok": true, "name": "ok"}']));
    const out = await callJson(bound, { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema);
    expect(out.ok).toBe(true);
  });

  it('throws JsonCallError after two failures', async () => {
    const bound = asBound(scriptedDriver(['garbage', 'still garbage']));
    await expect(callJson(bound, { system: 's', messages: [{ role: 'user', content: 'go' }] }, Schema)).rejects.toBeInstanceOf(JsonCallError);
  });
});
