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

/** Build the driver for a provider kind from config. Overridable for tests. */
export type DriverFactory = (kind: ProviderKind) => LlmDriver;

function defaultDriverFactory(config: Config): DriverFactory {
  const cache = new Map<ProviderKind, LlmDriver>();
  return (kind) => {
    const existing = cache.get(kind);
    if (existing) return existing;
    let driver: LlmDriver;
    if (kind === 'anthropic') {
      const p = config.providers.anthropic;
      if (!p) throw new Error('anthropic provider requested but not configured');
      driver = anthropicDriver({ apiKey: p.apiKey, baseUrl: p.baseUrl, timeoutMs: config.llm.timeoutMs });
    } else {
      const p = config.providers.openai_compat;
      if (!p) throw new Error('openai_compat provider requested but not configured');
      driver = openaiDriver({ apiKey: p.apiKey, baseUrl: p.baseUrl, timeoutMs: config.llm.timeoutMs });
    }
    cache.set(kind, driver);
    return driver;
  };
}

export function createRegistry(config: Config, factory?: DriverFactory): LlmRegistry {
  const makeDriver = factory ?? defaultDriverFactory(config);
  const bound = new Map<string, BoundDriver>();

  function build(name: string): BoundDriver {
    const profile = config.modelProfiles[name];
    if (!profile) throw new Error(`unknown model profile '${name}'`);
    const driver = makeDriver(profile.provider);
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
    getProfile(name) {
      let b = bound.get(name);
      if (!b) {
        b = build(name);
        bound.set(name, b);
      }
      return b;
    },
    getForRole(role) {
      const profileName = config.roles[role];
      if (!profileName) throw new Error(`no model profile configured for role '${role}'`);
      return this.getProfile(profileName);
    },
    listProfiles: () => Object.keys(config.modelProfiles),
  };
}
