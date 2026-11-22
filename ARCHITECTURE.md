# Architecture: the system as it is built

This describes the **current code** (reviewed 2026-11-22). The next engine is specified in
[`docs/10`–`12`](docs/README.md) and not built yet. Older design docs are in `old/`; don't use them.

## 1. What runs

One Node.js process (Node ≥ 22, TypeScript run directly, no build step):

- **Fastify** HTTP API + a **WebSocket** at `/ws` for streaming turns and live events;
- the **turn pipeline**, in-process, one turn at a time per story (a per-story lock);
- a **job worker**, in-process, polling a persistent `jobs` table for background AI work;
- **SQLite** through Node's built-in `node:sqlite` (one file, default `data/prpg.db`);
- the **web client**: static files in `client/dist/` (vanilla JS, no build), served by the same server.

It is light enough for Android/Termux, which is why there are no native modules and few dependencies (Fastify,
its static/websocket plugins, Zod).

**Startup** (`src/index.ts`): load `config.json` → `createApp` (`src/app.ts`: open DB, run migrations, build
stores, settings service, LLM registry, context builder, pipeline, job worker) → register HTTP + WS routes →
serve the client → listen (default `127.0.0.1:7777`). An optional `server.token` enables bearer-token auth for LAN
exposure.

## 2. Source map

