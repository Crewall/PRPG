import { readFileSync } from 'node:fs';
import { z } from 'zod';

// ---- Schemas (Zod is the single source of truth; see 01-tech-stack.md) ----

export const RoleName = z.enum([
  'storyteller',
  'npc',
  'scribe_memory',
  'scribe_story',
  'overseer',
  'context_planner',
  'adjudicator',
  'player_intake',
]);
export type RoleName = z.infer<typeof RoleName>;

const ServerSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(7777),
  // Optional shared token for LAN exposure (checked by API middleware if set).
  token: z.string().optional(),
});

const DbSchema = z.object({
  path: z.string().default('data/prpg.db'),
});

const AnthropicProvider = z.object({
  apiKey: z.string().min(1, 'anthropic.apiKey must not be empty'),
  baseUrl: z.string().url().default('https://api.anthropic.com'),
});

const OpenAiCompatProvider = z.object({
  apiKey: z.string().min(1, 'openai_compat.apiKey must not be empty'),
  baseUrl: z.string().url(),
});

const ProvidersSchema = z
  .object({
    anthropic: AnthropicProvider.optional(),
    openai_compat: OpenAiCompatProvider.optional(),
  })
  .refine((p) => p.anthropic || p.openai_compat, {
    message: 'At least one provider (anthropic or openai_compat) must be configured.',
  });

export const ProviderKind = z.enum(['anthropic', 'openai_compat']);
export type ProviderKind = z.infer<typeof ProviderKind>;

const ModelProfileSchema = z.object({
  provider: ProviderKind,
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.8),
  maxTokens: z.number().int().positive().default(2048),
  // Rough context window used for budget assertions in the context builder.
  contextWindow: z.number().int().positive().default(200_000),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    db: DbSchema.default({}),
    providers: ProvidersSchema,
    modelProfiles: z.record(z.string(), ModelProfileSchema),
    roles: z.record(RoleName, z.string()),
    llm: z
      .object({
        timeoutMs: z.number().int().positive().default(120_000),
        maxRetries: z.number().int().min(0).default(2),
      })
      .default({}),
  })
  .superRefine((cfg, ctx) => {
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
    // ...and every profile's provider must be configured.
    for (const [name, profile] of Object.entries(cfg.modelProfiles)) {
      if (!cfg.providers[profile.provider]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modelProfiles', name, 'provider'],
          message: `model profile '${name}' uses provider '${profile.provider}' which is not configured under providers`,
        });
      }
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

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
