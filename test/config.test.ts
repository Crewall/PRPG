import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError } from '../src/config/config.ts';

const base = {
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: {
    strong: { provider: 'anthropic', model: 'claude-sonnet-5' },
    cheap: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  },
  roles: { storyteller: 'strong', npc: 'strong', scribe_memory: 'cheap', scribe_story: 'cheap', overseer: 'cheap' },
};

describe('config validation', () => {
  it('accepts a valid config and applies defaults', () => {
    const cfg = parseConfig(base);
    expect(cfg.server.port).toBe(7777);
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.db.path).toBe('data/prpg.db');
    expect(cfg.modelProfiles.strong.temperature).toBe(0.8);
    expect(cfg.llm.maxRetries).toBe(2);
  });

  it('requires at least one provider', () => {
    expect(() => parseConfig({ ...base, providers: {} })).toThrow(ConfigError);
  });

  it('rejects a role pointing at an unknown profile', () => {
    const bad = { ...base, roles: { ...base.roles, storyteller: 'ghost' } };
    expect(() => parseConfig(bad)).toThrow(/unknown model profile 'ghost'/);
  });

  it('rejects a profile whose provider is not configured', () => {
    const bad = {
      ...base,
      modelProfiles: { ...base.modelProfiles, strong: { provider: 'openai_compat', model: 'x' } },
    };
    expect(() => parseConfig(bad)).toThrow(/provider 'openai_compat' which is not configured/);
  });

  it('rejects an empty api key', () => {
    expect(() => parseConfig({ ...base, providers: { anthropic: { apiKey: '' } } })).toThrow(ConfigError);
  });

  it('produces readable multi-line error messages', () => {
    try {
      parseConfig({ ...base, roles: { ...base.roles, storyteller: 'ghost' } });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('Invalid configuration');
      expect((err as Error).message).toContain('roles.storyteller');
    }
  });
});
