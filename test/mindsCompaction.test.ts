import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mindsHarness, round, fail } from './fixtures/minds.ts';
import type { MindsHarness } from './fixtures/minds.ts';
import { planCompaction, logTokens } from '../src/minds/compaction.ts';
import type { ChatRequest } from '../src/llm/types.ts';

// Thread compaction (docs/10 §8.4): a thread over its threshold gets its oldest
// half folded into a recap by a Light-tier compactor, after the round.

describe('thread compaction', () => {
  let h: MindsHarness;
  beforeEach(() => {
    h = mindsHarness();
  });
  afterEach(() => h.close());

  const setMinds = (patch: Record<string, unknown>) => {
    const s = h.app.stories.getStory(h.storyId)!.settings.minds;
    h.app.stories.updateStory(h.storyId, { settings: { minds: { ...s, ...patch } } });
  };
  const compactJobs = () =>
    h.app.db
      .prepare(`SELECT json_extract(payload_json, '$.sessionId') AS sid FROM jobs WHERE type = 'minds_compact' AND status = 'pending' ORDER BY created_at`)
      .all<{ sid: string }>()
      .map((r) => r.sid);
  const recapOld = (sessionId: string) =>
    h.app.db.prepare(`SELECT content FROM agent_messages WHERE session_id = ? AND kind = 'recap_old'`).all<{ content: string }>(sessionId).map((r) => r.content);
  /** A compactor reply chosen by whose thread it is. */
  const compactor = (byWho: Record<string, unknown>) => (req: ChatRequest) => {
    const ask = req.messages[0].content;
    const who = Object.keys(byWho).find((k) => ask.includes(k)) ?? '';
    return JSON.stringify(byWho[who] ?? { recap: 'Nothing much.' });
  };
  const SAY = 'Rooms are two silver, stranger, and the stew is extra; we do not ask questions here and we do not answer them either.';

  /** Opening + two full rounds where Marta and Tom both act. */
  const playTwoRounds = async () => {
    await h.opening();
    h.script.characters['Marta'] = [
      JSON.stringify({ say: SAY, intent: 'hide the ledger', remember: [{ text: 'Never show anyone the ledger.', tags: [] }, { text: 'Kael asks too much.', tags: ['#kael'] }] }),
      JSON.stringify({ say: 'Upstairs, second door.', intent: 'hand over a key' }),
    ];
    h.script.characters['Tom'] = [JSON.stringify({ say: '', intent: 'watch' }), JSON.stringify({ say: '', intent: 'watch' })];
    h.script.narrator.push(round('She quotes a price.', { briefs: { '#marta': 'He listens.', '#tom': 'Marta quotes a price.' }, tags: ['ledger'] }));
    await h.play('"A room, please."');
    h.script.narrator.push(round('She hands you a key.', { briefs: { '#marta': 'He takes the key.', '#tom': 'A key changes hands.' } }));
    const c = await h.play('"I will take it."');
    return c;
  };

  it('plans the fold: only over the threshold, oldest half, whole rounds, the newest round kept', async () => {
    await playTwoRounds();
    const marta = h.sessionOf(h.idOf('Marta'));
    const log = h.app.threads.log(marta);
    expect(log.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    setMinds({ characterLogTokens: logTokens(log) }); // at the threshold: fine
    expect(planCompaction(h.app as never, h.storyId, marta)).toBeUndefined();
    setMinds({ characterLogTokens: 10 });
    const plan = planCompaction(h.app as never, h.storyId, marta)!;
    expect(plan.kind).toBe('character');
    expect(plan.fold.map((m) => m.id)).toEqual(log.slice(0, 2).map((m) => m.id));
    expect(plan.keep.map((m) => m.id)).toEqual(log.slice(2).map((m) => m.id));
    // One round only: nothing can be folded (the newest round always stays).
    const narrator = h.narratorSession();
    setMinds({ narratorLogTokens: 1 });
    expect(planCompaction(h.app as never, h.storyId, narrator)!.fold).toHaveLength(4); // 3 rounds: the oldest two hold half
  });

  it('a character thread over its threshold is folded into a first-person recap after the round', async () => {
    setMinds({ characterLogTokens: 60 });
    await playTwoRounds();
    const martaId = h.idOf('Marta');
    const marta = h.sessionOf(martaId);
    const narrator = h.narratorSession();
    const queued = compactJobs();
    expect(queued).toContain(marta);
    expect(queued).not.toContain(narrator); // 32k default: far from it
    const before = h.app.threads.log(marta);

    h.script.compactor.push(
      ...queued.map(() =>
        compactor({
          '#marta Marta': { recap: 'A tall stranger, Kael, came in from the rain and asked for a room. I named my price and kept the ledger out of sight.', pins: [{ text: 'Kael is not who he says he is.', tags: ['#kael'] }] },
        }),
      ),
    );
    await h.app.worker.drain();

    // What the compactor read: the oldest round only, labelled, in a fixed system prompt.
    const req = h.requests('compactor').find((r) => r.messages[0].content.includes('#marta Marta'))!;
    expect(req.system).toContain('You fold the oldest part');
    const ask = req.messages[0].content;
    expect(ask).toContain('This is the thread of #marta Marta, a character. Write the recap in their voice, first person.');
    expect(ask).toContain('[Round — what you were told]');
    expect(ask).toContain(`[Your reply]\n${before[1].content}`);
    expect(ask).not.toContain('Upstairs, second door.'); // the newest round stays live
    expect(ask).not.toContain('earlier recap');

    // The thread now: recap + the newest round; folded rows kept but flagged.
    const recap = h.app.threads.recap(marta)!;
    expect(recap.content).toMatch(/^What you remember from earlier \(your older rounds, in your own words\):\nA tall stranger, Kael/);
    expect(recap.content).toContain('Always on your mind:\nt1 · Day 1, 08:15 Never show anyone the ledger.');
    expect(recap.content).toContain('Your tags so far: #kael');
    expect(h.app.threads.log(marta).map((m) => m.id)).toEqual(before.slice(2).map((m) => m.id));
    // The proposed pin is a new pinned thought, shown on the next turn so Marta can keep or forget it.
    const pins = h.app.thoughts.list(h.storyId, martaId).filter((t) => t.source === 'compactor');
    expect(pins.map((t) => `${t.text}|${t.pinned}`)).toEqual(['Kael is not who he says he is.|true']);

    // The next call: recap first, then the live log, then the new round message.
    h.script.characters['Marta'].push(JSON.stringify({ say: 'Goodnight.' }));
    h.script.characters['Tom'].push(JSON.stringify({ say: '' }));
    h.script.narrator.push(round('Night falls.', { briefs: {} }));
    await h.play('"Goodnight."');
    const next = h.requests('character:Marta').at(-1)!;
    expect(next.messages).toHaveLength(3);
    expect(next.messages[0].content).toBe(`${recap.content}\n\n${before[2].content}`);
    expect(next.messages[1].content).toBe(before[3].content);
    const roundMsg = next.messages[2].content;
    expect(roundMsg).toMatch(/Always on your mind:\nt3 · Day 1, \d\d:\d\d \[#kael\] Kael is not who he says he is\./);
    expect(roundMsg).not.toContain('Never show anyone the ledger'); // restated in the recap, not repeated
  });

  it('a second compaction folds the old recap in; the narrator gets a third-person recap with the roster', async () => {
    setMinds({ narratorLogTokens: 50 });
    await h.opening();
    h.script.characters['Marta'] = [JSON.stringify({ say: 'Yes?' }), JSON.stringify({ say: 'Well?' })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' }), JSON.stringify({ say: '' })];
    h.script.narrator.push(round('Marta looks up from the counter.', { briefs: {}, notes: { remember: [{ text: 'Marta owes the smugglers money.', tags: [] }] } }));
    await h.play('"Evening."');
    const narrator = h.narratorSession();
    expect(compactJobs()).toEqual([narrator]);
    h.script.compactor.push(compactor({ "narrator's thread": { recap: 'Kael arrived at the Broken Wheel in the rain; Marta and Tom were there.' } }));
    await h.app.worker.drain();

    const ask = h.requests('compactor')[0].messages[0].content;
    expect(ask).toContain("This is the narrator's thread. Write the recap in the third person.");
    expect(ask).toContain("[The narrator's reply]\nRain hammers the Broken Wheel.");
    expect(ask).not.toContain('"briefs"'); // the hidden blocks are left out
    const first = h.app.threads.recap(narrator)!;
    expect(first.content).toContain('The story so far (the older rounds, summarised):\nKael arrived');
    expect(first.content).toContain('Characters so far:\n- #kael Kael (the player character) — Tall, rain-soaked.\n- #marta Marta — Stout, flour on her apron.\n- #tom Tom — Thin, nervous.');
    expect(first.content).toContain('Your pinned notes:\nt1 · Day 1, 08:15 Marta owes the smugglers money.');

    h.script.narrator.push(round('Tom coughs.', { briefs: {} }));
    await h.play('"Quiet night?"');
    expect(compactJobs()).toEqual([narrator]);
    h.script.compactor.push(compactor({ "narrator's thread": { recap: 'Kael arrived; Marta greeted him; Tom coughed.' } }));
    await h.app.worker.drain();
    expect(h.requests('compactor')[1].messages[0].content).toContain(`The earlier recap (fold it in):\n${first.content}`);
    expect(recapOld(narrator)).toEqual([first.content]);
    expect(h.app.threads.recap(narrator)!.content).toContain('Kael arrived; Marta greeted him; Tom coughed.');
  });

  it('rewind undoes a compaction with the turn that triggered it', async () => {
    setMinds({ characterLogTokens: 60 });
    await playTwoRounds();
    const martaId = h.idOf('Marta');
    const marta = h.sessionOf(martaId);
    const before = h.app.threads.log(marta);
    h.script.compactor.push(...compactJobs().map(() => compactor({ '#marta Marta': { recap: 'I met Kael.', pins: [{ text: 'Watch Kael.', tags: [] }] } })));
    await h.app.worker.drain();
    expect(h.app.threads.recap(marta)).toBeDefined();

    await h.app.pipeline.rewind(h.storyId);
    expect(h.app.threads.recap(marta)).toBeUndefined();
    expect(h.app.threads.log(marta).map((m) => m.id)).toEqual(before.slice(0, 2).map((m) => m.id)); // round 2 is gone, round 1 unfolded
    expect(h.app.thoughts.list(h.storyId, martaId).map((t) => t.text)).toEqual(['Never show anyone the ledger.', 'Kael asks too much.']);
  });

  it('a compaction whose turn was rewound, or whose thread moved on meanwhile, changes nothing', async () => {
    setMinds({ characterLogTokens: 60 });
    await playTwoRounds();
    const marta = h.sessionOf(h.idOf('Marta'));
    await h.app.pipeline.rewind(h.storyId); // before the job ran
    await h.app.worker.drain();
    expect(h.requests('compactor')).toHaveLength(0);
    expect(h.app.threads.recap(marta)).toBeUndefined();

    // Replay round 2; while the compactor writes, the thread changes under it.
    h.script.characters['Marta'] = [JSON.stringify({ say: SAY })];
    h.script.characters['Tom'] = [JSON.stringify({ say: '' })];
    h.script.narrator.push(round('She hands you a key.', { briefs: {} }));
    await h.play('"I will take it."');
    const first = h.app.threads.log(marta)[0];
    h.script.compactor.push(
      ...compactJobs().map(() => (req: ChatRequest) => {
        h.app.db.prepare(`UPDATE agent_messages SET compacted = 1 WHERE id = ?`).run(first.id);
        return compactor({})(req);
      }),
    );
    await h.app.worker.drain();
    expect(h.app.threads.recap(marta)).toBeUndefined();
  });

  it('a failing compactor leaves the thread as it was', async () => {
    setMinds({ characterLogTokens: 60 });
    await playTwoRounds();
    const marta = h.sessionOf(h.idOf('Marta'));
    const before = h.app.threads.log(marta).map((m) => m.id);
    h.script.compactor.push(...Array.from({ length: 12 }, () => fail('compactor down')));
    await h.app.worker.drain();
    expect(h.app.threads.recap(marta)).toBeUndefined();
    expect(h.app.threads.log(marta).map((m) => m.id)).toEqual(before);
    const failed = h.app.db.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'minds_compact' AND status = 'failed'`).get<{ n: number }>()!.n;
    expect(failed).toBeGreaterThan(0);
  });
});
