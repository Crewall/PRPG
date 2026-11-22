import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import type { TurnEmitter } from '../src/orchestrator/turnPipeline.ts';
import type { Turn } from '../src/domain.ts';
import type { ChatRequest, LlmDriver } from '../src/llm/types.ts';
import { VariableDef } from '../src/minds/variables.ts';
import { createCharacter } from '../src/minds/service.ts';
import { parsePlayerInput, splitNarratorReply, readRoundBlock, parseCharacterReply } from '../src/minds/contracts.ts';
import { chooseCallers } from '../src/minds/gate.ts';
import type { MindsDeps } from '../src/minds/service.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

// ---- A dispatching fake model: answers by agent, records every request ----
type Reply = string | ((req: ChatRequest) => string);
interface Script {
  narrator: Reply[];
  characters: Record<string, Reply[]>; // by character name
  distributor: Reply[];
  seeder: Reply[];
}
function agentOf(req: ChatRequest): string {
  if (req.system.includes('You are the **Narrator**')) return 'narrator';
  if (req.system.includes('forgot (or broke)')) return 'distributor';
  if (req.system.includes('character designer')) return 'seeder';
  const m = req.system.match(/^You are \*\*(.+?)\*\*/);
  return m ? `character:${m[1]}` : 'other';
}
function dispatchDriver(script: Script, seen: { agent: string; req: ChatRequest }[]): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const agent = agentOf(req);
      seen.push({ agent, req });
      const queue = agent === 'narrator' ? script.narrator : agent === 'distributor' ? script.distributor : agent === 'seeder' ? script.seeder : script.characters[agent.slice('character:'.length)] ?? [];
      const next = queue.shift();
      if (next === undefined) throw new Error(`no scripted reply for ${agent}`);
      const text = typeof next === 'function' ? next(req) : next;
      if (onDelta) for (const chunk of text.match(/[\s\S]{1,7}/g) ?? []) onDelta(chunk);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}
const fail = (msg: string): Reply => () => {
  throw new Error(msg);
};
const round = (prose: string, block: unknown) => `${prose}\n\n\`\`\`round\n${JSON.stringify(block)}\n\`\`\``;

function collector() {
  const c = { deltas: [] as string[], status: [] as string[], final: null as Turn | null, errors: [] as string[], emitter: null as unknown as TurnEmitter };
  c.emitter = {
    accepted: () => {},
    status: (t) => c.status.push(t),
    delta: (t) => c.deltas.push(t),
    final: (turn) => (c.final = turn),
    rejected: () => {},
    error: (_id, m) => c.errors.push(m),
  };
  return c;
}

describe('round contracts', () => {
  it('splits player input into say / do / out-of-character lanes', () => {
    expect(parsePlayerInput('"A room, please." I set a coin on the counter. ((make it rain))')).toEqual({
      say: 'A room, please.',
      do: 'I set a coin on the counter.',
      ooc: 'make it rain',
    });
    expect(parsePlayerInput('I nod. “Fine.” Then I leave.')).toEqual({ say: 'Fine.', do: 'I nod. … Then I leave.', ooc: '' });
    expect(parsePlayerInput('')).toEqual({ say: '', do: '', ooc: '' });
  });

  it('splits the narrator reply and reads blocks leniently', () => {
    expect(splitNarratorReply('Rain.\n```round\n{"briefs":{"#a":"x"}}\n```')).toEqual({ prose: 'Rain.', rawBlock: '{"briefs":{"#a":"x"}}' });
    expect(splitNarratorReply('Rain.\n```round\n{"briefs":{"#a":"x"}').rawBlock).toBe('{"briefs":{"#a":"x"}'); // cut off, still tried
    expect(splitNarratorReply('Just prose.')).toEqual({ prose: 'Just prose.' });
    const r = readRoundBlock('{"briefs":{"#a":"seen"},"time":"soon","vars":[{"key":"hp","delta":-1,"who":"#a"},{"nokey":1}],"state":null}')!;
    expect(r.block.briefs).toEqual({ '#a': 'seen' });
    expect(r.block.time).toBeUndefined(); // broken field dropped, reported
    expect(r.problems.join(' ')).toMatch(/time/);
    expect(r.block.vars).toEqual([{ key: 'hp', delta: -1, who: '#a' }]); // the broken entry is dropped
    expect(readRoundBlock('{not json')).toBeUndefined();
  });

  it('clamps character replies and tolerates nulls', () => {
    const r = parseCharacterReply({ say: 'word '.repeat(100), intent: null, to: 'marta', vars: null, remember: [{ text: 'x' }, { nope: 1 }] });
    expect(r.say.split(' ')).toHaveLength(80);
    expect(r.intent).toBe('');
    expect(r.to).toBe('#marta');
    expect(r.vars).toEqual([]);
    expect(r.remember).toEqual([{ text: 'x', tags: [], pin: false }]);
  });

  it('the gate: forced > spotlight > first appearance > mentioned > acted last round, capped', () => {
    const c = (id: string, name: string) => ({ id, name, aliases: [], handle: id });
    const present = [c('marta', 'Marta Vell'), c('tom', 'Tom'), c('held', 'Captain Held'), c('ann', 'Ann')];
    const r = chooseCallers({
      present,
      playerText: 'I ask Captain Held about the road.',
      spotlight: new Set(['tom']),
      neverActed: new Set(['ann']),
      actedLastRound: new Set(['marta']),
      forced: new Set(),
      cap: 3,
    });
    expect(r.called).toEqual(['tom', 'held', 'ann']); // marta (acted last round) loses to the cap
    expect(r.reasons).toEqual({ tom: 'spotlight', ann: 'first appearance', held: 'mentioned by the player' });
    expect(r.idle).toEqual(['marta']);
  });
});

