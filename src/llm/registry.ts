import type { EffectiveConfig, ModelProfile, ResolvedConnection, RoleName } from '../config/config.ts';
import { anthropicDriver } from './anthropicDriver.ts';
import { openaiDriver } from './openaiDriver.ts';
import type { ChatRequest, ChatResult, LlmDriver, OnDelta } from './types.ts';
import { logger } from '../util/logger.ts';

// A model profile bound to its concrete driver. Callers supply only the
// conversation (system/messages); model, parameters, reasoning and JSON mode
// come from the profile, so agent code never hardcodes model names.
export interface BoundDriver {
  readonly name: string;
  readonly profile: ModelProfile;
  readonly driver: LlmDriver;
  chat(
    req: Omit<ChatRequest, 'model' | 'temperature' | 'maxTokens' | 'reasoning' | 'effort' | 'jsonMode'> &
      Partial<Pick<ChatRequest, 'temperature' | 'maxTokens'>>,
    onDelta?: OnDelta,
  ): Promise<ChatResult>;
}

export interface LlmRegistry {
  getProfile(name: string): BoundDriver;
  /**
   * The model a role runs. `override` is a story-level profile name
   * (`tier:<id>`, or a pre-v2 `fav:<id>` / `role:<role>`); an override that no
   * longer resolves falls back to the role's own model instead of failing the turn.
   */
  getForRole(role: RoleName, override?: string | null): BoundDriver;
  listProfiles(): string[];
}

/** Build the driver for a connection. Overridable for tests. */
export type DriverFactory = (conn: ResolvedConnection, config: EffectiveConfig) => LlmDriver;

export function defaultDriverFactory(conn: ResolvedConnection, config: EffectiveConfig): LlmDriver {
  const common = { apiKey: conn.apiKey, timeoutMs: config.llm.timeoutMs, maxRetries: config.llm.maxRetries };
  if (conn.kind === 'anthropic') return anthropicDriver({ ...common, baseUrl: conn.baseUrl || undefined });
  return openaiDriver({ ...common, baseUrl: conn.baseUrl, preset: conn.preset });
}

export interface RegistryHooks {
  /** Called once per model call (not per internal HTTP retry), with the connection id. */
  onRequest?(connectionId: string): void;
  /** A provider is busy: the call waits before trying again. */
  onWait?(connectionId: string, info: { model: string; waitMs: number; status: number }): void;
}

/**
 * The registry reads its config through `getConfig()` on every lookup, so
 * Settings changes (keys, models, tiers) take effect immediately. Drivers are
 * cached per connection and rebuilt only when that connection's config changes.
 */
export function createRegistry(getConfig: () => EffectiveConfig, factory: DriverFactory = defaultDriverFactory, hooks: RegistryHooks = {}): LlmRegistry {
  const driverCache = new Map<string, { key: string; driver: LlmDriver }>();
  const warnedOverrides = new Set<string>();

  function driverFor(conn: ResolvedConnection, config: EffectiveConfig): LlmDriver {
    const key = JSON.stringify(conn) + `|${config.llm.timeoutMs}|${config.llm.maxRetries}`;
    const cached = driverCache.get(conn.id);
    if (cached && cached.key === key) return cached.driver;
    const driver = factory(conn, config);
    driverCache.set(conn.id, { key, driver });
    return driver;
  }

  function build(name: string): BoundDriver {
    const config = getConfig();
    const profile = config.modelProfiles[name];
    if (!profile) throw new Error(`unknown model profile '${name}'`);
    const connId = profile.connectionId ?? profile.provider;
    const conn = config.connections[connId];
    if (!conn) throw new Error(`model profile '${name}' uses provider '${connId}', which is not configured (add its API key in Settings)`);
    const driver = driverFor(conn, config);
    const sampling = profile.caps?.sampling !== false;
    return {
      name,
      profile,
      driver,
      chat(req, onDelta) {
        hooks.onRequest?.(conn.id);
        return driver.chat(
          {
            model: profile.model,
            temperature: sampling ? req.temperature ?? profile.temperature : undefined,
            maxTokens: req.maxTokens ?? profile.maxTokens,
            system: req.system,
            messages: req.messages,
            jsonSchema: req.jsonSchema,
            jsonMode: profile.caps?.json,
            reasoning: profile.reasoning,
            effort: profile.effort,
            sessionKey: req.sessionKey,
            signal: req.signal,
            ...(profile.fallbackModels?.length ? { fallbackModels: profile.fallbackModels } : {}),
            onWait: (info) => hooks.onWait?.(conn.id, info),
          },
          onDelta,
        );
      },
    };
  }

  return {
    getProfile: (name) => build(name),
    getForRole(role, override) {
      const config = getConfig();
      if (override) {
        if (config.modelProfiles[override]) return build(override);
        if (!warnedOverrides.has(override)) {
          warnedOverrides.add(override);
          logger.warn('story model override no longer exists — using the role default', { role, override });
        }
      }
      const profileName = config.roles[role];
      if (!profileName) throw new Error(`no model is configured for role '${role}' — add a provider and a model in Settings`);
      return build(profileName);
    },
    listProfiles: () => Object.keys(getConfig().modelProfiles),
  };
}
