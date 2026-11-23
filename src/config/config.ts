import { readFileSync } from 'node:fs';
import { z } from 'zod';

// ---- Schemas (Zod is the single source of truth) ----
//
// Two shapes live here:
//  - `Config`: the boot file (config.json). Only the FIRST-boot seed; after that
//    the settings DB is the source of truth (settingsService.ts).
//  - `EffectiveConfig`: what the LLM registry consumes — resolved connections
//    and model profiles, compiled from the runtime settings.

export const RoleName = z.enum([
  'storyteller',
  'npc',
  'scribe_memory',
  'scribe_story',
  'overseer',
  'context_planner',
  'adjudicator',
  'player_intake',
  'randomizer',
  // Minds engine (docs/10).
  'narrator',
  'character',
  'distributor',
  'seeder',
  'compactor',
  'director',
]);
export type RoleName = z.infer<typeof RoleName>;
export const ALL_ROLES: RoleName[] = RoleName.options;

export const ROLE_LABELS: Record<RoleName, string> = {
  storyteller: 'Storyteller',
  npc: 'NPC',
  scribe_memory: 'Memory scribe',
  scribe_story: 'Story scribe',
  overseer: 'Rule overseer',
  context_planner: 'Context planner',
  adjudicator: 'Adjudicator',
  player_intake: 'Character interviewer',
  randomizer: 'Premise randomizer',
  narrator: 'Narrator (Minds)',
  character: 'Character mind (Minds)',
  distributor: 'Round-block fallback (Minds)',
  seeder: 'New-character seeder (Minds)',
  compactor: 'Thread compactor (Minds)',
  director: 'Director: who is spoken to (Minds)',
};

const ServerSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(7777),
  // Optional shared token for LAN exposure (checked by API middleware if set).
  token: z.string().optional(),
});

const DbSchema = z.object({
  path: z.string().default('data/prpg.db'),
});

export const ProviderKind = z.enum(['anthropic', 'openai_compat']);
export type ProviderKind = z.infer<typeof ProviderKind>;

// Connection presets (doc 12 §2): fill in the kind and base URL; everything stays editable.
export const ProviderPreset = z.enum(['deepseek', 'openrouter', 'openai', 'local', 'anthropic', 'custom']);
export type ProviderPreset = z.infer<typeof ProviderPreset>;

