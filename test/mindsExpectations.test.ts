import { describe, it, expect, afterEach } from 'vitest';
import { mindsHarness, round } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { applyThoughtOps, opinionCeiling } from '../src/minds/service.ts';

// Keeping opinions in proportion (docs/11 §5.7b), expectations (§5.11) and the character's nature (§2.7).

describe('opinions in proportion', () => {
  let h: MindsHarness;
  afterEach(() => h.close());
  const marta = () => h.idOf('Marta');
  const kael = () => h.app.sheets.player(h.storyId)!.objectId;
  const byText = (text: string) => h.app.thoughts.list(h.storyId, marta()).find((t) => t.text === text)!;

  it('in play an opinion of someone stops at 7; above that, one more point per scene', async () => {
    h = mindsHarness();
    await h.opening();
    const opening = h.app.stories.lastTurn(h.storyId)!.id;
    const r = applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 10, text: 'He is a liar.' }] }, 'self', opening);
    expect(byText('He is a liar.').importance).toBe(7);
    expect(r.notes.join(' ')).toContain('kept at 7/10');
    // The seeder and the user aren't held: a sister's love can start at 10.
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'feeling', about: '#tom', importance: 9, text: 'Tom is family to me.' }] }, 'seed');
    expect(byText('Tom is family to me.').importance).toBe(9);
    expect(opinionCeiling(h.app, h.storyId, marta(), h.idOf('Tom'))).toBe(10);

    // Revising raises by at most 2, and never past the ceiling.
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 3, text: 'He seems tired.' }] }, 'self');
    applyThoughtOps(h.app, h.storyId, marta(), { revise: [{ id: `t${byText('He seems tired.').seq}`, text: 'He is hiding something.', importance: 9 }] }, 'self');
    expect(byText('He is hiding something.').importance).toBe(5);

    // A new scene: the ceiling for Kael rises to 8 (she held 7 before it), not further.
    h.app.pipeline.newScene(h.storyId, { title: 'Later' });
    expect(opinionCeiling(h.app, h.storyId, marta(), kael())).toBe(8);
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 10, text: 'I hate him.' }] }, 'self');
    expect(byText('I hate him.').importance).toBe(8);
  });

  it('the prompts keep views in proportion and colour them by nature', async () => {
    h = mindsHarness();
    await h.opening();
    h.app.sheets.upsert(h.storyId, marta(), { nature: 'warm, kind-hearted, gentle with everyone; slow to think ill of anyone' });
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I wait.');
    const req = h.requests('character:Marta').at(-1)!;
    expect(req.system).toContain('Your nature: warm, kind-hearted, gentle with everyone; slow to think ill of anyone');
    expect(req.system).toContain('A question left unanswered is not proof of anything');
    expect(req.system).toContain('ask one or two questions at a time');
    expect(req.messages.at(-1)!.content).toContain('Stay yourself: warm, kind-hearted, gentle with everyone; slow to think ill of anyone');
    const nar = h.requests('narrator').at(-1)!;
    expect(nar.messages.at(-1)!.content).toContain('  Nature: warm, kind-hearted, gentle with everyone; slow to think ill of anyone');
    expect(nar.system).toContain("A character's feelings and suspicions are theirs, never evidence.");
  });
});

