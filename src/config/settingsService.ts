import { z } from 'zod';
import type { Config, EffectiveConfig, ModelProfile, ResolvedConnection } from './config.ts';
import {
  ALL_ROLES,
  ROLE_LABELS,
  ConfigSchema,
  Effort,
  ModelCaps,
  PRESETS,
  ProviderKind,
  ProviderPreset,
  ReasoningSetting,
  RoleName,
  bootConnections,
  defaultCaps,
  detectPreset,
  legacyConnectionId,
  profileConnectionId,
} from './config.ts';
import type { SettingsStore } from '../db/stores/settingsStore.ts';
import { id } from '../util/id.ts';
import { logger } from '../util/logger.ts';

// Runtime, UI-editable configuration persisted in the settings table (key
// 'runtimeConfig'). Seeded from config.json on first boot, then the DB is the
// source of truth. Compiled into an EffectiveConfig the LLM registry consumes.
//
// Shape v2 (doc 12): named provider CONNECTIONS (several of the same kind),
// MODELS on a connection (with caps), TIERS (a model + parameters), and a
// role → tier map. Older v1 settings (one slot per provider kind, a model +
// params per role) are migrated losslessly on load.

export const ConnectionCfg = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  kind: ProviderKind,
  preset: ProviderPreset.default('custom'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
});
export type ConnectionCfg = z.infer<typeof ConnectionCfg>;

export const ModelEntry = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  providerId: z.string(),
  model: z.string().default(''),
  caps: ModelCaps.default({}),
});
export type ModelEntry = z.infer<typeof ModelEntry>;

export const TierCfg = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  modelId: z.string().default(''),
  maxTokens: z.number().int().positive().default(2048),
  /** Undefined = don't send a temperature. */
  temperature: z.number().min(0).max(2).optional(),
  reasoning: ReasoningSetting.default('default'),
  effort: Effort.optional(),
});
export type TierCfg = z.infer<typeof TierCfg>;

const Performance = z
  .object({
    jobConcurrency: z.number().int().min(1).max(16).default(2),
    requestTimeoutMs: z.number().int().min(10_000).max(600_000).default(180_000),
  })
  .default({});

export const RuntimeSettings = z.object({
  version: z.literal(2),
  connections: z.array(ConnectionCfg).default([]),
  models: z.array(ModelEntry).default([]),
  tiers: z.array(TierCfg).default([]),
  /** RoleName → tier id. Missing roles use DEFAULT_ROLE_TIER. */
  roleTiers: z.record(z.string(), z.string()).default({}),
  prompts: z.record(z.string(), z.string()).default({}),
  // Override for the premise randomizer's seed phrases (one per line). Empty =
  // use the shipped src/data/story-seeds.txt.
  seeds: z.string().default(''),
  // Editable storyteller-style insertions: verbosity strings per step ("1".."5")
  // and the default narrator tone for new stories. Empty = built-in defaults.
  verbosity: z.record(z.string(), z.string()).default({}),
  tone: z.string().default(''),
  // Throughput tuning: background job concurrency and model reply timeout.
  performance: Performance,
});
export type RuntimeSettings = z.infer<typeof RuntimeSettings>;

// ---- v1 (pre-tier) shape, kept only to migrate it ----
const LegacyProviderCfg = z.object({ apiKey: z.string().default(''), baseUrl: z.string().default('') });
const LegacyRuntimeSettings = z.object({
  providers: z.object({ anthropic: LegacyProviderCfg.optional(), openai_compat: LegacyProviderCfg.optional() }),
  favourites: z.array(z.object({ id: z.string(), label: z.string(), provider: ProviderKind, model: z.string() })).default([]),
  roles: z.record(z.string(), z.object({ favouriteId: z.string(), temperature: z.number().min(0).max(2).default(0.8), maxTokens: z.number().int().positive().default(2048) })),
  prompts: z.record(z.string(), z.string()).default({}),
  seeds: z.string().default(''),
  verbosity: z.record(z.string(), z.string()).default({}),
  tone: z.string().default(''),
  performance: Performance,
});
type LegacyRuntimeSettings = z.infer<typeof LegacyRuntimeSettings>;