export const PRESETS: Record<ProviderPreset, { label: string; kind: ProviderKind; baseUrl: string; keyOptional?: boolean }> = {
  deepseek: { label: 'DeepSeek', kind: 'openai_compat', baseUrl: 'https://api.deepseek.com' },
  openrouter: { label: 'OpenRouter', kind: 'openai_compat', baseUrl: 'https://openrouter.ai/api/v1' },
  openai: { label: 'OpenAI', kind: 'openai_compat', baseUrl: 'https://api.openai.com/v1' },
  local: { label: 'Local (llama.cpp / Ollama)', kind: 'openai_compat', baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true },
  anthropic: { label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  custom: { label: 'Custom (OpenAI-compatible)', kind: 'openai_compat', baseUrl: '' },
};

/** Guess the preset of a connection from its kind and base URL. */
export function detectPreset(kind: ProviderKind, baseUrl: string): ProviderPreset {
  if (kind === 'anthropic') return 'anthropic';
  const u = baseUrl.toLowerCase();
  if (u.includes('openrouter.ai')) return 'openrouter';
  if (u.includes('api.deepseek.com')) return 'deepseek';
  if (u.includes('api.openai.com')) return 'openai';
  if (u.includes('127.0.0.1') || u.includes('localhost')) return 'local';
  return 'custom';
}

// What a model accepts (doc 12 §3). Pre-filled from the preset, editable.
//  sampling: may we send temperature?
//  reasoning: 'none' (no reasoning switch), 'toggle' (can be turned on/off), 'always' (mandatory)
//  json: 'schema' (structured outputs), 'json_object' (JSON mode), 'prompt' (instructions only)
export const ModelCaps = z.object({
  sampling: z.boolean().default(true),
  reasoning: z.enum(['none', 'toggle', 'always']).default('none'),
  json: z.enum(['schema', 'json_object', 'prompt']).default('json_object'),
  /** Effort levels the model accepts (from the provider's model list); absent = unknown, send what the tier says. */
  efforts: z.array(z.string()).optional(),
});
export type ModelCaps = z.infer<typeof ModelCaps>;

/**
 * Caps from an OpenAI-compatible model-list entry. OpenRouter adds
 * `supported_parameters` and a `reasoning` object
 * ({ mandatory, supported_efforts, … }): mandatory reasoning → 'always' (it
 * can't be switched off), and only the listed effort levels are sent.
 */
export function capsFromListing(
  m: { supported_parameters?: string[]; reasoning?: { mandatory?: boolean; supported_efforts?: string[] } | null },
  preset: ProviderPreset,
): ModelCaps {
  const params = m.supported_parameters;
  const r = m.reasoning ?? undefined;
  if (!params && !r) return defaultCaps(preset);
  const p = params ?? [];
  const hasReasoning = !!r || p.includes('reasoning') || p.includes('reasoning_effort');
  const efforts = r?.supported_efforts?.filter((e) => ['low', 'medium', 'high', 'max'].includes(e));
  return {
    sampling: params ? p.includes('temperature') : true,
    reasoning: !hasReasoning ? 'none' : r?.mandatory ? 'always' : 'toggle',
    json: p.includes('structured_outputs') ? 'schema' : p.includes('response_format') ? 'json_object' : 'prompt',
    ...(efforts && efforts.length ? { efforts } : {}),
  };
}

export function defaultCaps(preset: ProviderPreset): ModelCaps {
  if (preset === 'deepseek' || preset === 'openrouter') return { sampling: true, reasoning: 'toggle', json: 'json_object' };
  return { sampling: true, reasoning: 'none', json: 'json_object' };
}

export const ReasoningSetting = z.enum(['off', 'on', 'default']);
export type ReasoningSetting = z.infer<typeof ReasoningSetting>;
export const Effort = z.enum(['low', 'medium', 'high', 'max']);
export type Effort = z.infer<typeof Effort>;

const AnthropicProvider = z.object({
  apiKey: z.string().min(1, 'anthropic.apiKey must not be empty'),
  baseUrl: z.string().url().default('https://api.anthropic.com'),
});

const OpenAiCompatProvider = z.object({
  apiKey: z.string().min(1, 'openai_compat.apiKey must not be empty'),
  baseUrl: z.string().url(),
});

// A named connection in config.json (new style). `kind` follows from `preset` when omitted.
const BootConnection = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  preset: ProviderPreset.optional(),
  kind: ProviderKind.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().default(''),
});

const ModelProfileSchema = z.object({
  // Legacy: the provider kind (resolved to the connection of that kind).
  provider: ProviderKind.optional(),
  // New: a connection id from `connections`.
  connection: z.string().optional(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.8),
  maxTokens: z.number().int().positive().default(2048),
  // Rough context window used for budget assertions in the context builder.
  contextWindow: z.number().int().positive().default(200_000),
  reasoning: ReasoningSetting.optional(),
  effort: Effort.optional(),
});

