import type { Config, ModelProfile, ProviderKind, RoleName } from '../config/config.ts';
import { anthropicDriver } from './anthropicDriver.ts';
import { openaiDriver } from './openaiDriver.ts';
import type { ChatRequest, ChatResult, LlmDriver, OnDelta } from './types.ts';

// A model profile bound to its concrete driver. Callers supply only the
// conversation (system/messages); model, temperature, maxTokens come from the
// profile, so agent code never hardcodes model names.
export interface BoundDriver {
  readonly name: string;
  readonly profile: ModelProfile;
  readonly driver: LlmDriver;
  chat(
    req: Omit<ChatRequest, 'model' | 'temperature' | 'maxTokens'> &
      Partial<Pick<ChatRequest, 'temperature' | 'maxTokens'>>,
    onDelta?: OnDelta,
  ): Promise<ChatResult>;
}

export interface LlmRegistry {
  getProfile(name: string): BoundDriver;
  getForRole(role: RoleName): BoundDriver;
  listProfiles(): string[];
}

/** Build the driver for a provider kind from the current config. Overridable for tests. */
export type DriverFactory = (kind: ProviderKind, config: Config) => LlmDriver;

export function defaultDriverFactory(kind: ProviderKind, config: Config): LlmDriver {
  if (kind === 'anthropic') {
    const p = config.providers.anthropic;
    if (!p) throw new Error('anthropic provider requested but not configured');
    return anthropicDriver({ apiKey: p.apiKey, baseUrl: p.baseUrl, timeoutMs: config.llm.timeoutMs });
  }
  const p = config.providers.openai_compat;
  if (!p) throw new Error('openai_compat provider requested but not configured');
  return openaiDriver({ apiKey: p.apiKey, baseUrl: p.baseUrl, timeoutMs: config.llm.timeoutMs });
}

/**
 * The registry reads its Config through `getConfig()` on every lookup, so runtime
 * settings changes (keys, models, params via the Settings UI) take effect
 * immediately. Underlying drivers are cached per provider and rebuilt only when
 * that provider's config actually changes.
 */
export function createRegistry(getConfig: () => Config, factory: DriverFactory = defaultDriverFactory): LlmRegistry {
  const driverCache = new Map<string, { key: string; driver: LlmDriver }>();

  function driverFor(kind: ProviderKind, config: Config): LlmDriver {
    const key = JSON.stringify(config.providers[kind] ?? null) + `|${config.llm.timeoutMs}`;
    const cached = driverCache.get(kind);
    if (cached && cached.key === key) return cached.driver;
    const driver = factory(kind, config);
    driverCache.set(kind, { key, driver });
    return driver;
  }

  function build(name: string): BoundDriver {
    const config = getConfig();
    const profile = config.modelProfiles[name];
    if (!profile) throw new Error(`unknown model profile '${name}'`);
    const driver = driverFor(profile.provider, config);
    return {
      name,
      profile,
      driver,
      chat(req, onDelta) {
        return driver.chat(
          {
            model: profile.model,
            temperature: req.temperature ?? profile.temperature,
            maxTokens: req.maxTokens ?? profile.maxTokens,
            system: req.system,
            messages: req.messages,
            jsonSchema: req.jsonSchema,
            signal: req.signal,
          },
          onDelta,
        );
      },
    };
  }

  return {
    getProfile: (name) => build(name),
    getForRole(role) {
      const profileName = getConfig().roles[role];
      if (!profileName) throw new Error(`no model profile configured for role '${role}'`);
      return build(profileName);
    },
    listProfiles: () => Object.keys(getConfig().modelProfiles),
  };
}
