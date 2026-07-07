import { z } from 'zod';
import type { Config } from './config.ts';
import { ConfigSchema, ProviderKind, RoleName } from './config.ts';
import type { SettingsStore } from '../db/stores/settingsStore.ts';
import { id } from '../util/id.ts';
import { logger } from '../util/logger.ts';

// Runtime, UI-editable configuration persisted in the settings table (key
// 'runtimeConfig'). Seeded from config.json on first boot, then the DB is the
// source of truth. Compiled into an effective `Config` the registry consumes.

const ProviderCfg = z.object({ apiKey: z.string().default(''), baseUrl: z.string().default('') });

export const Favourite = z.object({
  id: z.string(),
  label: z.string(),
  provider: ProviderKind,
  model: z.string(),
});
export type Favourite = z.infer<typeof Favourite>;

export const RoleBinding = z.object({
  favouriteId: z.string(),
  temperature: z.number().min(0).max(2).default(0.8),
  maxTokens: z.number().int().positive().default(2048),
});

export const RuntimeSettings = z.object({
  providers: z.object({
    anthropic: ProviderCfg.optional(),
    openai_compat: ProviderCfg.optional(),
  }),
  favourites: z.array(Favourite).default([]),
  roles: z.record(RoleName, RoleBinding),
  prompts: z.record(z.string(), z.string()).default({}),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettings>;

const KEY = 'runtimeConfig';
const ALL_ROLES: RoleName[] = ['storyteller', 'npc', 'scribe_memory', 'scribe_story', 'overseer', 'context_planner'];

// The editable prompt templates surfaced in the Settings UI.
export const EDITABLE_PROMPTS: { name: string; label: string }[] = [
  { name: 'storyteller', label: 'Storyteller' },
  { name: 'npc', label: 'NPC persona' },
  { name: 'scribe-story-scene', label: 'Story scribe — scene summary' },
  { name: 'scribe-story-digest', label: 'Story scribe — digest fold' },
  { name: 'scribe-memory', label: 'Memory scribe — extraction' },
  { name: 'context-planner', label: 'Context planner — memory selection' },
];

/** Convert the boot config.json into the initial RuntimeSettings shape. */
function seedFromConfig(base: Config): RuntimeSettings {
  const favourites: Favourite[] = Object.entries(base.modelProfiles).map(([name, p]) => ({
    id: name,
    label: name,
    provider: p.provider,
    model: p.model,
  }));
  const roles: Record<string, z.infer<typeof RoleBinding>> = {};
  for (const role of ALL_ROLES) {
    // context_planner arrived after the initial config shape — when absent from
    // config.json, seed it from the (cheap) scribe_memory binding.
    const profileName = base.roles[role] ?? (role === 'context_planner' ? base.roles.scribe_memory : undefined);
    const profile = profileName ? base.modelProfiles[profileName] : undefined;
    const fav = favourites.find((f) => f.id === profileName) ?? favourites[0];
    roles[role] = {
      favouriteId: fav?.id ?? '',
      temperature: profile?.temperature ?? 0.8,
      maxTokens: profile?.maxTokens ?? 2048,
    };
  }
  return {
    providers: base.providers,
    favourites,
    roles: roles as RuntimeSettings['roles'],
    prompts: {},
  };
}

export interface SettingsUpdate {
  providers?: {
    anthropic?: { apiKey?: string; baseUrl?: string };
    openai_compat?: { apiKey?: string; baseUrl?: string };
  };
  favourites?: Favourite[];
  roles?: RuntimeSettings['roles'];
  prompts?: Record<string, string>;
}

export interface SettingsService {
  get(): RuntimeSettings;
  effective(): Config;
  update(patch: SettingsUpdate): RuntimeSettings;
  promptOverride(name: string): string | undefined;
  onChange(listener: () => void): void;
  /** Masked view for the API (never leaks API keys). */
  publicView(): unknown;
}

export function createSettingsService(store: SettingsStore, base: Config): SettingsService {
  let settings: RuntimeSettings;
  let compiled: Config;
  const listeners: (() => void)[] = [];

  const stored = store.get<unknown>(KEY, null);
  if (stored) {
    const parsed = RuntimeSettings.safeParse(stored);
    settings = parsed.success ? parsed.data : seedFromConfig(base);
    if (!parsed.success) logger.warn('stored runtimeConfig invalid, reseeding from config.json');
  } else {
    settings = seedFromConfig(base);
    store.set(KEY, settings);
  }

  function compile(s: RuntimeSettings): Config {
    // Only pass through fully-configured providers (a key, plus a baseUrl where
    // required) so a half-filled entry doesn't fail strict validation.
    const providers: Record<string, unknown> = {};
    if (s.providers.anthropic?.apiKey?.trim()) {
      providers.anthropic = { apiKey: s.providers.anthropic.apiKey, ...(s.providers.anthropic.baseUrl?.trim() ? { baseUrl: s.providers.anthropic.baseUrl } : {}) };
    }
    if (s.providers.openai_compat?.apiKey?.trim() && s.providers.openai_compat.baseUrl?.trim()) {
      providers.openai_compat = { apiKey: s.providers.openai_compat.apiKey, baseUrl: s.providers.openai_compat.baseUrl };
    }
    const configured = new Set(Object.keys(providers));
    const usableFavs = s.favourites.filter((f) => configured.has(f.provider));

    const modelProfiles: Config['modelProfiles'] = {};
    for (const fav of usableFavs) {
      modelProfiles[`fav:${fav.id}`] = { provider: fav.provider, model: fav.model, temperature: 0.8, maxTokens: 2048, contextWindow: 200_000 };
    }
    const roles: Partial<Record<RoleName, string>> = {};
    for (const role of ALL_ROLES) {
      const binding = s.roles[role];
      let fav = binding ? usableFavs.find((f) => f.id === binding.favouriteId) : undefined;
      if (!fav) fav = usableFavs[0]; // fallback if the referenced favourite was removed/unconfigured
      if (!fav) continue;
      modelProfiles[`role:${role}`] = { provider: fav.provider, model: fav.model, temperature: binding?.temperature ?? 0.8, maxTokens: binding?.maxTokens ?? 2048, contextWindow: 200_000 };
      roles[role] = `role:${role}`;
    }

    // Validate the compiled config (≥1 provider, roles resolve, providers exist).
    return ConfigSchema.parse({ server: base.server, db: base.db, providers, modelProfiles, roles, llm: base.llm });
  }

  compiled = compile(settings);

  function recompileAndNotify(): void {
    compiled = compile(settings);
    for (const l of listeners) l();
  }

  return {
    get: () => settings,
    effective: () => compiled,
    promptOverride: (name) => settings.prompts[name],
    onChange: (l) => listeners.push(l),

    update(patch: SettingsUpdate) {
      // Merge providers so an omitted/blank apiKey preserves the existing one.
      const nextProviders = { ...settings.providers };
      if (patch.providers) {
        for (const kind of Object.keys(patch.providers) as ProviderKind[]) {
          const incoming = patch.providers[kind];
          if (!incoming) continue;
          const prev = nextProviders[kind] ?? { apiKey: '', baseUrl: '' };
          nextProviders[kind] = {
            apiKey: incoming.apiKey && incoming.apiKey.trim() ? incoming.apiKey : prev.apiKey,
            baseUrl: incoming.baseUrl !== undefined ? incoming.baseUrl : prev.baseUrl,
          };
        }
      }
      const merged: RuntimeSettings = RuntimeSettings.parse({
        providers: nextProviders,
        favourites: patch.favourites ?? settings.favourites,
        roles: patch.roles ?? settings.roles,
        prompts: patch.prompts ?? settings.prompts,
      });
      // Compile eagerly so an invalid change is rejected before persisting.
      const nextCompiled = compile(merged);
      settings = merged;
      compiled = nextCompiled;
      store.set(KEY, settings);
      for (const l of listeners) l();
      return settings;
    },

    publicView() {
      const maskProvider = (p?: { apiKey: string; baseUrl: string }) =>
        p ? { configured: !!p.apiKey, hint: p.apiKey ? '••••' + p.apiKey.slice(-4) : '', baseUrl: p.baseUrl } : { configured: false, hint: '', baseUrl: '' };
      return {
        providers: {
          anthropic: maskProvider(settings.providers.anthropic),
          openai_compat: maskProvider(settings.providers.openai_compat),
        },
        favourites: settings.favourites,
        roles: settings.roles,
        prompts: EDITABLE_PROMPTS.map((p) => ({ ...p, overridden: settings.prompts[p.name] !== undefined })),
      };
    },
  };
}

/** Make a fresh favourite id. */
export function newFavouriteId(): string {
  return id(8);
}