const KEY = 'runtimeConfig';
const LEGACY_BACKUP_KEY = 'runtimeConfigV1Backup';

/** The three default tiers, and which role anchors each one during migration. */
export const DEFAULT_TIERS: { id: string; label: string; anchor: RoleName }[] = [
  { id: 'heavy', label: 'Heavy', anchor: 'storyteller' },
  { id: 'medium', label: 'Medium', anchor: 'npc' },
  { id: 'light', label: 'Light', anchor: 'scribe_memory' },
];

/** Default tier per role (doc 12 §4.1) when the role → tier map has no entry. */
export const DEFAULT_ROLE_TIER: Record<RoleName, string> = {
  storyteller: 'heavy',
  randomizer: 'heavy',
  npc: 'medium',
  player_intake: 'medium',
  scribe_story: 'light',
  scribe_memory: 'light',
  context_planner: 'light',
  adjudicator: 'light',
  overseer: 'light',
  narrator: 'heavy',
  character: 'medium',
  distributor: 'light',
  seeder: 'medium',
};

// Roles added after the original config shape: when absent, they inherit an
// existing role's model (cheap for background workers, strong for creative work).
const LATE_ROLE_FALLBACK: Partial<Record<RoleName, RoleName>> = {
  context_planner: 'scribe_memory',
  adjudicator: 'scribe_memory',
  player_intake: 'storyteller',
  randomizer: 'storyteller',
};

// The editable prompt templates surfaced in the Settings UI.
export const EDITABLE_PROMPTS: { name: string; label: string }[] = [
  { name: 'storyteller', label: 'Storyteller' },
  { name: 'npc', label: 'NPC persona' },
  { name: 'scribe-story-scene', label: 'Story scribe — scene summary' },
  { name: 'scribe-story-digest', label: 'Story scribe — digest fold' },
  { name: 'scribe-memory', label: 'Memory scribe — extraction' },
  { name: 'scribe-memory-unify', label: 'Memory scribe — entity unification (cleanup)' },
  { name: 'scribe-memory-consolidate', label: 'Memory scribe — fact consolidation (cleanup)' },
  { name: 'context-planner', label: 'Context planner — memory selection' },
  { name: 'npc-dossier', label: 'Memory scribe — NPC dossier' },
  { name: 'adjudicator', label: 'Adjudicator — action resolution' },
  { name: 'player-intake', label: 'Character interviewer — player dossier' },
  { name: 'story-randomizer', label: 'Story randomizer — premise from seeds' },
  { name: 'minds-narrator', label: 'Minds — narrator' },
  { name: 'minds-character', label: 'Minds — character mind' },
  { name: 'minds-distributor', label: 'Minds — round-block fallback' },
  { name: 'minds-seed', label: 'Minds — new-character seeder' },
];

// ---- Building tiers from per-role bindings (seed + migration share this) ----

interface Binding {
  modelId: string;
  temperature?: number;
  maxTokens: number;
  reasoning: z.infer<typeof ReasoningSetting>;
  effort?: z.infer<typeof Effort>;
}

function sameBinding(a: Binding, b: Binding): boolean {
  return a.modelId === b.modelId && a.temperature === b.temperature && a.maxTokens === b.maxTokens && a.reasoning === b.reasoning && a.effort === b.effort;
}

/**
 * Turn per-role bindings into tiers + a role → tier map without changing what
 * any role runs: Heavy/Medium/Light take the storyteller/npc/scribe_memory
 * bindings; every other role points at a tier with an identical binding, or
 * gets a tier of its own.
 */
function buildTiers(bindings: Partial<Record<RoleName, Binding>>, fallback: Binding): { tiers: TierCfg[]; roleTiers: Record<string, string> } {
  const tiers: TierCfg[] = DEFAULT_TIERS.map((t) => ({ id: t.id, label: t.label, ...(bindings[t.anchor] ?? fallback) }));
  const roleTiers: Record<string, string> = {};
  for (const role of ALL_ROLES) {
    const b = bindings[role];
    if (!b) {
      roleTiers[role] = DEFAULT_ROLE_TIER[role];
      continue;
    }
    const anchored = DEFAULT_TIERS.find((t) => t.anchor === role);
    if (anchored) {
      roleTiers[role] = anchored.id;
      continue;
    }
    const preferred = tiers.find((t) => t.id === DEFAULT_ROLE_TIER[role] && sameBinding(t, b));
    const match = preferred ?? tiers.find((t) => sameBinding(t, b));
    if (match) {
      roleTiers[role] = match.id;
    } else {
      const own: TierCfg = { id: `role-${role}`, label: ROLE_LABELS[role], ...b };
      tiers.push(own);
      roleTiers[role] = own.id;
    }
  }
  return { tiers, roleTiers };
}

