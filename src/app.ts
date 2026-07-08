import type { Config } from './config/config.ts';
import { openDb, migrate } from './db/db.ts';
import type { Db } from './db/db.ts';
import { createStoryStore } from './db/stores/storyStore.ts';
import { createAgentStore } from './db/stores/agentStore.ts';
import { createThreadLog } from './db/stores/threadLog.ts';
import { createSettingsStore } from './db/stores/settingsStore.ts';
import { createSummaryStore } from './db/stores/summaryStore.ts';
import { createJobStore } from './db/stores/jobStore.ts';
import { createMemoryStore } from './db/stores/memoryStore.ts';
import { createSuggestionStore } from './db/stores/suggestionStore.ts';
import { createSnapshotStore } from './db/stores/snapshotStore.ts';
import { createRegistry } from './llm/registry.ts';
import type { DriverFactory, LlmRegistry } from './llm/registry.ts';
import { createSettingsService } from './config/settingsService.ts';
import type { SettingsService } from './config/settingsService.ts';
import { setPromptOverrideProvider } from './agents/prompts.ts';
import { createContextBuilder } from './orchestrator/contextBuilder.ts';
import { TurnPipeline } from './orchestrator/turnPipeline.ts';
import { JobWorker } from './orchestrator/postTurn.ts';
import { createScribeStoryHandler } from './orchestrator/handlers.ts';
import { createScribeMemoryHandler, createMemoryMaintenanceHandler, createArchiveFadedHandler, createNpcDossierHandler } from './orchestrator/memoryHandlers.ts';
import { EventBus } from './util/events.ts';

// The wired application: stores + registry + orchestrator + job worker. Built
// once at boot (src/index.ts) and shared by the API/WS layers. Also built
// directly in tests with a ReplayDriver factory.
export interface App {
  config: Config;
  db: Db;
  events: EventBus;
  stories: ReturnType<typeof createStoryStore>;
  agents: ReturnType<typeof createAgentStore>;
  threadLog: ReturnType<typeof createThreadLog>;
  settings: ReturnType<typeof createSettingsStore>;
  summaries: ReturnType<typeof createSummaryStore>;
  jobs: ReturnType<typeof createJobStore>;
  memory: ReturnType<typeof createMemoryStore>;
  suggestions: ReturnType<typeof createSuggestionStore>;
  snapshots: ReturnType<typeof createSnapshotStore>;
  settingsService: SettingsService;
  registry: LlmRegistry;
  pipeline: TurnPipeline;
  worker: JobWorker;
  close(): void;
}

export function createApp(config: Config, opts: { driverFactory?: DriverFactory; dbPath?: string; startWorker?: boolean; rng?: () => number } = {}): App {
  const db = openDb(opts.dbPath ?? config.db.path);
  migrate(db);

  const events = new EventBus();
  const stories = createStoryStore(db);
  const agents = createAgentStore(db);
  const threadLog = createThreadLog(db, events);
  const settings = createSettingsStore(db);
  const summaries = createSummaryStore(db);
  const jobs = createJobStore(db);
  const memory = createMemoryStore(db);
  const suggestions = createSuggestionStore(db);
  const snapshots = createSnapshotStore(db);

  // Runtime settings: seed from config.json, then the DB is the source of truth.
  // The registry reads the compiled effective config live, and prompt overrides
  // route through the settings service.
  const settingsService = createSettingsService(settings, config);
  setPromptOverrideProvider((name) => settingsService.promptOverride(name));
  const registry = createRegistry(() => settingsService.effective(), opts.driverFactory);
  const contexts = createContextBuilder({ stories, summaries, memory, verbosityOverride: () => settingsService.verbosityOverride() });
  const pipeline = new TurnPipeline({ stories, agents, threadLog, jobs, memory, summaries, snapshots, registry, contexts, events, rng: opts.rng });

  // Job worker + handlers (post-turn scribes; player path never awaits these).
  const worker = new JobWorker(jobs, events, { concurrency: () => settingsService.performance().jobConcurrency });
  const handlerDeps = { db, stories, summaries, agents, threadLog, registry, events, memory, suggestions, jobs };
  worker.register('scribe_story', createScribeStoryHandler(handlerDeps));
  worker.register('scribe_memory', createScribeMemoryHandler(handlerDeps));
  worker.register('memory_maintenance', createMemoryMaintenanceHandler(handlerDeps));
  worker.register('archive_faded', createArchiveFadedHandler(handlerDeps));
  worker.register('npc_dossier', createNpcDossierHandler(handlerDeps));

  if (opts.startWorker !== false) worker.start();

  return {
    config,
    db,
    events,
    stories,
    agents,
    threadLog,
    settings,
    summaries,
    jobs,
    memory,
    suggestions,
    snapshots,
    settingsService,
    registry,
    pipeline,
    worker,
    close: () => {
      worker.stop();
      db.close();
    },
  };
}