```
src/
  index.ts              boot (see above)
  app.ts                wiring: stores + registry + pipeline + job handlers
  domain.ts             Story/Scene/Turn/Session types; StorySettings (Zod) — every per-story switch
  api/http.ts           REST routes (stories, turns, memory, NPCs, settings, debug)
  api/ws.ts             /ws: turn.submit / turn.cancel in; turn.* + bus events out
  orchestrator/
    turnPipeline.ts     the turn loop (both engines), consults, adjudication, rewind
    contextBuilder.ts   the ONLY place prompts are assembled (storyteller, NPC, NPC round)
    npcRound.ts         NPC Story Mode: skip gate + parallel character calls
    npc.ts              promote/demote/enter/exit characters; mind rebuild
    directives.ts       parse the storyteller's ```directives block
    resolution.ts       dice: chance clamp, d100 → outcome band, narration guidance
    scenes.ts           scene break (close + digest fold)
    handlers.ts         jobs: scribe_story (scene summary / digest), npc_seed
    memoryHandlers.ts   jobs: scribe_memory, archive_faded, npc_dossier, memory_maintenance; merge
    playerIntake.ts     the player-character interview
    postTurn.ts         JobWorker (concurrency, retries, crash recovery)
    locks.ts            per-story mutex
  agents/
    agent.ts            base: invoke (streamed text) / invokeJson (schema + repair), logs every call
    storyteller.ts, npcAgent.ts, adjudicator.ts, contextPlanner.ts, scribeStory.ts, scribeMemory.ts, playerIntake.ts
    prompts.ts          loads prompts/*.md, {{var}} rendering, user overrides from Settings
    prompts/*.md        every prompt template (editable in Settings → prompts)
  llm/
    types.ts            ChatRequest/ChatResult/LlmDriver contract, SSE parser
    anthropicDriver.ts  Anthropic Messages API (raw fetch, streaming)
    openaiDriver.ts     OpenAI-compatible chat completions (OpenRouter, DeepSeek, local)
    registry.ts         model profile → bound driver; live config
    jsonCall.ts         JSON extraction, repair retry, max-token escalation
    http.ts             retry with backoff (429/5xx)
  config/
    config.ts           config.json schema (providers, modelProfiles, roles)
    settingsService.ts  runtime settings in the DB (keys, favourites, per-role models, prompts, style, performance)
  db/
    db.ts, migrations/001–005.sql, stores/*.ts (one store per table group)
  memory/               classic engine: object views, disclosure rules, FTS retrieval, near-duplicate detection
  util/                 ids, logger, token estimate (chars/4), event bus, game clock, seed phrases
  data/story-seeds.txt  premise randomizer seed phrases
client/dist/            index.html, style.css, app.js (whole UI in one file)
test/                   Vitest; fake/replay LLM drivers in test/fixtures/drivers.ts — no API key needed
scripts/                smoke.ts (live provider check), migrate.ts, termux-install.sh
```

## 3. How a chat turn works

A story runs one of two engines, chosen per story (`settings.npcStories.enabled`).

### Classic engine (default)

1. Create the turn row and snapshot everything mutable (for rewind).
2. *Summary-driven mode only:* the context planner (cheap model) picks memory queries and depth.
3. Build the storyteller prompt:
   - rules, premise, hidden clock;
   - the player character's sheet, the story digest and the scene summary;
   - the present characters and retrieved memory facts;
   - the last 6 raw turns (only the last one in summary-driven mode).
4. Storyteller pass 1: streamed live if no major character is present; otherwise **buffered** (the player sees
   nothing yet), because it may consult them.
5. Directives in the reply:
   - `consult_npc` runs each named character in parallel, with a persona built from memory facts;
   - `resolve_action` runs the adjudicator and rolls hidden dice.

   The storyteller then rewrites (buffered) or continues (live). Up to 3 storyteller calls per turn.
6. Advance the clock, save, apply `scene_break` / `npc_enter` / `npc_exit`.
7. Background jobs:
   - the scene summary is rewritten every turn and folded into the story digest every 8 turns or at a scene break;
   - the memory scribe extracts facts;
   - cleanup runs every 10 turns;
   - details that fade out of summaries are archived as facts.

### NPC Story Mode ([docs/09](docs/09-npc-story-mode.md))

1. Turn row and snapshot, as above.
2. A rule-based filter picks which present characters act (mentioned, acted last round, just arrived; at most 4).
3. Each picked character gets one **one-off** call, in parallel. Input: personality + notes + the shared digest +
   the shared scene summary + raw narration of turns it was present for + the player's raw input. It returns
   `{dialogue, intent, innerState, notes}`. The notes are fully rewritten each time.
4. One streamed storyteller pass with the characters' contributions (+ adjudicator and continuation if needed).
5. Save each character's notes, cut to about 300 tokens. Background: scene summary and digest only.

### Common to both

- Every call rebuilds its prompt from scratch.
- `agent_messages` are written but never read back, so there are no real conversation threads.
- Prompt prefixes change every turn, so provider caches rarely hit.

The Minds engine (docs 10–12) is designed to fix these three points.

### The dice (keep: reused by the next engine)

`resolve_action` → the adjudicator AI judges a success chance from the actor's sheet and circumstances ("realism
over drama, physics not morals") → the engine rolls a hidden d100 → `outcomeFromRoll` maps the margin to a band
(critical success … critical failure) → the storyteller narrates the band; numbers stay in `turns.meta.rolls`.

## 4. Data (SQLite, `src/db/migrations`)

| Table | Holds |
|---|---|
| `stories` | title, `settings_json` (StorySettings), current scene, `clock_min` (hidden in-game clock) |
| `scenes` | per story: index, title, `active_npc_ids` (present cast), open/closed. `location_object_id` exists but nothing sets it. |
| `turns` | player input, narration, status, `meta_json` (timings, model, rolls, present cast) |
| `agent_sessions` / `agent_messages` | one session per (story, role[, character]); messages are logged, not read back |
| `thread_log` | every request and response of every AI call (the debug view) |
| `memory_objects` | roster: characters, items, places, factions, events, lore (+ aliases, salience) |
| `memory_facts` + `memory_fts` | classic engine: atomic facts with category, detail level, tier, game time; full-text index |
| `knowledge_links` | classic engine: which character (or the player) knows which fact |
| `story_summaries` | scene summaries and the story digest |
| `memory_suggestions` | merge/contradiction inbox for the user |
| `npc_profiles` | NPC Story Mode: personality + notes per character (also the classic engine's prose portrait) |
| `turn_snapshots` | pre-turn copy of mutable state, last 8 per story (rewind / edit) |
| `jobs` | background work queue |
| `settings` | runtime settings (`runtimeConfig`), seeded from `config.json` on first boot |
| `rules` | unused (the overseer was never built) |

## 5. Models and settings

- `config.json` (copy from `config.example.json`) is only the **first-boot seed**. After that the DB holds the
  settings, edited in the UI: provider keys (one Anthropic + one OpenAI-compatible slot), a favourites list of
  models, a model + temperature + max tokens per role, prompt overrides, style strings, job concurrency, request
  timeout.
- Roles: `storyteller`, `npc`, `scribe_memory`, `scribe_story`, `context_planner`, `adjudicator`,
  `player_intake`, `overseer` (unused). A story can override a role's model in its settings.
- Per-story switches live in `StorySettings` (`src/domain.ts`): premise, genre, tone, verbosity, player
  character, budgets, summary-driven context, NPC Story Mode, adjudicator, salience, debug.

## 6. Background jobs

| Job | Enqueued | Does |
|---|---|---|
| `scribe_story` | every turn; scene break; every 8 turns | rewrite scene summary; fold into digest |
| `scribe_memory` | every turn (classic only) | extract facts as a MemoryDelta, apply with dedupe/alias-merge |
| `memory_maintenance` | every 10 turns; on demand | unify entities, merge duplicate facts, refresh summaries, decay salience |
| `archive_faded` | when summaries drop details | store the dropped details as facts |
| `npc_dossier` | promoting a character (classic) | focused single-character sheet + prose portrait |
| `npc_seed` | new character in NPC Story Mode | personality + opening notes |

Jobs retry 3 times, survive restarts (stuck `running` jobs are requeued on boot), and report failures on the bus.

## 7. API and events (summary; the full list is in `src/api/http.ts`)

- **Stories:** CRUD, randomize premise, turns (list, edit, delete), rewind, new scene, summaries, failed jobs.
- **Memory:** objects and facts CRUD, merge, knowledge links, maintenance, rescan, suggestions, "look at".
- **Characters:** promote, demote, enter by name, rebuild mind, NPC profiles, NPC knowledge, player interview.
- **Settings:** config (masked keys), key test, OpenRouter credit check, prompts, seeds, style.
- **Debug:** thread log per story/turn, agent sessions.

WebSocket out: `turn.accepted|status|delta|final|rejected|error`, `summary.updated`, `memory.updated`,
`scene.changed`, `npc.profile.updated`, `story.rewound`, `job.failed`, `thread.activity` (live agent status bar).

## 8. Testing and commands

```bash
npm install
npm test            # Vitest, 131 tests, deterministic — fake and replay LLM drivers, no network
npm run typecheck   # tsc --noEmit
npm start           # http://127.0.0.1:7777 (needs config.json)
npm run smoke       # live check against each configured provider (needs real keys)
npm run migrate     # apply DB migrations only
```

Pipeline tests drive full turns through `createApp` with scripted drivers. New behaviour should come with a test
in that style.

## 9. Known gaps in the current code

- The Anthropic driver always sends `temperature` and prefills `{` for JSON; current Claude models reject both.
- Only one OpenAI-compatible provider at a time (DeepSeek **or** OpenRouter).
- No prompt caching support; cache usage isn't recorded; JSON calls log 0 input tokens.
- NPC Story Mode: the storyteller sees present characters only by name (their one-liner reads memory facts,
  which that mode never writes).
- Scene location is never set, so location-based prompt blocks never appear.
- The rule overseer and the `rules` table are unused.