function emptyRest(): Pick<RuntimeSettings, 'prompts' | 'seeds' | 'verbosity' | 'tone'> {
  return { prompts: {}, seeds: '', verbosity: {}, tone: '' };
}

/** First boot: convert config.json into the v2 shape. */
export function seedFromConfig(base: Config): RuntimeSettings {
  const connections: ConnectionCfg[] = bootConnections(base).map((c) => ({ ...c }));
  const presetOf = (connId: string) => connections.find((c) => c.id === connId)?.preset ?? 'custom';
  const models: ModelEntry[] = Object.entries(base.modelProfiles).map(([name, p]) => {
    const providerId = profileConnectionId(base, p);
    // Label by the model id: profile names ("heavy") read like tier names in the UI.
    return { id: name, label: p.model, providerId, model: p.model, caps: defaultCaps(presetOf(providerId)) };
  });
  const bindingOf = (profileName: string | undefined): Binding | undefined => {
    const p = profileName ? base.modelProfiles[profileName] : undefined;
    return p && profileName ? { modelId: profileName, temperature: p.temperature, maxTokens: p.maxTokens, reasoning: p.reasoning ?? 'default', effort: p.effort } : undefined;
  };
  const bindings: Partial<Record<RoleName, Binding>> = {};
  for (const role of ALL_ROLES) {
    const fb = LATE_ROLE_FALLBACK[role];
    const b = bindingOf(base.roles[role]) ?? (fb ? bindingOf(base.roles[fb]) : undefined);
    if (b) bindings[role] = b;
  }
  const fallback: Binding = { modelId: models[0]?.id ?? '', temperature: 0.8, maxTokens: 2048, reasoning: 'default' };
  return {
    version: 2,
    connections,
    models,
    ...buildTiers(bindings, fallback),
    ...emptyRest(),
    performance: { jobConcurrency: 2, requestTimeoutMs: base.llm.timeoutMs },
  };
}

/** v1 → v2: every role keeps its exact model, temperature and max tokens. */
export function migrateLegacy(old: LegacyRuntimeSettings): RuntimeSettings {
  const connections: ConnectionCfg[] = [];
  const connIdOf: Partial<Record<z.infer<typeof ProviderKind>, string>> = {};
  for (const kind of ['anthropic', 'openai_compat'] as const) {
    const p = old.providers[kind];
    const used = old.favourites.some((f) => f.provider === kind);
    if (!p?.apiKey && !p?.baseUrl && !used) continue;
    const baseUrl = p?.baseUrl ?? '';
    const preset = detectPreset(kind, baseUrl);
    const cid = legacyConnectionId(kind, baseUrl);
    connIdOf[kind] = cid;
    connections.push({ id: cid, label: PRESETS[preset].label, kind, preset, baseUrl, apiKey: p?.apiKey ?? '' });
  }
  const models: ModelEntry[] = old.favourites.map((f) => {
    const providerId = connIdOf[f.provider] ?? legacyConnectionId(f.provider);
    const preset = connections.find((c) => c.id === providerId)?.preset ?? 'custom';
    return { id: f.id, label: f.label, providerId, model: f.model, caps: defaultCaps(preset) };
  });
  const bindingOf = (role: string): Binding | undefined => {
    const r = old.roles[role];
    return r ? { modelId: r.favouriteId, temperature: r.temperature, maxTokens: r.maxTokens, reasoning: 'default' } : undefined;
  };
  const bindings: Partial<Record<RoleName, Binding>> = {};
  for (const role of ALL_ROLES) {
    const fb = LATE_ROLE_FALLBACK[role];
    const b = bindingOf(role) ?? (fb ? bindingOf(fb) : undefined);
    if (b) bindings[role] = b;
  }
  const fallback: Binding = { modelId: models[0]?.id ?? '', temperature: 0.8, maxTokens: 2048, reasoning: 'default' };
  return {
    version: 2,
    connections,
    models,
    ...buildTiers(bindings, fallback),
    prompts: old.prompts,
    seeds: old.seeds,
    verbosity: old.verbosity,
    tone: old.tone,
    performance: old.performance,
  };
}