describe('expectations', () => {
  let h: MindsHarness;
  afterEach(() => h.close());
  const marta = () => h.idOf('Marta');
  const all = () => h.app.thoughts.list(h.storyId, marta(), { includeRevoked: true });
  const pending = () => h.app.threads.pending(h.sessionOf(marta())).at(-1)!.content;
  const round2 = (reply: object) => {
    h.script.characters['Marta'] = [JSON.stringify({ say: '', ...reply })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Time passes.', { briefs: {}, spotlight: ['#marta'] }));
    return h.play('"Ask me anything."');
  };

  it('a character foresees; when it is wrong the view behind it weakens and it is told; when right, it strengthens', async () => {
    h = mindsHarness();
    await h.opening();
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 6, text: 'He is hiding something.' }] }, 'self');
    await round2({
      remember: [
        { kind: 'expectation', about: '#kael', confidence: 7, hope: 'fear', horizon: 'soon', basis: 't1', importance: 5, text: 'He will dodge my question about the ledger.' },
        { kind: 'expectation', about: '#tom', confidence: 6, hope: 'hope', horizon: 'today', importance: 4, text: 'Tom will back me up.' },
        { kind: 'expectation', confidence: 1, horizon: 'later', text: 'Maybe it rains tomorrow.' },
      ],
    });
    const [dodge, backup] = all().filter((t) => t.kind === 'expectation');
    expect([dodge.confidence, dodge.hope, dodge.horizon, dodge.basis]).toEqual([7, 'fear', 'soon', all()[0].id]);
    expect(backup.hope).toBe('hope');

    // Next round she sees them (not the 1/10 one) and says how they turned out.
    await round2({ outcomes: { [`t${dodge.seq}`]: 'missed', [`t${backup.seq}`]: 'met' } });
    const ask = h.requests('character:Marta').at(-1)!.messages.at(-1)!.content;
    expect(ask).toContain(`Your expectations (if one came true or plainly didn't, say so in "outcomes"):\nt${dodge.seq}`);
    expect(ask).toContain('expectation about #kael · fear, 7/10 sure, matters 5, soon');
    expect(ask).not.toContain('Maybe it rains tomorrow');
    expect(all().find((t) => t.id === dodge.id)!.status).toBe('missed');
    expect(all().find((t) => t.id === backup.id)!.status).toBe('met');
    expect(all()[0].importance).toBe(4); // "He is hiding something": 6 − 2
    expect(pending()).toContain("How your expectations turned out:\n- Relief: what you feared didn’t happen");
    expect(pending()).toContain('Rethink t1');
    expect(pending()).toContain('It came true, as you hoped');
  });

  it('a met expectation strengthens its basis, within the ceiling', async () => {
    h = mindsHarness();
    await h.opening();
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'opinion', about: '#kael', importance: 7, text: 'He is dangerous.' }] }, 'self');
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'expectation', about: '#kael', confidence: 8, basis: 't1', text: 'He will reach for his knife.' }] }, 'self');
    applyThoughtOps(h.app, h.storyId, marta(), { outcomes: { t2: 'met' } }, 'self');
    expect(all()[0].importance).toBe(7); // already at the scene's ceiling
  });

  it('expectations expire with their horizon, and only a few stay open', async () => {
    h = mindsHarness();
    await h.opening();
    applyThoughtOps(h.app, h.storyId, marta(), { remember: [{ kind: 'expectation', horizon: 'soon', confidence: 5, text: 'Someone will come in soon.' }] }, 'self');
    for (let i = 0; i < 3; i++) await round2({});
    expect(all().find((t) => t.text === 'Someone will come in soon.')!.status).toBe('expired');

    const many = Array.from({ length: 7 }, (_, i) => ({ kind: 'expectation', horizon: 'later', confidence: 5, importance: i + 1, text: `Guess ${i + 1}.` }));
    for (const op of many) applyThoughtOps(h.app, h.storyId, marta(), { remember: [op] }, 'user');
    const open = h.app.thoughts.list(h.storyId, marta()).filter((t) => t.kind === 'expectation');
    expect(open).toHaveLength(6);
    expect(open.map((t) => t.text)).not.toContain('Guess 1.');
  });
});

describe('nature', () => {
  let h: MindsHarness;
  afterEach(() => h.close());

  it('the seeder writes it; a character seeded before natures existed gets one from a small job', async () => {
    h = mindsHarness();
    await h.opening();
    h.script.seeder.push(
      JSON.stringify({ description: 'Marta runs the inn.', nature: 'warm, kind-hearted, gentle with everyone;\\nslow to think ill of anyone' }),
      JSON.stringify({ description: 'Tom drinks.' }),
    );
    await h.app.worker.drain();
    expect(h.app.sheets.get(h.idOf('Marta'))!.nature).toBe('warm, kind-hearted, gentle with everyone; slow to think ill of anyone');
    expect(h.app.sheets.get(h.idOf('Tom'))!.nature).toBe('');

    // Tom has a mind but no nature: the next round asks for one.
    h.script.characters['Marta'] = [JSON.stringify({ say: '' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Quiet.', { briefs: {} }));
    await h.play('I wait.');
    h.script.seeder.push(JSON.stringify({ nature: 'nervous, jumpy, easily frightened; loyal to whoever buys the drinks' }));
    await h.app.worker.drain();
    expect(h.app.sheets.get(h.idOf('Tom'))!.nature).toBe('nervous, jumpy, easily frightened; loyal to whoever buys the drinks');
    expect(h.requests('seeder').at(-1)!.messages[0].content).toContain('Their description:\nTom drinks.');
  });
});
