import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createSettingsStore } from '../src/db/stores/settingsStore.ts';
import { createSettingsService } from '../src/config/settingsService.ts';
import { createRegistry } from '../src/llm/registry.ts';
import { parseConfig, ALL_ROLES } from '../src/config/config.ts';
import type { ResolvedConnection, RoleName } from '../src/config/config.ts';
import type { LlmDriver } from '../src/llm/types.ts';

const base = parseConfig({
  providers: { anthropic: { apiKey: 'sk-ant-real' }, openai_compat: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-real' } },
  modelProfiles: {
    'narrator-strong': { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.9 },
    'worker-cheap': { provider: 'anthropic', model: 'claude-haiku-4-5', temperature: 0.2 },
  },
  roles: { storyteller: 'narrator-strong', npc: 'narrator-strong', scribe_memory: 'worker-cheap', scribe_story: 'worker-cheap', overseer: 'worker-cheap' },
});

const nullDriver = (): LlmDriver => ({ kind: 'openai_compat', chat: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: '' }) });

describe('SettingsService (connections, models, tiers)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('seeds from config.json: models, three default tiers, every role resolved', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const s = svc.get();
    expect(s.models.map((m) => m.id)).toEqual(['narrator-strong', 'worker-cheap']);
    expect(s.tiers.slice(0, 3).map((t) => t.label)).toEqual(['Heavy', 'Medium', 'Light']);
    expect(s.connections.map((c) => c.id).sort()).toEqual(['anthropic', 'openrouter']);
    const eff = svc.effective();
    expect(eff.roles.storyteller).toBe('role:storyteller');
    expect(eff.modelProfiles['role:storyteller'].model).toBe('claude-sonnet-5');
    expect(eff.modelProfiles['role:storyteller'].temperature).toBe(0.9);
    expect(eff.modelProfiles['role:scribe_memory'].model).toBe('claude-haiku-4-5');
    // Roles absent from config.json inherit a sensible existing role's model.
    expect(eff.modelProfiles['role:context_planner'].model).toBe('claude-haiku-4-5');
    expect(eff.modelProfiles['role:player_intake'].model).toBe('claude-sonnet-5');
    expect(eff.modelProfiles['role:randomizer'].model).toBe('claude-sonnet-5');
    for (const role of ALL_ROLES) expect(eff.roles[role]).toBe(`role:${role}`);
  });

  it('never leaks API keys through the public view', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const view = svc.publicView();
    const anth = view.connections.find((c) => c.id === 'anthropic')!;
    expect(anth.configured).toBe(true);
    expect(anth.hint).toBe('••••real');
    expect(JSON.stringify(view)).not.toContain('sk-ant-real');
    expect(JSON.stringify(view)).not.toContain('sk-or-real');
  });

  it('changing a tier is reflected live in the registry for every role on it', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const registry = createRegistry(() => svc.effective(), nullDriver);
    expect(registry.getForRole('storyteller').profile.model).toBe('claude-sonnet-5');

    svc.update({
      models: [...svc.get().models, { id: 'gpt', label: 'GPT', providerId: 'openrouter', model: 'openai/gpt-4o' }],
      tiers: svc.get().tiers.map((t) => (t.id === 'heavy' ? { ...t, modelId: 'gpt', temperature: 0.5, maxTokens: 999 } : t)),
    });
    const st = registry.getForRole('storyteller');
    expect(st.profile.model).toBe('openai/gpt-4o');
    expect(st.profile.connectionId).toBe('openrouter');
    expect(st.profile.temperature).toBe(0.5);
    expect(st.profile.maxTokens).toBe(999);
    // The randomizer sits on the same tier.
    expect(registry.getForRole('randomizer').profile.model).toBe('openai/gpt-4o');
  });

  it('a blank apiKey on update preserves the existing key; a new one replaces it', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const conns = () => svc.get().connections.map(({ apiKey: _k, ...c }) => c);
    svc.update({ connections: conns().map((c) => ({ ...c, apiKey: '' })) });
    expect(svc.connection('anthropic')?.apiKey).toBe('sk-ant-real');
    svc.update({ connections: conns().map((c) => (c.id === 'anthropic' ? { ...c, apiKey: 'sk-ant-new' } : c)) });
    expect(svc.connection('anthropic')?.apiKey).toBe('sk-ant-new');
  });

  it('persists to the DB and auto-loads on the next boot', () => {
    const store = createSettingsStore(db);
    const svc = createSettingsService(store, base);
    svc.update({ roleTiers: { ...svc.get().roleTiers, storyteller: 'light' } });
    const svc2 = createSettingsService(store, base);
    expect(svc2.get().roleTiers.storyteller).toBe('light');
    expect(svc2.effective().modelProfiles['role:storyteller'].model).toBe('claude-haiku-4-5');
  });

  it('refuses to delete a tier that roles still use, and unknown references', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    expect(() => svc.update({ tiers: svc.get().tiers.filter((t) => t.id !== 'light') })).toThrow(/still used by: .*Memory scribe/);
    expect(() => svc.update({ tiers: [...svc.get().tiers, { id: 'x', label: 'X', modelId: 'ghost', maxTokens: 10 }] })).toThrow(/unknown model 'ghost'/);
    expect(() => svc.update({ models: [...svc.get().models, { id: 'm2', label: 'M', providerId: 'nope', model: 'x' }] })).toThrow(/unknown provider 'nope'/);
    // Reassigning the roles in the same save makes the deletion valid.
    const roleTiers = Object.fromEntries(Object.entries(svc.publicView().roleTiers).map(([r, t]) => [r, t === 'light' ? 'heavy' : t]));
    svc.update({ tiers: svc.get().tiers.filter((t) => t.id !== 'light'), roleTiers });
    expect(svc.get().tiers.map((t) => t.id)).not.toContain('light');
  });

  it('applies model caps: no temperature when sampling is off, no reasoning switch the model lacks', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    svc.update({
      models: svc.get().models.map((m) => (m.id === 'narrator-strong' ? { ...m, caps: { sampling: false, reasoning: 'always', json: 'schema' } } : m)),
      tiers: svc.get().tiers.map((t) => (t.id === 'heavy' ? { ...t, reasoning: 'off', effort: 'high' } : t.id === 'light' ? { ...t, reasoning: 'off' } : t)),
    });
    const eff = svc.effective();
    expect(eff.modelProfiles['tier:heavy'].temperature).toBeUndefined();
    expect(eff.modelProfiles['tier:heavy'].reasoning).toBeUndefined(); // 'always' cannot be switched off
    expect(eff.modelProfiles['tier:heavy'].effort).toBe('high');
    expect(eff.modelProfiles['tier:heavy'].caps?.json).toBe('schema');
    expect(eff.modelProfiles['tier:light'].reasoning).toBeUndefined(); // caps.reasoning 'none' (anthropic default)
  });

  it('a story override resolves to its tier; a stale one falls back to the role model', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const registry = createRegistry(() => svc.effective(), nullDriver);
    expect(registry.getForRole('npc', 'tier:light').profile.model).toBe('claude-haiku-4-5');
    expect(registry.getForRole('npc', 'fav:worker-cheap').profile.model).toBe('claude-haiku-4-5'); // pre-v2 override
    expect(registry.getForRole('npc', 'tier:deleted').profile.model).toBe('claude-sonnet-5');
  });

  it('prompt overrides are stored and reported', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    expect(svc.promptOverride('storyteller')).toBeUndefined();
    svc.update({ prompts: { storyteller: 'MY CUSTOM PROMPT {{genre}}' } });
    expect(svc.promptOverride('storyteller')).toBe('MY CUSTOM PROMPT {{genre}}');
  });

  it('verbosity and tone overrides are stored and reported', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    expect(svc.verbosityOverride()).toEqual({});
    expect(svc.toneDefault()).toBeUndefined();
    svc.update({ verbosity: { '3': 'two sentences only' }, tone: 'grimdark' });
    expect(svc.verbosityOverride()).toEqual({ '3': 'two sentences only' });
    expect(svc.toneDefault()).toBe('grimdark');
    svc.update({ tone: '   ' });
    expect(svc.toneDefault()).toBeUndefined();
  });
});

