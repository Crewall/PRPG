# 02 — System Architecture

## Bird's-eye view

Single Node.js process. All "AI threads" are **logical sessions** (independent
message histories + independently scoped context), not OS threads — they run as
concurrent async tasks inside the orchestrator.

```
┌────────────────────────────  Browser (phone or desktop)  ───────────────────────────┐
│  Svelte SPA: Chat view · Memory browser · Thread inspector (debug) · Settings       │
└───────────────▲───────────────────────────────▲─────────────────────────────────────┘
                │ REST (setup/CRUD)             │ WebSocket (turn streaming, events)
┌───────────────┴───────────────────────────────┴─────────────────────────────────────┐
│                              Fastify server (Node.js)                               │
│                                                                                     │
│  ┌───────────┐   ┌──────────────────────── Orchestrator ─────────────────────────┐  │
│  │ API layer │──▶│  TurnPipeline: context build → storyteller/NPC fan-out →      │  │
│  └───────────┘   │  overseer gate → emit → async scribes                         │  │
│                  └──┬───────────┬───────────┬───────────┬───────────┬────────────┘  │
│                     ▼           ▼           ▼           ▼           ▼               │
│               Storyteller   NPC agent   NPC agent   ScribeMemory ScribeStory        │
│                 session      session     session      session      session          │
│                     └───────────┴─────┬─────┴───────────┴───────────┘               │
│                                       ▼                                             │
│                        LLM Adapter (Anthropic / OpenAI-compatible drivers)          │
│                                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ MemoryStore  │  │ StoryStore    │  │ ThreadLog    │  │ ConfigStore            │  │
│  │ (objects,    │  │ (turns,       │  │ (every agent │  │ (providers, models,    │  │
│  │  facts, FTS) │  │  summaries)   │  │  prompt/resp)│  │  rules, settings)      │  │
│  └──────┬───────┘  └──────┬────────┘  └──────┬───────┘  └───────────┬────────────┘  │
│         └─────────────────┴────── SQLite (one file per install) ────┘               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Key architectural decisions

### D1 — Agents are sessions, not processes
Every agent = `{ id, role, systemPrompt, contextBuilder, model config }`. An agent
**never sees the raw global history**; it sees only what its `contextBuilder`
assembles for it (this is what enforces NPC knowledge isolation). Sessions are
persisted, so a story survives server restarts and NPC sessions survive scenes.

### D2 — One synchronous "player path", asynchronous everything else
The player-visible latency path is: context build → storyteller (streamed) →
(optional NPC consult) → overseer gate. The scribes run **after** the turn is
emitted, in the background; their results affect the *next* turn. This keeps
per-turn latency close to a single LLM call in the common case.

### D3 — Everything an agent sends/receives is logged
`ThreadLog` records every prompt and response of every session, tagged with
`turnId` and `agentId`. The debug UI is just a viewer over this table — the
"hidden threads visible for troubleshooting" requirement costs nothing extra.

### D4 — All cross-agent communication is typed JSON through the orchestrator
Agents never talk to each other directly. The storyteller "asks an NPC" by
returning a structured directive; the orchestrator performs the NPC call and
feeds the result back. This keeps the flow inspectable and prevents prompt
soup between models.

## Module layout (source tree)

```
prpg/
├─ config.example.json
├─ src/
│  ├─ index.ts                 # bootstrap: config → db → server → routes
│  ├─ config/
│  │  └─ config.ts             # load/validate config.json (Zod), hot-reloadable settings
│  ├─ db/
│  │  ├─ db.ts                 # open DB, migrations runner
│  │  ├─ migrations/           # 001-init.sql, 002-..., plain SQL files
│  │  └─ stores/
│  │     ├─ storyStore.ts      # turns, scenes, summaries
│  │     ├─ memoryStore.ts     # memory objects, facts, knowledge links, FTS
│  │     ├─ agentStore.ts      # agent definitions + session messages
│  │     ├─ threadLog.ts       # full prompt/response audit log
│  │     └─ settingsStore.ts   # runtime-tweakable settings, rules
│  ├─ llm/
│  │  ├─ types.ts              # ChatRequest/ChatResult/LlmDriver
│  │  ├─ anthropicDriver.ts
│  │  ├─ openaiDriver.ts       # covers all OpenAI-compatible endpoints
│  │  ├─ registry.ts           # named model profiles → (driver, model, params)
│  │  └─ jsonCall.ts           # callJson<T>(schema, req): schema-enforced call + retry
│  ├─ agents/
│  │  ├─ agent.ts              # Agent base: session mgmt, invoke(), logging
│  │  ├─ storyteller.ts
│  │  ├─ npcAgent.ts           # instantiated per active NPC
│  │  ├─ scribeMemory.ts
│  │  ├─ scribeStory.ts
│  │  ├─ overseer.ts
│  │  └─ prompts/              # every system/template prompt as a versioned .md file
│  ├─ memory/
│  │  ├─ model.ts              # MemoryObject/Fact/DetailLevel types + Zod schemas
│  │  ├─ retrieval.ts          # query(scope, text, tags) → ranked facts
│  │  └─ knowledge.ts          # who-knows-what graph (player, per-NPC)
│  ├─ orchestrator/
│  │  ├─ turnPipeline.ts       # the main loop (06-orchestration.md)
│  │  ├─ contextBuilder.ts     # per-agent context assembly
│  │  ├─ directives.ts         # storyteller ⇄ orchestrator structured commands
│  │  └─ postTurn.ts           # async scribe fan-out, retry/queue
│  ├─ api/
│  │  ├─ http.ts               # REST routes (stories, memory CRUD, settings, agents)
│  │  └─ ws.ts                 # WebSocket: turn submit, stream deltas, events
│  └─ util/                    # tokens estimation, ids, logger
├─ client/                     # Svelte SPA (built separately → client/dist served statically)
│  └─ src/ ...
├─ scripts/
│  └─ termux-install.sh
└─ test/
   ├─ fixtures/                # recorded LLM responses for deterministic tests
   └─ ...