export const ConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    db: DbSchema.default({}),
    providers: z
      .object({
        anthropic: AnthropicProvider.optional(),
        openai_compat: OpenAiCompatProvider.optional(),
      })
      .default({}),
    connections: z.array(BootConnection).default([]),
    modelProfiles: z.record(z.string(), ModelProfileSchema),
    roles: z.record(RoleName, z.string()),
    llm: z
      .object({
        timeoutMs: z.number().int().positive().default(180_000),
        maxRetries: z.number().int().min(0).default(2),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.providers.anthropic && !cfg.providers.openai_compat && cfg.connections.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers'], message: 'At least one provider (a connection, or anthropic / openai_compat) must be configured.' });
    }
    const connIds = new Set(cfg.connections.map((c) => c.id));
    // Every role must point at a defined model profile...
    for (const [role, profileName] of Object.entries(cfg.roles)) {
      if (!cfg.modelProfiles[profileName]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', role],
          message: `role '${role}' references unknown model profile '${profileName}'`,
        });
      }
    }
    // ...and every profile's provider/connection must be configured.
    for (const [name, profile] of Object.entries(cfg.modelProfiles)) {
      if (profile.connection) {
        if (!connIds.has(profile.connection)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelProfiles', name, 'connection'], message: `model profile '${name}' uses connection '${profile.connection}' which is not defined under connections` });
        }
      } else if (!profile.provider) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modelProfiles', name], message: `model profile '${name}' needs a 'connection' (or a legacy 'provider')` });
      } else if (!cfg.providers[profile.provider]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modelProfiles', name, 'provider'],
          message: `model profile '${name}' uses provider '${profile.provider}' which is not configured under providers`,
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

// ---- The effective (compiled) configuration the LLM registry consumes ----

export interface ResolvedConnection {
  id: string;
  label: string;
  kind: ProviderKind;
  preset: ProviderPreset;
  baseUrl: string;
  apiKey: string;
}

/** A model profile resolved to a concrete connection + parameters. */
export interface ModelProfile {
  /** Connection id (absent only in hand-built test profiles). */
  connectionId?: string;
  provider: ProviderKind;
  preset?: ProviderPreset;
  model: string;
  /** Undefined = don't send a temperature at all. */
  temperature?: number;
  maxTokens: number;
  contextWindow: number;
  /** Already filtered by the model's caps: undefined = send nothing. */
  reasoning?: ReasoningSetting;
  effort?: Effort;
  caps?: ModelCaps;
}

export interface EffectiveConfig {
  connections: Record<string, ResolvedConnection>;
  modelProfiles: Record<string, ModelProfile>;
  roles: Partial<Record<RoleName, string>>;
  llm: { timeoutMs: number; maxRetries: number };
}

/** The legacy connection id for a provider kind (config.json `providers` and pre-v2 settings). */
export function legacyConnectionId(kind: ProviderKind, baseUrl = ''): string {
  if (kind === 'anthropic') return 'anthropic';
  const preset = detectPreset(kind, baseUrl);
  return preset === 'custom' ? 'openai_compat' : preset;
}

/** All connections declared by a boot config: new-style `connections` plus legacy `providers`. */
export function bootConnections(cfg: Config): ResolvedConnection[] {
  const out: ResolvedConnection[] = [];
  for (const c of cfg.connections) {
    const preset = c.preset ?? (c.kind ? detectPreset(c.kind, c.baseUrl ?? '') : 'custom');
    const kind = c.kind ?? PRESETS[preset].kind;
    out.push({ id: c.id, label: c.label || PRESETS[preset].label, kind, preset, baseUrl: c.baseUrl || PRESETS[preset].baseUrl, apiKey: c.apiKey });
  }
  if (cfg.providers.anthropic) {
    out.push({ id: 'anthropic', label: 'Anthropic', kind: 'anthropic', preset: 'anthropic', baseUrl: cfg.providers.anthropic.baseUrl, apiKey: cfg.providers.anthropic.apiKey });
  }
  if (cfg.providers.openai_compat) {
    const p = cfg.providers.openai_compat;
    const preset = detectPreset('openai_compat', p.baseUrl);
    out.push({ id: legacyConnectionId('openai_compat', p.baseUrl), label: PRESETS[preset].label, kind: 'openai_compat', preset, baseUrl: p.baseUrl, apiKey: p.apiKey });
  }
  return out;
}

/** The connection id a boot model profile resolves to. */
export function profileConnectionId(cfg: Config, profile: Config['modelProfiles'][string]): string {
  if (profile.connection) return profile.connection;
  const kind = profile.provider ?? 'openai_compat';
  return legacyConnectionId(kind, kind === 'openai_compat' ? cfg.providers.openai_compat?.baseUrl ?? '' : '');
}

/**
 * Compile a boot config straight into an EffectiveConfig (no settings DB). Used
 * by the smoke script; the app goes through the settings service instead.
 */
export function effectiveFromConfig(cfg: Config): EffectiveConfig {
  const connections: Record<string, ResolvedConnection> = {};
  for (const c of bootConnections(cfg)) connections[c.id] = c;
  const modelProfiles: Record<string, ModelProfile> = {};
  for (const [name, p] of Object.entries(cfg.modelProfiles)) {
    const conn = connections[profileConnectionId(cfg, p)];
    if (!conn) continue;
    modelProfiles[name] = {
      connectionId: conn.id,
      provider: conn.kind,
      preset: conn.preset,
      model: p.model,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      contextWindow: p.contextWindow,
      reasoning: p.reasoning,
      effort: p.effort,
      caps: defaultCaps(conn.preset),
    };
  }
  return { connections, modelProfiles, roles: { ...cfg.roles }, llm: cfg.llm };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Parse + validate an already-loaded config object. Throws ConfigError with a readable message. */
export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/** Load and validate config.json from disk. */
export function loadConfig(path = 'config.json'): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Could not read config file '${path}'. Copy config.example.json to config.json and add your API key(s). (${(err as Error).message})`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config file '${path}' is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(json);
}