describe('migration from the per-role settings shape (v1)', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  // A v1 blob as the old Settings page saved it: one slot per provider kind,
  // a model + temperature + max tokens per role, all different.
  const legacy = {
    providers: { anthropic: { apiKey: 'sk-ant', baseUrl: '' }, openai_compat: { apiKey: 'sk-or', baseUrl: 'https://openrouter.ai/api/v1' } },
    favourites: [
      { id: 'big', label: 'Big', provider: 'openai_compat', model: 'deepseek/deepseek-v4-pro' },
      { id: 'small', label: 'Small', provider: 'openai_compat', model: 'deepseek/deepseek-flash' },
      { id: 'claude', label: 'Claude', provider: 'anthropic', model: 'claude-haiku-4-5' },
    ],
    roles: {
      storyteller: { favouriteId: 'big', temperature: 0.9, maxTokens: 3000 },
      npc: { favouriteId: 'big', temperature: 0.7, maxTokens: 800 },
      scribe_memory: { favouriteId: 'small', temperature: 0.2, maxTokens: 1500 },
      scribe_story: { favouriteId: 'small', temperature: 0.2, maxTokens: 1500 },
      context_planner: { favouriteId: 'small', temperature: 0.1, maxTokens: 400 },
      adjudicator: { favouriteId: 'claude', temperature: 0.3, maxTokens: 600 },
      player_intake: { favouriteId: 'big', temperature: 0.9, maxTokens: 3000 },
      overseer: { favouriteId: 'small', temperature: 0.2, maxTokens: 1500 },
    },
    prompts: { storyteller: 'custom' },
    seeds: 'a\nb',
    verbosity: {},
    tone: 'noir',
    performance: { jobConcurrency: 3, requestTimeoutMs: 90000 },
  };

  it('every role keeps its exact model, temperature and max tokens', () => {
    const store = createSettingsStore(db);
    store.set('runtimeConfig', legacy);
    const svc = createSettingsService(store, base);
    const eff = svc.effective();
    for (const [role, b] of Object.entries(legacy.roles)) {
      const p = eff.modelProfiles[eff.roles[role as RoleName]!];
      const fav = legacy.favourites.find((f) => f.id === b.favouriteId)!;
      expect({ role, model: p.model, temperature: p.temperature, maxTokens: p.maxTokens }).toEqual({ role, model: fav.model, temperature: b.temperature, maxTokens: b.maxTokens });
    }
    // The randomizer used the storyteller's model before it had a role of its own.
    expect(eff.modelProfiles['role:randomizer'].model).toBe('deepseek/deepseek-v4-pro');
    // Tiers: the three defaults anchored on storyteller / npc / scribe_memory, plus
    // one per role whose binding matched none of them.
    const s = svc.get();
    expect(s.tiers.map((t) => t.label)).toEqual(['Heavy', 'Medium', 'Light', 'Context planner', 'Adjudicator']);
    expect(s.roleTiers.player_intake).toBe('heavy');
    expect(s.roleTiers.scribe_story).toBe('light');
    // Everything else carried over; the old blob is kept as a backup.
    expect(s.connections.find((c) => c.id === 'openrouter')?.preset).toBe('openrouter');
    expect(s.prompts.storyteller).toBe('custom');
    expect(s.tone).toBe('noir');
    expect(s.performance.jobConcurrency).toBe(3);
    expect(store.get('runtimeConfigV1Backup', null)).toEqual(legacy);
    expect(store.get<{ version?: number }>('runtimeConfig', {}).version).toBe(2);
  });
});