// ---- Validation and compilation ----

/** A connection is usable when it has what its kind needs to make a call. */
export function connectionUsable(c: ConnectionCfg): boolean {
  if (!c.baseUrl.trim() && c.kind === 'openai_compat') return false;
  return !!c.apiKey.trim() || c.preset === 'local';
}

/** Throws a readable Error when the settings are inconsistent. */
export function validateSettings(s: RuntimeSettings): void {
  const dup = (xs: { id: string }[], what: string) => {
    const seen = new Set<string>();
    for (const x of xs) {
      if (seen.has(x.id)) throw new Error(`duplicate ${what} id '${x.id}'`);
      seen.add(x.id);
    }
  };
  dup(s.connections, 'provider');
  dup(s.models, 'model');
  dup(s.tiers, 'tier');
  if (!s.tiers.length) throw new Error('at least one tier is required');
  const connIds = new Set(s.connections.map((c) => c.id));
  for (const m of s.models) {
    if (!connIds.has(m.providerId)) throw new Error(`model '${m.label || m.id}' uses an unknown provider '${m.providerId}'`);
  }
  const modelIds = new Set(s.models.map((m) => m.id));
  for (const t of s.tiers) {
    if (t.modelId && !modelIds.has(t.modelId)) throw new Error(`tier '${t.label}' uses an unknown model '${t.modelId}'`);
  }
  const tierIds = new Set(s.tiers.map((t) => t.id));
  const missing: Record<string, string[]> = {};
  for (const [role, tierId] of Object.entries(s.roleTiers)) {
    if (!RoleName.safeParse(role).success) throw new Error(`unknown role '${role}'`);
    if (!tierIds.has(tierId)) (missing[tierId] ??= []).push(ROLE_LABELS[role as RoleName]);
  }
  for (const [tierId, roles] of Object.entries(missing)) {
    throw new Error(`tier '${tierId}' doesn't exist but is still used by: ${roles.join(', ')}. Reassign those roles first.`);
  }
}

/** The tier a role resolves to (explicit map → default tier → first tier). */
export function tierForRole(s: RuntimeSettings, role: RoleName): TierCfg | undefined {
  return s.tiers.find((t) => t.id === s.roleTiers[role]) ?? s.tiers.find((t) => t.id === DEFAULT_ROLE_TIER[role]) ?? s.tiers[0];
}

/** Compile runtime settings into the EffectiveConfig the registry consumes. */
export function compileSettings(s: RuntimeSettings, llm: { maxRetries: number }): EffectiveConfig {
  const connections: Record<string, ResolvedConnection> = {};
  for (const c of s.connections) {
    if (!connectionUsable(c)) continue;
    connections[c.id] = { id: c.id, label: c.label || PRESETS[c.preset].label, kind: c.kind, preset: c.preset, baseUrl: c.baseUrl.trim() || PRESETS[c.preset].baseUrl, apiKey: c.apiKey };
  }
  const usableModels = s.models.filter((m) => connections[m.providerId] && m.model.trim());
  const baseProfile = (m: ModelEntry): Omit<ModelProfile, 'temperature' | 'maxTokens'> => {
    const conn = connections[m.providerId]!;
    return { connectionId: conn.id, provider: conn.kind, preset: conn.preset, model: m.model.trim(), contextWindow: 200_000, caps: m.caps };
  };

  const modelProfiles: Record<string, ModelProfile> = {};
  // fav:<modelId> — a model with default parameters (kept so pre-v2 per-story
  // overrides that name a favourite keep working).
  for (const m of usableModels) {
    modelProfiles[`fav:${m.id}`] = { ...baseProfile(m), temperature: m.caps.sampling ? 0.8 : undefined, maxTokens: 2048 };
  }
  // tier:<tierId> — a tier's model with its parameters, filtered by the model's caps.
  for (const t of s.tiers) {
    const m = usableModels.find((x) => x.id === t.modelId) ?? usableModels[0];
    if (!m) continue;
    let reasoning: ModelProfile['reasoning'] = t.reasoning;
    if (m.caps.reasoning === 'none' || (m.caps.reasoning === 'always' && t.reasoning === 'off')) reasoning = undefined;
    modelProfiles[`tier:${t.id}`] = {
      ...baseProfile(m),
      temperature: m.caps.sampling ? t.temperature : undefined,
      maxTokens: t.maxTokens,
      reasoning,
      effort: m.caps.reasoning === 'none' ? undefined : t.effort,
    };
  }
  // role:<role> — what each role runs (its tier's profile).
  const roles: EffectiveConfig['roles'] = {};
  for (const role of ALL_ROLES) {
    const tier = tierForRole(s, role);
    const p = tier ? modelProfiles[`tier:${tier.id}`] : undefined;
    if (!p) continue;
    modelProfiles[`role:${role}`] = { ...p };
    roles[role] = `role:${role}`;
  }
  return { connections, modelProfiles, roles, llm: { timeoutMs: s.performance.requestTimeoutMs, maxRetries: llm.maxRetries } };
}