```

## Runtime objects

```ts
// A running story ("save game"). Multiple stories per install.
interface Story {
  id: string;
  title: string;
  settings: StorySettings;        // model profiles per role, overseer on/off, etc.
  currentSceneId: string;
}

// One player-visible exchange plus everything that produced it.
interface Turn {
  id: string;
  storyId: string;
  sceneId: string;
  index: number;                  // monotonically increasing per story
  playerInput: string;
  narration: string;              // final player-visible output
  status: 'streaming' | 'complete' | 'rejected' | 'error';
}

// A logical AI session.
interface AgentSession {
  id: string;
  storyId: string;
  role: 'storyteller' | 'npc' | 'scribe_memory' | 'scribe_story' | 'overseer';
  npcMemoryObjectId?: string;     // for role = 'npc'
  modelProfile: string;           // key into llm/registry
  // message history lives in agent_messages table, windowed per role policy
}
```

## Concurrency & failure policy

- **One turn at a time per story** (a per-story mutex in the orchestrator);
  different stories may run turns concurrently.
- LLM calls: timeout (configurable, default 120 s), 2 retries with backoff on
  network/5xx, `AbortSignal` wired to user cancel.
- Scribe jobs go through a tiny persistent queue table (`jobs`): if the process
  dies mid-scribe, the job re-runs on startup. Scribe failures never block or
  corrupt the player path — worst case the summary/memory lags one turn.
- All writes for a turn commit in one SQLite transaction at each pipeline stage,
  so a crash leaves a consistent, resumable state.

## Configuration

`config.json` (secrets, static) + `settings` table (runtime-tweakable via UI):

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 7777 },
  "providers": {
    "anthropic": { "apiKey": "sk-..." },
    "openai_compat": { "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "..." }
  },
  "modelProfiles": {
    "narrator-strong": { "provider": "anthropic", "model": "claude-sonnet-5", "temperature": 0.9 },
    "worker-cheap":    { "provider": "anthropic", "model": "claude-haiku-4-5", "temperature": 0.2 }
  },
  "roles": {                      // default per-role profile; overridable per story
    "storyteller": "narrator-strong",
    "npc": "narrator-strong",
    "scribe_memory": "worker-cheap",
    "scribe_story": "worker-cheap",
    "overseer": "worker-cheap"
  }
}
```

Binding to `127.0.0.1` is the default; LAN exposure (`0.0.0.0`) is opt-in and the
docs must warn that there is no auth in the MVP (add a shared token before ever
exposing beyond localhost).
