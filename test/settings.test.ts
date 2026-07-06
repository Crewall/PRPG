import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createSettingsStore } from '../src/db/stores/settingsStore.ts';
import { createSettingsService } from '../src/config/settingsService.ts';
import { createRegistry } from '../src/llm/registry.ts';
import { parseConfig } from '../src/config/config.ts';

const base = parseConfig({
  providers: { anthropic: { apiKey: 'sk-ant-real' }, openai_compat: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-real' } },
  modelProfiles: {
    'narrator-strong': { provider: 'anthropic', model: 'claude-sonnet-5', temperature: 0.9 },
    'worker-cheap': { provider: 'anthropic', model: 'claude-haiku-4-5', temperature: 0.2 },
  },
  roles: { storyteller: 'narrator-strong', npc: 'narrator-strong', scribe_memory: 'worker-cheap', scribe_story: 'worker-cheap', overseer: 'worker-cheap' },
});

describe('SettingsService', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('seeds from config.json and compiles an effective config with per-role profiles', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const eff = svc.effective();
    expect(eff.roles.storyteller).toBe('role:storyteller');
    expect(eff.modelProfiles['role:storyteller'].model).toBe('claude-sonnet-5');
    expect(eff.modelProfiles['role:scribe_memory'].model).toBe('claude-haiku-4-5');
    // Favourites were seeded from the named profiles.
    expect(svc.get().favourites.map((f) => f.id)).toContain('narrator-strong');
  });

  it('never leaks API keys through the public view', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    const view = svc.publicView() as { providers: { anthropic: { configured: boolean; hint: string } } };
    expect(view.providers.anthropic.configured).toBe(true);
    expect(view.providers.anthropic.hint).not.toContain('sk-ant-real');
    expect(JSON.stringify(view)).not.toContain('sk-ant-real');
  });

  it('changing a role model/params is reflected live in the registry', () => {
    const store = createSettingsStore(db);
    const svc = createSettingsService(store, base);
    const registry = createRegistry(() => svc.effective(), () => ({ kind: 'anthropic', chat: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: '' }) }));
    expect(registry.getForRole('storyteller').profile.model).toBe('claude-sonnet-5');

    svc.update({
      favourites: [...svc.get().favourites, { id: 'gpt', label: 'GPT', provider: 'openai_compat', model: 'openai/gpt-4o' }],
      roles: { ...svc.get().roles, storyteller: { favouriteId: 'gpt', temperature: 0.5, maxTokens: 999 } },
    });
    expect(registry.getForRole('storyteller').profile.model).toBe('openai/gpt-4o');
    expect(registry.getForRole('storyteller').profile.temperature).toBe(0.5);
    expect(registry.getForRole('storyteller').profile.maxTokens).toBe(999);
  });

  it('a blank apiKey on update preserves the existing key', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    svc.update({ providers: { anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com' } } });
    expect(svc.get().providers.anthropic?.apiKey).toBe('sk-ant-real'); // preserved
    svc.update({ providers: { anthropic: { apiKey: 'sk-ant-new' } } });
    expect(svc.get().providers.anthropic?.apiKey).toBe('sk-ant-new'); // replaced
  });

  it('persists to the DB and auto-loads on the next boot', () => {
    const store = createSettingsStore(db);
    const svc = createSettingsService(store, base);
    svc.update({ roles: { ...svc.get().roles, storyteller: { favouriteId: 'worker-cheap', temperature: 0.1, maxTokens: 100 } } });

    // New service over the same store — should load the saved settings.
    const svc2 = createSettingsService(store, base);
    expect(svc2.get().roles.storyteller!.favouriteId).toBe('worker-cheap');
    expect(svc2.effective().modelProfiles['role:storyteller'].model).toBe('claude-haiku-4-5');
  });

  it('prompt overrides are stored and reported', () => {
    const svc = createSettingsService(createSettingsStore(db), base);
    expect(svc.promptOverride('storyteller')).toBeUndefined();
    svc.update({ prompts: { storyteller: 'MY CUSTOM PROMPT {{genre}}' } });
    expect(svc.promptOverride('storyteller')).toBe('MY CUSTOM PROMPT {{genre}}');
  });
});