// ---- The service ----

export interface ConnectionUpdate {
  id: string;
  label?: string;
  kind?: z.infer<typeof ProviderKind>;
  preset?: z.infer<typeof ProviderPreset>;
  baseUrl?: string;
  /** Blank or omitted = keep the saved key. */
  apiKey?: string;
}

export interface SettingsUpdate {
  connections?: ConnectionUpdate[];
  models?: z.input<typeof ModelEntry>[];
  tiers?: z.input<typeof TierCfg>[];
  roleTiers?: Record<string, string>;
  prompts?: Record<string, string>;
  seeds?: string;
  verbosity?: Record<string, string>;
  tone?: string;
  performance?: Partial<RuntimeSettings['performance']>;
}

export interface SettingsService {
  get(): RuntimeSettings;
  effective(): EffectiveConfig;
  update(patch: SettingsUpdate): RuntimeSettings;
  promptOverride(name: string): string | undefined;
  /** The user's seed-phrase override (one per line), or undefined to use the shipped file. */
  seedsOverride(): string | undefined;
  /** Per-step verbosity-string overrides ("1".."5"); empty map = all built-in. */
  verbosityOverride(): Record<string, string>;
  /** Default narrator tone for new stories, or undefined to use the built-in default. */
  toneDefault(): string | undefined;
  /** Throughput tuning: job concurrency + request timeout. */
  performance(): RuntimeSettings['performance'];
  /** A saved connection (with its key) — for server-side calls like key tests. Never send to clients. */
  connection(id: string): ConnectionCfg | undefined;
  onChange(listener: () => void): void;
  /** Masked view for the API (never leaks API keys). */
  publicView(): PublicSettingsView;
}

export interface PublicSettingsView {
  connections: (Omit<ConnectionCfg, 'apiKey'> & { configured: boolean; usable: boolean; hint: string })[];
  models: ModelEntry[];
  tiers: TierCfg[];
  /** Every role with the tier it resolves to (defaults applied). */
  roleTiers: Record<string, string>;
  roles: { role: RoleName; label: string; defaultTier: string }[];
  presets: typeof PRESETS;
  prompts: { name: string; label: string; overridden: boolean }[];
  performance: RuntimeSettings['performance'];
}

/** Load stored settings: v2 as-is, v1 migrated (and backed up), else seed from config.json. */
function loadOrSeed(store: SettingsStore, base: Config): RuntimeSettings {
  const stored = store.get<unknown>(KEY, null);
  if (stored && typeof stored === 'object' && (stored as { version?: unknown }).version === 2) {
    const parsed = RuntimeSettings.safeParse(stored);
    if (parsed.success) return parsed.data;
    logger.warn('stored runtimeConfig (v2) invalid, reseeding from config.json', { issues: parsed.error.issues.slice(0, 3) });
  } else if (stored) {
    const legacy = LegacyRuntimeSettings.safeParse(stored);
    if (legacy.success) {
      const migrated = migrateLegacy(legacy.data);
      store.set(LEGACY_BACKUP_KEY, stored);
      store.set(KEY, migrated);
      logger.info('migrated runtime settings to provider connections + model tiers', { tiers: migrated.tiers.map((t) => t.label) });
      return migrated;
    }
    logger.warn('stored runtimeConfig invalid, reseeding from config.json');
  }
  const seeded = seedFromConfig(base);
  store.set(KEY, seeded);
  return seeded;
}