describe('config.json with named connections (DeepSeek + OpenRouter at once)', () => {
  it('routes each role to its own connection, base URL and key', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cfg = parseConfig({
      connections: [
        { id: 'deepseek', preset: 'deepseek', apiKey: 'ds-key' },
        { id: 'openrouter', preset: 'openrouter', apiKey: 'or-key' },
      ],
      modelProfiles: {
        heavy: { connection: 'deepseek', model: 'deepseek-v4-pro', maxTokens: 4096 },
        medium: { connection: 'openrouter', model: 'some/model:free', maxTokens: 1024, reasoning: 'off' },
        light: { connection: 'deepseek', model: 'deepseek-flash', maxTokens: 1024, reasoning: 'off' },
      },
      roles: { storyteller: 'heavy', npc: 'medium', scribe_memory: 'light', scribe_story: 'light' },
    });
    const svc = createSettingsService(createSettingsStore(db), cfg);
    const seen: ResolvedConnection[] = [];
    const registry = createRegistry(
      () => svc.effective(),
      (conn) => {
        seen.push(conn);
        return nullDriver();
      },
    );
    const st = registry.getForRole('storyteller');
    const npc = registry.getForRole('npc');
    expect(st.profile.connectionId).toBe('deepseek');
    expect(npc.profile.connectionId).toBe('openrouter');
    expect(npc.profile.reasoning).toBe('off');
    expect(seen.map((c) => [c.id, c.baseUrl, c.apiKey])).toEqual([
      ['deepseek', 'https://api.deepseek.com', 'ds-key'],
      ['openrouter', 'https://openrouter.ai/api/v1', 'or-key'],
    ]);
    db.close();
  });
});

describe('effort levels a model does not offer', () => {
  it('are dropped when compiling, so the provider default applies', () => {
    const db = openDb(':memory:');
    migrate(db);
    const svc = createSettingsService(createSettingsStore(db), base);
    svc.update({
      models: svc.get().models.map((m) => (m.id === 'narrator-strong' ? { ...m, caps: { sampling: true, reasoning: 'always', json: 'json_object', efforts: ['high'] } } : m)),
      tiers: svc.get().tiers.map((t) => (t.id === 'heavy' ? { ...t, effort: 'low', reasoning: 'off' } : t.id === 'medium' ? { ...t, effort: 'high' } : t)),
    });
    expect(svc.effective().modelProfiles['tier:heavy'].effort).toBeUndefined();
    expect(svc.effective().modelProfiles['tier:heavy'].reasoning).toBeUndefined();
    expect(svc.effective().modelProfiles['tier:medium'].effort).toBe('high');
    db.close();
  });
});
