import type { Config } from './config/config.ts';
import { openDb, migrate } from './db/db.ts';
import type { Db } from './db/db.ts';
import { createStoryStore } from './db/stores/storyStore.ts';
import { createAgentStore } from './db/stores/agentStore.ts';
import { createThreadLog } from './db/stores/threadLog.ts';
import { createSettingsStore } from './db/stores/settingsStore.ts';
import { createRegistry } from './llm/registry.ts';
import type { DriverFactory, LlmRegistry } from './llm/registry.ts';
import { createContextBuilder } from './orchestrator/contextBuilder.ts';
import { TurnPipeline } from './orchestrator/turnPipeline.ts';

// The wired application: stores + registry + orchestrator. Constructed once at
// boot (src/index.ts) and shared by the API/WS layers. Also constructed directly
// in tests with a ReplayDriver factory.
export interface App {
  config: Config;
  db: Db;
  stories: ReturnType<typeof createStoryStore>;
  agents: ReturnType<typeof createAgentStore>;
  threadLog: ReturnType<typeof createThreadLog>;
  settings: ReturnType<typeof createSettingsStore>;
  registry: LlmRegistry;
  pipeline: TurnPipeline;
  close(): void;
}

export function createApp(config: Config, opts: { driverFactory?: DriverFactory; dbPath?: string } = {}): App {
  const db = openDb(opts.dbPath ?? config.db.path);
  migrate(db);

  const stories = createStoryStore(db);
  const agents = createAgentStore(db);
  const threadLog = createThreadLog(db);
  const settings = createSettingsStore(db);
  const registry = createRegistry(config, opts.driverFactory);
  const contexts = createContextBuilder(stories);
  const pipeline = new TurnPipeline({ stories, agents, threadLog, registry, contexts });

  return {
    config,
    db,
    stories,
    agents,
    threadLog,
    settings,
    registry,
    pipeline,
    close: () => db.close(),
  };
}