export function createSettingsService(store: SettingsStore, base: Config): SettingsService {
  // Re-validate the boot config shape (callers may pass a hand-built object).
  const boot = ConfigSchema.parse(base);
  let settings = loadOrSeed(store, boot);
  let compiled = compileSettings(settings, boot.llm);
  const listeners: (() => void)[] = [];

  return {
    get: () => settings,
    effective: () => compiled,
    promptOverride: (name) => settings.prompts[name],
    seedsOverride: () => (settings.seeds && settings.seeds.trim() ? settings.seeds : undefined),
    verbosityOverride: () => settings.verbosity ?? {},
    toneDefault: () => (settings.tone && settings.tone.trim() ? settings.tone.trim() : undefined),
    performance: () => settings.performance,
    connection: (cid) => settings.connections.find((c) => c.id === cid),
    onChange: (l) => listeners.push(l),

    update(patch: SettingsUpdate) {
      let connections = settings.connections;
      if (patch.connections) {
        connections = patch.connections.map((incoming) => {
          const prev = settings.connections.find((c) => c.id === incoming.id);
          const preset = incoming.preset ?? prev?.preset ?? (incoming.kind ? detectPreset(incoming.kind, incoming.baseUrl ?? '') : 'custom');
          const kind = incoming.kind ?? prev?.kind ?? PRESETS[preset].kind;
          return {
            id: incoming.id,
            label: incoming.label ?? prev?.label ?? PRESETS[preset].label,
            kind,
            preset,
            baseUrl: (incoming.baseUrl ?? prev?.baseUrl ?? PRESETS[preset].baseUrl).trim(),
            apiKey: incoming.apiKey && incoming.apiKey.trim() ? incoming.apiKey.trim() : prev?.apiKey ?? '',
          };
        });
      }
      const merged: RuntimeSettings = RuntimeSettings.parse({
        version: 2,
        connections,
        models: patch.models ?? settings.models,
        tiers: patch.tiers ?? settings.tiers,
        roleTiers: patch.roleTiers ?? settings.roleTiers,
        prompts: patch.prompts ?? settings.prompts,
        seeds: patch.seeds ?? settings.seeds,
        verbosity: patch.verbosity ?? settings.verbosity,
        tone: patch.tone ?? settings.tone,
        performance: { ...settings.performance, ...(patch.performance ?? {}) },
      });
      // Validate + compile eagerly so an invalid change is rejected before persisting.
      validateSettings(merged);
      const nextCompiled = compileSettings(merged, boot.llm);
      settings = merged;
      compiled = nextCompiled;
      store.set(KEY, settings);
      for (const l of listeners) l();
      return settings;
    },

    publicView() {
      return {
        connections: settings.connections.map(({ apiKey, ...c }) => ({
          ...c,
          configured: !!apiKey,
          usable: connectionUsable({ ...c, apiKey }),
          hint: apiKey ? '••••' + apiKey.slice(-4) : '',
        })),
        models: settings.models,
        tiers: settings.tiers,
        roleTiers: Object.fromEntries(ALL_ROLES.map((r) => [r, tierForRole(settings, r)?.id ?? ''])),
        roles: ALL_ROLES.map((role) => ({ role, label: ROLE_LABELS[role], defaultTier: DEFAULT_ROLE_TIER[role] })),
        presets: PRESETS,
        prompts: EDITABLE_PROMPTS.map((p) => ({ ...p, overridden: settings.prompts[p.name] !== undefined })),
        performance: settings.performance,
      };
    },
  };
}

/** Make a fresh short id for a new connection / model / tier. */
export function newSettingsId(prefix: string): string {
  return `${prefix}${id(6)}`;
}
