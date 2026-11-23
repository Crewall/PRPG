import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { parseConfig } from '../src/config/config.ts';
import { createApp } from '../src/app.ts';
import type { App } from '../src/app.ts';
import { resolveStorySettings, defaultStorySettings } from '../src/domain.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { VariableDef, STATE_KEY, validateDefs, canSee, runPipeline, renderValue, renderRange, defaultValue } from '../src/minds/variables.ts';
import type { HolderInfo, Proposal, VariableValue } from '../src/minds/variables.ts';
import { selectRecall, tagsMentioned, prepareRemember } from '../src/minds/thoughts.ts';
import type { Thought } from '../src/minds/thoughts.ts';
import { slugify, normalizeTag } from '../src/minds/text.ts';
import { SCENARIO_TEMPLATES } from '../src/minds/templates.ts';
import { applyChanges, applyThoughtOps, createCharacter, mindsView } from '../src/minds/service.ts';
import type { MindsDeps } from '../src/minds/service.ts';
import { mergeMemoryObjects } from '../src/orchestrator/memoryHandlers.ts';
import { scriptedDriver } from './fixtures/drivers.ts';

const config = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

const def = (raw: unknown) => VariableDef.parse(raw);
const health = def({
  key: 'health', label: 'Health', type: 'number', min: 0, max: 10, default: 10, maxStep: 3,
  bands: [{ upTo: 2, label: 'critical' }, { upTo: 5, label: 'hurt' }, { upTo: 10, label: 'fine' }],
  visibility: 'self', changedBy: ['narrator'],
});
const mood = def({ key: 'mood', label: 'Mood', type: 'text', maxWords: 3, visibility: 'self', changedBy: ['self', 'narrator'] });
const trust = def({ key: 'trust', label: 'Trust', type: 'number', min: 0, max: 100, default: 50, appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'] });
const rank = def({ key: 'rank', label: 'Rank', type: 'choice', options: ['private', 'captain'], visibility: 'public', changedBy: ['narrator'] });
const carrying = def({ key: 'carrying', label: 'Carrying', type: 'list', maxItems: 2, itemMaxWords: 3, visibility: 'self', changedBy: ['narrator', 'self'] });
const alarm = def({ key: 'alarm', label: 'Alarm', type: 'number', min: 0, max: 5, scope: 'world', visibility: 'public', changedBy: ['narrator'] });
const disguised = def({ key: 'disguised', label: 'Disguised', type: 'flag', visibility: 'self', changedBy: ['narrator'] });

describe('engine setting', () => {
  it('derives the engine from the old NPC Story Mode flag and keeps the flag in sync', () => {
    expect(resolveStorySettings({}).engine).toBe('classic');
    expect(resolveStorySettings({ npcStories: { enabled: true } }).engine).toBe('npc_stories');
    const minds = resolveStorySettings({ ...defaultStorySettings() }, { engine: 'minds' });
    expect(minds.engine).toBe('minds');
    expect(minds.npcStories.enabled).toBe(false);
    // The old toggle still works…
    expect(resolveStorySettings({ engine: 'classic' }, { npcStories: { enabled: true } }).engine).toBe('npc_stories');
    expect(resolveStorySettings({ engine: 'npc_stories' }, { npcStories: { enabled: false } }).engine).toBe('classic');
    // …and resending an unchanged flag never moves a Minds story.
    expect(resolveStorySettings({ engine: 'minds' }, { npcStories: { enabled: false } }).engine).toBe('minds');
    expect(resolveStorySettings({}).minds.thoughtRecallTokens).toBe(300);
  });
});

describe('handles and tags', () => {
  it('slugifies names, folding accents', () => {
    expect(slugify('Éva Kovács')).toBe('eva-kovacs');
    expect(slugify('Guard Captain Held!')).toBe('guard-captain-held');
    expect(slugify('***')).toBe('x');
  });
  it('normalizes tags, keeping accented letters and the # of handles', () => {
    expect(normalizeTag('  Old Mill ')).toBe('old-mill');
    expect(normalizeTag('#Marta')).toBe('#marta');
    expect(normalizeTag('erdő')).toBe('erdő');
    expect(normalizeTag('!!')).toBe('');
  });
});

describe('variable definitions', () => {
  it('rejects rule-breaking definitions', () => {
    expect(() => validateDefs([def({ key: 'x', label: 'X', type: 'flag', visibility: 'hidden', changedBy: ['self'] })])).toThrow(/hidden variable can't be changed by its holder/);
    expect(() => validateDefs([def({ key: 'w', label: 'W', type: 'flag', scope: 'world', visibility: 'public', changedBy: ['self'] })])).toThrow(/world variable can't be changed by 'self'/);
    expect(() => validateDefs([def({ key: 'n', label: 'N', type: 'number', min: 0, max: 10, default: 12 })])).toThrow(/default is outside/);
    expect(() => validateDefs([def({ key: 'n', label: 'N', type: 'number', min: 5, max: 5 })])).toThrow(/min must be below max/);
    expect(() => validateDefs([health, { ...health }])).toThrow(/duplicate key 'health'/);
    expect(() => def({ key: 'c', label: 'C', type: 'choice', options: ['only'] })).toThrow(/at least 2 options/);
    expect(() => validateDefs([health, mood, trust, rank, carrying, alarm, disguised])).not.toThrow();
  });
  it('every shipped template is valid', () => {
    for (const t of SCENARIO_TEMPLATES) expect(() => validateDefs(t.variables)).not.toThrow();
  });
  it('renders values and ranges the way the AIs will read them', () => {
    expect(renderValue(health, 4)).toBe('4/10 (hurt)');
    expect(renderRange(health)).toBe('0–10; 0–2 critical, 3–5 hurt, 6–10 fine');
    expect(renderValue(carrying, ['ledger', 'kitchen knife'])).toBe('[ledger, kitchen knife]');
    expect(renderValue(mood, 'cornered')).toBe('"cornered"');
    expect(defaultValue(rank)).toBe('private');
  });
});

describe('visibility', () => {
  it('follows the table in docs/11 §4.4', () => {
    const narrator = { kind: 'narrator' } as const;
    const marta = { kind: 'character', id: 'marta' } as const;
    const tom = { kind: 'character', id: 'tom' } as const;
    const player = { kind: 'player', playerId: 'pc' } as const;
    expect(canSee(trust, 'marta', narrator)).toBe(true);
    expect(canSee(trust, 'marta', marta)).toBe(false); // hidden even from its holder
    expect(canSee(health, 'marta', marta)).toBe(true);
    expect(canSee(health, 'marta', tom)).toBe(false); // 'self' is private to the holder
    expect(canSee(rank, 'marta', tom)).toBe(true);
    expect(canSee(health, 'pc', player)).toBe(true);
    expect(canSee(health, 'marta', player)).toBe(false);
    expect(canSee(trust, 'marta', { kind: 'advanced' })).toBe(true);
  });
});

describe('the change pipeline', () => {
  const holders = new Map<string, HolderInfo>([
    ['world', { id: 'world', isPlayer: false }],
    ['pc', { id: 'pc', isPlayer: true, handle: 'hero' }],
    ['marta', { id: 'marta', isPlayer: false, handle: 'marta' }],
  ]);
  const run = (proposals: Proposal[], values: Record<string, VariableValue> = {}) =>
    runPipeline(
      { defs: [health, mood, trust, rank, carrying, alarm, disguised], holders, current: (k, h) => values[`${h}.${k}`], currentState: () => 'calm' },
      proposals,
    );
  const out = (r: ReturnType<typeof run>) => r.outcomes.map((o) => `${o.proposal.change.holder}.${o.proposal.change.key}:${o.result}${o.new !== undefined ? '=' + JSON.stringify(o.new) : ''}`);

  it('rejects unknown keys, holders the variable does not apply to, and disallowed changers', () => {
    const r = run([
      { change: { holder: 'marta', key: 'ghost', op: 'set', value: 1 }, by: 'narrator' },
      { change: { holder: 'pc', key: 'trust', op: 'set', value: 10 }, by: 'narrator' }, // npcs only
      { change: { holder: 'marta', key: 'health', op: 'set', value: 1 }, by: 'self', proposer: 'marta' }, // narrator-only
      { change: { holder: 'pc', key: 'mood', op: 'set', value: 'smug' }, by: 'self', proposer: 'marta' }, // not her own
      { change: { holder: 'marta', key: 'trust', op: 'set', value: 99 }, by: 'self', proposer: 'marta' }, // hidden
      { change: { holder: 'marta', key: 'rank', op: 'set', value: 'general' }, by: 'narrator' }, // not an option
      { change: { holder: 'marta', key: 'health', op: 'toggle' }, by: 'narrator' }, // wrong op for type
    ]);
    expect(out(r)).toEqual(['marta.ghost:rejected', 'pc.trust:rejected', 'marta.health:rejected', 'pc.mood:rejected', 'marta.trust:rejected', 'marta.rank:rejected', 'marta.health:rejected']);
    expect(r.finals.size).toBe(0);
  });

  it('clamps out-of-range values and AI steps over maxStep; the user is exempt from maxStep', () => {
    const r = run([
      { change: { holder: 'marta', key: 'health', op: 'delta', value: -9 }, by: 'narrator' }, // maxStep 3 → 10-3
      { change: { holder: 'world', key: 'alarm', op: 'set', value: 99 }, by: 'narrator' }, // max 5
      { change: { holder: 'pc', key: 'health', op: 'set', value: 1 }, by: 'user' }, // no maxStep for the user
      { change: { holder: 'marta', key: 'mood', op: 'set', value: 'very very angry indeed' }, by: 'self', proposer: 'marta' }, // 3 words
    ]);
    expect(out(r)).toEqual(['marta.health:clamped=7', 'world.alarm:clamped=5', 'pc.health:applied=1', 'marta.mood:clamped="very very angry"']);
  });

  it('lists, choices and flags: add/remove/toggle, case-insensitive options, full lists', () => {
    const r = run(
      [
        { change: { holder: 'marta', key: 'carrying', op: 'add', value: 'kitchen knife' }, by: 'self', proposer: 'marta' },
        { change: { holder: 'marta', key: 'carrying', op: 'add', value: 'rope' }, by: 'narrator' }, // narrator works from round start
        { change: { holder: 'pc', key: 'carrying', op: 'remove', value: 'nothing' }, by: 'narrator' },
        { change: { holder: 'marta', key: 'rank', op: 'set', value: 'CAPTAIN' }, by: 'narrator' },
        { change: { holder: 'pc', key: 'disguised', op: 'toggle' }, by: 'narrator' },
      ],
      { 'marta.carrying': ['ledger'] },
    );
    expect(out(r)).toEqual([
      'marta.carrying:overridden=["ledger","kitchen knife"]',
      'marta.carrying:applied=["ledger","rope"]',
      'pc.carrying:rejected',
      'marta.rank:applied="captain"',
      'pc.disguised:applied=true',
    ]);
  });

  it('the narrator wins over the holder on the same key in one round; the state pseudo-key works the same way', () => {
    const r = run([
      { change: { holder: 'marta', key: 'mood', op: 'set', value: 'defiant' }, by: 'self', proposer: 'marta' },
      { change: { holder: 'marta', key: STATE_KEY, op: 'set', value: 'Scared but holding it together.' }, by: 'self', proposer: 'marta' },
      { change: { holder: 'marta', key: 'mood', op: 'set', value: 'terrified' }, by: 'narrator' },
      { change: { holder: 'marta', key: STATE_KEY, op: 'set', value: 'Bleeding from a cut on her arm, and terrified.' }, by: 'narrator' },
    ]);
    expect(r.outcomes.map((o) => o.result)).toEqual(['overridden', 'overridden', 'applied', 'applied']);
    expect(r.finals.get('marta\u0000mood')).toBe('terrified');
    expect(r.finals.get(`marta\u0000${STATE_KEY}`)).toBe('Bleeding from a cut on her arm, and terrified.');
  });
});

describe('thoughts: recall selection and mentions', () => {
  const t = (seq: number, tags: string[], extra: Partial<Thought> = {}): Thought => ({
    id: `id${seq}`, storyId: 's', owner: 'marta', seq, text: `thought ${seq}`, tags, pinned: false, status: 'active', source: 'self',
    kind: 'note', importance: 5, about: null, renewedClockMin: null, revises: null,
    createdTurnId: null, createdClockMin: null, revokedTurnId: null, lastRecalledTurnId: null, recallCount: 0, createdAt: seq, ...extra,
  });
  it('picks by tag overlap, then recency, within budget; skips pinned, revoked and already shown', () => {
    const thoughts = [
      t(1, ['ledger']),
      t(2, ['ledger', '#tom']),
      t(3, ['weather']),
      t(4, ['ledger'], { pinned: true }),
      t(5, ['ledger'], { status: 'revoked' }),
      t(6, ['ledger']),
      t(7, ['#tom']),
    ];
    const picked = selectRecall(thoughts, new Set(['ledger', '#tom']), new Set(['id6']), 1000);
    expect(picked.map((x) => x.seq)).toEqual([2, 7, 1]);
    expect(selectRecall(thoughts, new Set(['ledger', '#tom']), new Set(), 12).length).toBe(1); // budget-bound
  });
  it('finds the owner’s tags mentioned in text', () => {
    expect(tagsMentioned('The ledger is gone, and Tom saw the Old Mill burn.', ['ledger', 'old-mill', '#tom', 'debt'])).toEqual(['ledger', 'old-mill', '#tom']);
  });
  it('prepares a remember: unknown handles become plain tags, untagged is pinned, long text is shortened', () => {
    const p = prepareRemember({ text: 'x '.repeat(50), tags: ['#ghost', 'Debt', 'debt'], pin: false }, new Set(['marta']))!;
    expect(p.tags).toEqual(['ghost', 'debt']);
    expect(p.text.split(' ').length).toBe(40);
    expect(p.notes.join(' ')).toMatch(/no one\/nothing is called #ghost/);
    expect(prepareRemember({ text: 'I owe Tom money.', tags: [], pin: false }, new Set())!.pinned).toBe(true);
  });
});

describe('Minds data layer through the app (stores, service, rewind)', () => {
  let dir: string;
  let app: App;
  let deps: MindsDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-minds-'));
    app = createApp(config, { driverFactory: () => scriptedDriver([]), dbPath: join(dir, 'm.db'), startWorker: false });
    deps = { stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts };
  });
  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const setup = () => {
    const story = app.stories.createStory({ title: 'S', settings: { engine: 'minds' } as never });
    app.variables.replaceDefs(story.id, [health, mood, trust, carrying, alarm]);
    const pc = createCharacter(deps, story.id, { name: 'Hero', isPlayer: true, description: 'A wandering sellsword.', appearance: 'Tall, travel-worn.' });
    const marta = createCharacter(deps, story.id, { name: 'Marta Vell', description: 'Innkeeper. Secretly an informant.', appearance: 'Stout, flour on her apron.' });
    return { story, pc, marta };
  };

  it('creates characters with unique handles and marks the player character on the story', () => {
    const { story, pc, marta } = setup();
    const twin = createCharacter(deps, story.id, { name: 'Marta Vell' });
    expect(app.memory.getObject(marta.objectId)?.handle).toBe('marta-vell');
    expect(app.memory.getObject(twin.objectId)?.handle).toBe('marta-vell-2');
    expect(app.stories.getStory(story.id)?.settings.playerObjectId).toBe(pc.objectId);
    expect(app.sheets.player(story.id)?.objectId).toBe(pc.objectId);
  });

  it('applies and logs changes; the view hides what the viewer may not see', () => {
    const { story, pc, marta } = setup();
    const outcomes = applyChanges(deps, story.id, [
      { change: { holder: marta.objectId, key: 'mood', op: 'set', value: 'wary', why: 'a stranger asks about the ledger' }, by: 'self', proposer: marta.objectId },
      { change: { holder: marta.objectId, key: 'trust', op: 'delta', value: -10 }, by: 'narrator' },
      { change: { holder: marta.objectId, key: STATE_KEY, op: 'set', value: 'Nervous, wiping the same mug.' }, by: 'narrator' },
      { change: { holder: marta.objectId, key: 'health', op: 'set', value: 2 }, by: 'self', proposer: marta.objectId },
    ]);
    expect(outcomes.map((o) => o.result)).toEqual(['applied', 'applied', 'applied', 'rejected']);
    expect(app.variables.getValue(story.id, 'trust', marta.objectId)).toBe(40);
    expect(app.sheets.get(marta.objectId)?.state).toBe('Nervous, wiping the same mug.');
    const log = app.variables.listChanges(story.id, { holder: marta.objectId });
    expect(log).toHaveLength(4);
    expect(log.find((c) => c.key === 'health')?.result).toBe('rejected');

    const normal = mindsView(deps, story.id, { kind: 'player', playerId: pc.objectId });
    const martaNormal = normal.characters.find((c) => c.objectId === marta.objectId)!;
    expect(martaNormal.description).toBeUndefined();
    expect(martaNormal.state).toBeUndefined();
    expect(martaNormal.variables.map((v) => v.key)).toEqual([]); // her health/mood are 'self', trust is hidden
    expect(normal.characters.find((c) => c.objectId === pc.objectId)!.variables.map((v) => v.key)).toEqual(['health', 'mood', 'carrying']);
    expect(normal.world.map((v) => v.key)).toEqual(['alarm']);

    const advanced = mindsView(deps, story.id, { kind: 'advanced' });
    const martaAdv = advanced.characters.find((c) => c.objectId === marta.objectId)!;
    expect(martaAdv.description).toContain('informant');
    expect(martaAdv.variables.find((v) => v.key === 'trust')?.display).toBe('40/100');
  });

  it('thought operations: caps, own thoughts only, vocabulary, handle checks', () => {
    const { story, pc, marta } = setup();
    const r = applyThoughtOps(deps, story.id, marta.objectId, {
      remember: [
        { text: 'The stranger asked about the ledger.', tags: ['ledger', '#hero'], pin: false },
        { text: 'Tom is watching me.', tags: ['#tom'], pin: false },
        { text: 'I must keep the ledger hidden.', tags: [], pin: false },
        { text: 'A fourth thought.', tags: ['x'], pin: false },
      ],
    }, 'self', null);
    expect(r.added.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(r.added[1].tags).toEqual(['tom']); // no #tom on the roster
    expect(r.added[2].pinned).toBe(true);
    expect(r.notes.join(' ')).toMatch(/Only 3 new thoughts/);

    const hers = applyThoughtOps(deps, story.id, pc.objectId, { forget: ['t1'] }, 'self', null);
    expect(hers.revoked).toHaveLength(0); // the PC has no t1; Marta's t1 is untouched
    expect(app.thoughts.bySeq(story.id, marta.objectId, 1)?.status).toBe('active');
    applyThoughtOps(deps, story.id, marta.objectId, { forget: ['t1'] }, 'self', null);
    expect(app.thoughts.list(story.id, marta.objectId).map((t) => t.seq)).toEqual([2, 3]);
    expect(app.thoughts.list(story.id, marta.objectId, { includeRevoked: true })).toHaveLength(3);
    expect(app.thoughts.vocabulary(story.id, marta.objectId)).toEqual([{ tag: 'tom', count: 1 }]);
  });

  it('caps active thoughts per owner', () => {
    const { story, marta } = setup();
    app.stories.updateStory(story.id, { settings: { minds: { ...app.stories.getStory(story.id)!.settings.minds, maxActiveThoughts: 2 } } });
    const r = applyThoughtOps(deps, story.id, marta.objectId, { remember: [1, 2, 3].map((n) => ({ text: `fact ${n}`, tags: ['a'], pin: false })) }, 'user');
    expect(r.added).toHaveLength(2);
    expect(r.notes.join(' ')).toMatch(/already hold 2 thoughts/);
  });

  it('rewind restores sheets, values, thoughts and handles, and drops newer change-log rows', () => {
    const { story, marta } = setup();
    applyChanges(deps, story.id, [{ change: { holder: marta.objectId, key: 'mood', op: 'set', value: 'calm' }, by: 'user' }]);
    applyThoughtOps(deps, story.id, marta.objectId, { remember: [{ text: 'Before the turn.', tags: ['a'], pin: false }] }, 'self');
    const turn = app.stories.appendTurn({ storyId: story.id, playerInput: 'hi', status: 'streaming' });
    app.snapshots.capture(story.id, turn.id, turn.index);

    applyChanges(deps, story.id, [
      { change: { holder: marta.objectId, key: 'mood', op: 'set', value: 'furious' }, by: 'narrator' },
      { change: { holder: marta.objectId, key: STATE_KEY, op: 'set', value: 'Shaking with rage.' }, by: 'narrator' },
    ], turn.id);
    applyThoughtOps(deps, story.id, marta.objectId, { remember: [{ text: 'During the turn.', tags: ['b'], pin: false }], forget: ['t1'] }, 'self', turn.id);
    createCharacter(deps, story.id, { name: 'Newcomer' });

    expect(app.snapshots.restore(story.id, turn.id)).toBe(true);
    expect(app.variables.getValue(story.id, 'mood', marta.objectId)).toBe('calm');
    expect(app.sheets.get(marta.objectId)?.state).toBe('');
    expect(app.thoughts.list(story.id, marta.objectId, { includeRevoked: true }).map((t) => `${t.text}:${t.status}`)).toEqual(['Before the turn.:active']);
    expect(app.thoughts.vocabulary(story.id, marta.objectId)).toEqual([{ tag: 'a', count: 1 }]);
    expect(app.memory.getObject(marta.objectId)?.handle).toBe('marta-vell'); // handles survive rewind
    expect(app.sheets.listForStory(story.id)).toHaveLength(2); // the newcomer is gone
    expect(app.variables.listChanges(story.id).map((c) => c.new)).toEqual(['calm']);
  });

  it('merging two roster objects moves sheet, values and thoughts, and retags #handles', () => {
    const { story, marta } = setup();
    const alias = app.memory.createObject({ storyId: story.id, type: 'character', name: 'The Innkeeper', aliases: [], summary: '', salience: 0.5, status: 'active' });
    const tom = createCharacter(deps, story.id, { name: 'Tom' });
    applyThoughtOps(deps, story.id, tom.objectId, { remember: [{ text: 'The innkeeper hides something.', tags: ['#the-innkeeper'], pin: false }] }, 'self');
    applyThoughtOps(deps, story.id, marta.objectId, { remember: [{ text: 'Mine.', tags: ['a'], pin: false }] }, 'self');
    mergeMemoryObjects({ ...app, db: app.db } as never, marta.objectId, alias.id);
    expect(app.thoughts.list(story.id, tom.objectId)[0].tags).toEqual(['#marta-vell']);
  });
});

describe('Minds HTTP API', () => {
  let dir: string;
  let app: App;
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'prpg-minds-api-'));
    app = createApp(config, { driverFactory: () => scriptedDriver([]), dbPath: join(dir, 'a.db'), startWorker: false });
    server = Fastify();
    await registerHttpRoutes(server, app);
  });
  afterEach(async () => {
    await server.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scenario definitions: validated on save, applied to values, filtered by mode', async () => {
    const story = app.stories.createStory({ title: 'S', settings: { engine: 'minds' } as never });
    const bad = await server.inject({ method: 'PUT', url: `/api/stories/${story.id}/variables/defs`, payload: { defs: [{ key: 'x', label: 'X', type: 'flag', visibility: 'hidden', changedBy: ['self'] }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/hidden variable/);

    const ok = await server.inject({ method: 'PUT', url: `/api/stories/${story.id}/variables/defs`, payload: { defs: [health, trust, { ...rank, appliesTo: ['#Marta'] }] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().find((d: { key: string }) => d.key === 'rank').appliesTo).toEqual(['marta']);

    const pc = await server.inject({ method: 'POST', url: `/api/stories/${story.id}/minds`, payload: { name: 'Hero', isPlayer: true } });
    const marta = await server.inject({ method: 'POST', url: `/api/stories/${story.id}/minds`, payload: { name: 'Marta', description: 'Secret informant.' } });
    expect(marta.json().handle).toBe('marta');
    const mid = marta.json().objectId;

    const set = await server.inject({ method: 'PATCH', url: `/api/stories/${story.id}/variables/values`, payload: { changes: [{ holder: mid, key: 'trust', value: 120 }] } });
    expect(set.json()).toEqual([expect.objectContaining({ result: 'clamped', new: 100 })]);

    const normal = (await server.inject({ method: 'GET', url: `/api/stories/${story.id}/minds` })).json();
    const m = normal.characters.find((c: { objectId: string }) => c.objectId === mid);
    expect(m.description).toBeUndefined();
    expect(m.variables.map((v: { key: string }) => v.key)).toEqual(['rank']); // public only; trust is hidden
    expect(normal.characters.find((c: { objectId: string }) => c.objectId === pc.json().objectId).variables.map((v: { key: string }) => v.key)).toEqual(['health']);

    const adv = (await server.inject({ method: 'GET', url: `/api/stories/${story.id}/minds?advanced=1` })).json();
    expect(adv.characters.find((c: { objectId: string }) => c.objectId === mid).variables.map((v: { key: string }) => v.key)).toEqual(['health', 'trust', 'rank']);

    const patch = await server.inject({ method: 'PATCH', url: `/api/stories/${story.id}/minds/${mid}`, payload: { state: 'Nervous.' } });
    expect(patch.json().state).toBe('Nervous.');
    const log = (await server.inject({ method: 'GET', url: `/api/stories/${story.id}/variables/changes?holder=${mid}` })).json();
    expect(log.map((c: { key: string; by: string }) => `${c.key}:${c.by}`)).toEqual([`${STATE_KEY}:user`, 'trust:user']);
  });

  it('thoughts: add, list with vocabulary, revoke, and refuses unknown owners', async () => {
    const story = app.stories.createStory({ title: 'S', settings: {} as never });
    const marta = (await server.inject({ method: 'POST', url: `/api/stories/${story.id}/minds`, payload: { name: 'Marta' } })).json();
    const add = await server.inject({ method: 'POST', url: `/api/stories/${story.id}/thoughts`, payload: { owner: marta.objectId, text: 'Tom owes me.', tags: ['Debt'] } });
    expect(add.statusCode).toBe(201);
    const tid = add.json().added[0].id;
    expect((await server.inject({ method: 'POST', url: `/api/stories/${story.id}/thoughts`, payload: { owner: 'nobody', text: 'x' } })).statusCode).toBe(400);
    await server.inject({ method: 'PATCH', url: `/api/thoughts/${tid}`, payload: { revoked: true } });
    const list = (await server.inject({ method: 'GET', url: `/api/stories/${story.id}/thoughts?owner=${marta.objectId}&includeRevoked=1` })).json();
    expect(list.thoughts[0].status).toBe('revoked');
    expect(list.vocabulary).toEqual([]);
  });
});