describe('a Minds round through the pipeline', () => {
  let dir: string;
  let app: App;
  let script: Script;
  let seen: { agent: string; req: ChatRequest }[];
  let storyId: string;
  let deps: MindsDeps;

  const textOf = (req: ChatRequest) => `${req.system}\n${req.messages.map((m) => m.content).join('\n')}`;
  const requests = (agent: string) => seen.filter((s) => s.agent === agent).map((s) => s.req);
  const play = async (input: string, force?: string[]) => {
    const c = collector();
    await app.pipeline.run(storyId, input, c.emitter, { force });
    return c;
  };
  const sessionOf = (oid: string) => app.agents.listSessions(storyId).find((s) => s.role === 'character' && s.npcObjectId === oid)!.id;
  const idOf = (name: string) => app.memory.findByName(storyId, name)!.id;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-round-'));
    script = { narrator: [], characters: {}, distributor: [], seeder: [] };
    seen = [];
    app = createApp(config, { driverFactory: () => dispatchDriver(script, seen), dbPath: join(dir, 'r.db'), startWorker: false });
    deps = { stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts };
    storyId = app.stories.createStory({ title: 'Inn', settings: { engine: 'minds', premise: 'A smugglers’ inn.' } as never }).id;
    app.variables.replaceDefs(
      storyId,
      [
        { key: 'health', label: 'Health', type: 'number', min: 0, max: 10, default: 10, visibility: 'self', changedBy: ['narrator'] },
        { key: 'suspicion', label: 'Suspicion', type: 'number', min: 0, max: 100, default: 20, appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'] },
        { key: 'alarm', label: 'Alarm', type: 'number', min: 0, max: 5, scope: 'world', visibility: 'public', changedBy: ['narrator'] },
      ].map((d) => VariableDef.parse(d)),
    );
    createCharacter(deps, storyId, { name: 'Kael', isPlayer: true, appearance: 'Tall, rain-soaked.' });
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Round 1: the opening — the narrator brings in Marta and Tom.
  const opening = async () => {
    script.narrator.push(
      round('Rain hammers the Broken Wheel. Behind the counter, a stout woman; by the fire, a thin man.', {
        cast: { enter: [{ name: 'Marta', appearance: 'Stout, flour on her apron.' }, { name: 'Tom', appearance: 'Thin, nervous.' }] },
        briefs: { Marta: 'A tall stranger walks in out of the rain.', '#tom': 'A tall stranger walks in; Marta stiffens.' },
        scene: { location: '#broken-wheel', items: ['#ledger'] },
        time: 15,
      }),
    );
    return play('');
  };

  it('the opening round: prose streams without the block; characters, scene and briefs are created', async () => {
    const c = await opening();
    expect(c.errors).toEqual([]);
    expect(c.final?.narration).toBe('Rain hammers the Broken Wheel. Behind the counter, a stout woman; by the fire, a thin man.');
    expect(c.deltas.join('').trim()).toBe(c.final?.narration); // the ```round block never reached the player
    expect(requests('narrator')[0].messages.at(-1)!.content).toContain('Open the story');

    const marta = idOf('Marta');
    const tom = idOf('Tom');
    const scene = app.stories.getScene(app.stories.getStory(storyId)!.currentSceneId!)!;
    expect(scene.activeNpcIds).toEqual([marta, tom]);
    expect(app.memory.getObject(scene.locationObjectId!)?.name).toBe('broken wheel');
    expect(scene.itemHandles).toEqual(['ledger']);
    expect(app.stories.getStory(storyId)!.clockMin).toBe(480 + 15);
    expect(app.threads.pending(sessionOf(marta)).map((p) => p.content)).toEqual(['A tall stranger walks in out of the rain.']);
    const seedJobs = app.db.prepare(`SELECT count(*) AS n FROM jobs WHERE type = 'minds_seed' AND status = 'pending'`).get<{ n: number }>()!.n;
    expect(seedJobs).toBe(2);
    expect(c.final?.meta.blockSource).toBe('narrator');
  });

  it('the seeding job gives a new character a mind without touching what exists', async () => {
    await opening();
    script.seeder.push(
      JSON.stringify({
        description: 'Marta Vell has run the inn for twenty years. She keeps the smugglers’ ledger.',
        state: 'Wary of strangers.',
        values: { health: 9, suspicion: 35, nonsense: 1 },
        thoughts: [{ text: 'The ledger stays hidden.', tags: [], pin: true }, { text: 'Tom talks too much.', tags: ['#tom'] }],
      }),
      JSON.stringify({ description: 'Tom, a regular.', thoughts: [] }),
    );
    await app.worker.drain();
    const marta = idOf('Marta');
    const sheet = app.sheets.get(marta)!;
    expect(sheet.seeded).toBe(true);
    expect(sheet.description).toContain('twenty years');
    expect(sheet.appearance).toBe('Stout, flour on her apron.'); // kept
    expect(sheet.state).toBe('Wary of strangers.');
    expect(app.variables.getValue(storyId, 'suspicion', marta)).toBe(35);
    expect(app.thoughts.list(storyId, marta).map((t) => `${t.text}|${t.pinned}|${t.tags.join(',')}`)).toEqual(['The ledger stays hidden.|true|', 'Tom talks too much.|false|#tom']);
    expect(requests('seeder')[0].messages[0].content).toContain('Rain hammers the Broken Wheel'); // parses the story first
  });

  it('a full round: who hears what, changes by the rules, briefs land only in the right threads', async () => {
    await opening();
    const marta = idOf('Marta');
    const tom = idOf('Tom');
    script.characters['Marta'] = [JSON.stringify({ say: 'Rooms are two silver.', to: '#kael', intent: 'slide the ledger under the counter', state: 'Heart pounding.', vars: [{ key: 'health', set: 1 }], remember: [{ text: 'The stranger asked for a room.', tags: ['#kael'] }] })];
    script.characters['Tom'] = [JSON.stringify({ say: '', intent: 'edge toward the door' })];
    script.narrator.push(
      round('She names her price without meeting your eyes. By the fire, the thin man shifts toward the door.', {
        briefs: { '#marta': 'The stranger watches your hands.', '#tom': 'Marta quotes a price; the stranger watches her.' },
        state: { '#tom': 'Ready to bolt.' },
        vars: [{ who: '#marta', key: 'suspicion', delta: 10, why: 'he watches too closely' }, { who: 'world', key: 'alarm', set: 1 }, { who: '#tom', key: 'nonsense', set: 1 }],
        spotlight: ['#tom'],
        tags: ['ledger'],
        notes: { remember: [{ text: 'Kael is hunting the ledger.', tags: ['ledger'] }] },
        time: 2,
      }),
    );
    const c = await play('"A room, please, Marta." I watch her hands.');
    expect(c.errors).toEqual([]);

    // Marta heard the player's words before declaring; she never saw Tom's mind or any hidden value.
    const mReq = requests('character:Marta')[0];
    expect(mReq.messages.at(-1)!.content).toContain('A tall stranger walks in out of the rain.');
    expect(mReq.messages.at(-1)!.content).toContain('Right now:\n#kael Kael: "A room, please, Marta."');
    expect(mReq.messages.at(-1)!.content).not.toContain('I watch her hands'); // the player's action is the narrator's
    for (const req of [...requests('character:Marta'), ...requests('character:Tom')]) expect(textOf(req)).not.toContain('suspicion');

    // The narrator saw both declarations and the hidden value.
    const nText = textOf(requests('narrator')[1]);
    expect(nText).toContain('says "Rooms are two silver." to #kael');
    expect(nText).toContain('tries: edge toward the door');
    expect(nText).toContain('hidden: suspicion 20/100');

    // Changes by the rules: Marta may not set her own health; the narrator's changes apply; unknown keys are logged.
    expect(app.variables.getValue(storyId, 'health', marta)).toBeUndefined();
    expect(app.variables.getValue(storyId, 'suspicion', marta)).toBe(30);
    expect(app.variables.getValue(storyId, 'alarm', 'world')).toBe(1);
    expect(app.sheets.get(marta)!.state).toBe('Heart pounding.');
    expect(app.sheets.get(tom)!.state).toBe('Ready to bolt.');
    expect(c.final?.meta.changes).toEqual({ applied: 4, clamped: 0, rejected: 2, overridden: 0 });
    expect(app.thoughts.list(storyId, marta).map((t) => t.text)).toEqual(['The stranger asked for a room.']);
    expect(app.thoughts.list(storyId, 'narrator').map((t) => t.text)).toEqual(['Kael is hunting the ledger.']);

    // Briefs: each character gets its own, plus the words it heard — and only what it did not already hear.
    const mPending = app.threads.pending(sessionOf(marta)).map((p) => p.content);
    const tPending = app.threads.pending(sessionOf(tom)).map((p) => p.content);
    expect(mPending).toEqual(['The stranger watches your hands.']); // she heard Kael live; Tom said nothing
    // Tom was called too (first appearance), so he heard Kael live; only Marta's words are new to him.
    expect(tPending).toEqual(['Marta quotes a price; the stranger watches her.\nHeard:\n- #marta Marta (to #kael): "Rooms are two silver."']);
    // Replies are stored byte-exact.
    expect(app.threads.log(sessionOf(tom)).at(-1)!.content).toBe(JSON.stringify({ say: '', intent: 'edge toward the door' }));

    // Round 3 — cap 1: the spotlighted Tom acts, Marta waits (her brief keeps waiting too).
    app.stories.updateStory(storyId, { settings: { minds: { ...app.stories.getStory(storyId)!.settings.minds, maxCharactersPerRound: 1 } } });
    script.characters['Tom'].push(JSON.stringify({ say: 'Nice night for it.', intent: 'open the door' }));
    script.narrator.push(round('Cold air pours in as the thin man opens the door.', { briefs: { '#tom': 'The rain hits your face.', '#marta': 'Tom opens the door.' } }));
    const c3 = await play('I sit by the fire.');
    expect(c3.final?.meta.gate).toEqual({ called: [tom], idle: [marta], reasons: { [tom]: 'spotlight' } });
    expect(textOf(requests('narrator')[2])).toContain('This round: not acting.');
    expect(app.threads.pending(sessionOf(marta)).map((p) => p.content)).toEqual([
      'The stranger watches your hands.',
      'Tom opens the door.\nHeard:\n- #tom Tom: "Nice night for it."',
    ]);
    // Tom's thread only appended: round 3's request starts with round 2's.
    const [t2, t3] = requests('character:Tom');
    expect(t3.system).toBe(t2.system);
    expect(t3.messages.slice(0, t2.messages.length)).toEqual(t2.messages);
    // The narrator's thread too.
    const [, n2, n3] = requests('narrator');
    expect(n3.messages.slice(0, n2.messages.length)).toEqual(n2.messages);
  });

  it('a failed character call degrades to "unavailable"; the round completes and the character loses nothing', async () => {
    await opening();
    const tom = idOf('Tom');
    script.characters['Marta'] = [JSON.stringify({ say: 'Yes?' })];
    script.characters['Tom'] = [fail('model timeout')];
    script.narrator.push(round('Marta looks up. The thin man seems lost in thought.', { briefs: { '#marta': 'x', '#tom': 'y' } }));
    const c = await play('"Hello."');
    expect(c.errors).toEqual([]);
    expect(textOf(requests('narrator')[1])).toContain('This round: unavailable');
    expect(app.threads.log(sessionOf(tom))).toHaveLength(0); // nothing half-stored
    expect(app.threads.pending(sessionOf(tom)).map((p) => p.content)).toEqual(['A tall stranger walks in; Marta stiffens.', 'y\nHeard:\n- #kael Kael: "Hello."\n- #marta Marta: "Yes?"']);
  });

  it('a broken block falls back to the distributor, and if that fails, to plain briefs', async () => {
    await opening();
    const marta = idOf('Marta');
    script.characters['Marta'] = [JSON.stringify({ say: '' }), JSON.stringify({ say: '' })];
    script.characters['Tom'] = [JSON.stringify({ say: '' }), JSON.stringify({ say: '' })];
    script.narrator.push('The fire crackles.\n```round\n{"briefs": {oops');
    script.distributor.push(JSON.stringify({ briefs: { '#marta': 'The fire crackles.' }, time: 1 }));
    const c = await play('I wait.');
    expect(c.final?.meta.blockSource).toBe('distributor');
    expect(app.threads.pending(sessionOf(marta)).at(-1)!.content).toBe('The fire crackles.');

    script.narrator.push('Silence.');
    script.distributor.push(fail('distributor down'));
    const c2 = await play('I wait more.');
    expect(c2.errors).toEqual([]);
    expect(c2.final?.meta.blockSource).toBe('fallback');
    expect(app.threads.pending(sessionOf(marta)).at(-1)!.content).toBe('Nothing notable changes for you.');
  });

  it('a narrator reply with no prose fails the turn and commits nothing', async () => {
    await opening();
    const marta = idOf('Marta');
    script.characters['Marta'] = [JSON.stringify({ say: 'Yes?', state: 'Annoyed.' })];
    script.characters['Tom'] = [JSON.stringify({ say: '' })];
    script.narrator.push('```round\n{"briefs":{}}\n```');
    const c = await play('"Hello."');
    expect(c.errors[0]).toMatch(/narrator: the narrator wrote no story text/);
    expect(app.sheets.get(marta)!.state).toBe('');
    expect(app.threads.log(sessionOf(marta))).toHaveLength(0);
    expect(app.threads.pending(sessionOf(marta))).toHaveLength(1); // the opening brief still waits
  });

  it('rewind undoes a whole round: threads, briefs, values, states, thoughts and the clock', async () => {
    await opening();
    const marta = idOf('Marta');
    const clock = app.stories.getStory(storyId)!.clockMin;
    script.characters['Marta'] = [JSON.stringify({ say: 'Yes?', state: 'Annoyed.', remember: [{ text: 'A stranger.', tags: [] }] })];
    script.characters['Tom'] = [JSON.stringify({ say: '' })];
    script.narrator.push(round('She glares.', { briefs: { '#marta': 'He stares back.' }, vars: [{ who: '#marta', key: 'suspicion', set: 50 }], time: 30 }));
    await play('"Hello."');
    expect(app.sheets.get(marta)!.state).toBe('Annoyed.');

    await app.pipeline.rewind(storyId);
    expect(app.sheets.get(marta)!.state).toBe('');
    expect(app.variables.getValue(storyId, 'suspicion', marta)).toBeUndefined();
    expect(app.thoughts.list(storyId, marta)).toEqual([]);
    expect(app.threads.log(sessionOf(marta))).toHaveLength(0);
    expect(app.threads.pending(sessionOf(marta)).map((p) => p.content)).toEqual(['A tall stranger walks in out of the rain.']);
    expect(app.stories.getStory(storyId)!.clockMin).toBe(clock);
  });

  it('classic stories are untouched by the Minds round', async () => {
    const classic = app.stories.createStory({ title: 'Classic', settings: {} as never });
    expect(classic.settings.engine).toBe('classic');
  });
});
