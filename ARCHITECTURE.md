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
  api/ws.ts             /ws: turn.submit / turn.retry / turn.cancel in; turn.* + bus events out
  orchestrator/
    turnPipeline.ts     the turn loop (every engine), consults, adjudication, rewind, retry, dropping failed attempts
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
    anthropicDriver.ts  Anthropic Messages API (raw fetch, streaming; low priority, see §9)
    openaiDriver.ts     OpenAI-compatible chat completions; DeepSeek / OpenRouter extras switched on by preset
    registry.ts         profile → bound driver, one driver per connection; getForRole(role, storyOverride)
    jsonCall.ts         JSON extraction, repair retry, max-token escalation, per-attempt usage
    jsonSchema.ts       Zod → JSON Schema (structured outputs)
    http.ts             retry with backoff (429/5xx)
  config/
    config.ts           config.json schema, provider presets, model caps, the EffectiveConfig type
    settingsService.ts  runtime settings in the DB: connections, models, tiers, role → tier map, prompts, style,
                        performance; migration from the old per-role shape
  db/
    db.ts, migrations/001–010.sql, stores/*.ts (one store per table group)
    stores/mindsStore.ts   Minds: character sheets, variables (defs, values, change log), thoughts
    stores/threadStore.ts  Minds: append-only threads on agent_messages (log, pending, recap, compaction flags)
  minds/                Minds engine (docs/10–11)
    round.ts            the round: gate → characters → narrator → block → one commit (and the dialogue wrap-up)
    dialogue.ts         dialogue mode: one exchange with one character per turn; the transcript for the wrap-up
    compaction.ts       minds_compact job: fold a thread's oldest half into a recap
    director.ts         who the player's words are meant for: rules first, else a Light-tier director
    names.ts            who knows whose name: labels per viewer, learning from speech, masking briefs
    contracts.ts        player input lanes, character reply, round block (lenient parsing)
    gate.ts             who acts this round
    seed.ts             minds_seed job: a mind for a newly introduced character (seedContext: what it reads)
    ties.ts             how characters are related (holder → other), shown in prompts and sheets
    variables.ts        variable definitions, validation, visibility, the change pipeline, rendering
    thoughts.ts         kinds and importance, remember/revise preparation, fading, recall selection, tag mentions
    places.ts           places and things: matching the narrator's names to what exists, the narrator's list
    focus.ts            how much each character says: focus tiers, limits, holding a reply to them
    presence.ts         who can perceive: awake / asleep / unconscious, the notes for waking and falling asleep
    text.ts             handles, tag normalization, word limits
    templates.ts        scenario templates
    service.ts          the operations with I/O: apply changes, thought ops, create characters, views
    builders.ts         character / narrator prompts and round messages; commit; POV preview
  agents/mindAgent.ts   Minds agents: declare and converse (raw reply kept), distribute, seed, compact
  memory/               classic engine: object views, disclosure rules, FTS retrieval, near-duplicate detection
  util/                 ids, logger, token estimate (chars/4), event bus, game clock, seed phrases, version (the
                        version check: running code vs the files on disk)
  data/story-seeds.txt  premise randomizer seed phrases
client/dist/            index.html, style.css and ES modules (no build): app.js (home, play view, settings),
                        ui.js (shared DOM/API helpers), minds.js (Minds cards, sheet and scenario editors, Cast and
                        POV tabs), help.js + help.json (the help panel's entries), back.js
                        (Android/browser Back closes the top dialog or the side panel first), version.js (the update
                        banner: reload the page or restart the server)
test/                   Vitest; fake/replay LLM drivers in test/fixtures/drivers.ts — no API key needed
scripts/                smoke.ts (live provider check), migrate.ts, termux-install.sh
```

## 3. How a chat turn works

A story runs one of three engines (`settings.engine`). **New stories use Minds** (the API forces it, and a Minds
story can't switch back). The classic engine and NPC Story Mode are **retired** (doc 10 §13, M8): they keep running
the stories that already use them, marked *legacy*, until they are deleted (M9).

**Every engine, before a new turn:** a failed, stopped or interrupted attempt at the end of the story is undone
from its snapshot first, so its message can't linger while the AIs never saw it. **Regenerate / Retry**
(`turn.retry`, ↻ on every reply) undoes a turn — an earlier one takes every later turn with it — and runs it again
with the same message and options (only turns that still have a snapshot: the last 16); **Edit** (rewind) undoes
the last one and returns the message. Both say which turn the page considers the last; if the story moved on, the
server refuses (409) rather than undo the wrong turns.

### Classic engine (legacy)

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

### NPC Story Mode (legacy, [docs/09](docs/09-npc-story-mode.md))

1. Turn row and snapshot, as above.
2. A rule-based filter picks which present characters act (mentioned, acted last round, just arrived; at most 4).
3. Each picked character gets one **one-off** call, in parallel. Input: personality + notes + the shared digest +
   the shared scene summary + raw narration of turns it was present for + the player's raw input. It returns
   `{dialogue, intent, innerState, notes}`. The notes are fully rewritten each time.
4. One streamed storyteller pass with the characters' contributions (+ adjudicator and continuation if needed).
5. Save each character's notes, cut to about 300 tokens. Background: scene summary and digest only.

### Common to classic and NPC Story Mode

- Every call rebuilds its prompt from scratch.
- `agent_messages` are written but never read back by these engines, so there are no real conversation threads.
- Prompt prefixes change every turn, so provider caches rarely hit.

### Minds engine ([docs/10](docs/10-minds-engine.md), `src/minds/round.ts`)

1. Turn row and snapshot, as above. Parse the player's input: `"…"` said, `((…))` a note to the narrator, the
   rest what they try.
2. **Direction** (doc 10 §5.1b): whom the player's words are meant for — a rule (one person present, someone named
   or described, a reply to who just spoke) or the director (Light tier). With a direction, those spoken to act
   (plus who'd react, the spotlight, forced ones); without one, the gate picks: forced, the narrator's spotlight,
   first appearance, mentioned by the player, acted last round (capped). Everyone hears where the words went.
   Someone asleep or unconscious is never called, hears nothing and gets no brief (doc 10 §5.1f).
3. Called characters declare in parallel, each on its own **persistent thread** (Medium tier): their pending
   briefs, the player's words "right now", their sheet, recalled thoughts. Replies are stored byte-exact.
4. The narrator (Heavy tier) streams the prose; the fenced round block that follows is never shown. A missing
   or broken block goes to the distributor (Light tier), then to plain briefs.
   **Review** (doc 10 §10c, `minds.reviewReplies`, advanced mode): the round stops here when the client asks; the
   turn waits with status `review` and `meta.review` (the narrator's reply, the characters' raw replies, direction,
   order). `POST …/turns/:turnId/accept` (`TurnPipeline.acceptReply`) replays the round from those outputs, with
   the edited prose and a revised block if the reply was edited, and goes on to steps 5–6.
5. One transaction commits everything: threads, thoughts, cast and scene changes, variable and state changes by
   the rules, the narrator's notes, names learned (from speech heard, the prose for the player, the block's
   `names`), ties (a newcomer's `cast.enter.ties`, the block's `ties`), each character's brief (names it doesn't
   know replaced by handles) plus the exact words it heard, the clock, the turn. Briefs that say he/she without a
   #handle, or tell a character what it thinks, are delivered and the narrator is reminded next round.
6. New characters (and present ones whose mind still isn't written) get a `minds_seed` job; threads over their
   threshold get a `minds_compact` job. No scribes run. Until its seed lands, a newcomer plays from the narrator's
   hand-over (`cast.enter.who`, stored as the sheet's concept) and its ties. The seeder reads the frame, who the
   player character is ("you"), the hand-over and ties, what the newcomer perceived on arriving, the "Here:" block
   as it perceives it, the narrator's recap and the recent story (doc 11 §2.3).

**Names** (doc 11 §2.5, `minds.nameKnowledge`, on for new stories): nobody knows a stranger's name. Handles are
made from a known-as label (`#elf-girl-in-green`), and each mind, and the player's UI, see a name only once it is
known.

Threads only ever append, so each request is a prefix of the next one (cache hits). When one grows past its
threshold (8k tokens for a character, 32k for the narrator), a Light-tier compactor folds its oldest half into a
recap after the round (doc 10 §8.4); that thread pays one cache miss.

**Dialogue mode** (`src/minds/dialogue.ts`): `turn.submit` with `dialogue: { partner }` makes the turn one
exchange: only the partner is called (on its own thread, in the conversation format), its line streams as
`Marta: "…" (gesture)`, the clock moves one minute. The next normal turn is the wrap-up: nobody is called, and the
narrator gets the transcript, resolves what happens next and briefs the bystanders. Dialogue state is derived
from the turns (`meta.mode`), so the server keeps none.

The Minds engine (docs 10–12) is designed to fix these three points.

### The dice (keep: not in the Minds v1 round, returns later for special cases)

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
| `thread_log` | every request and response of every AI call (the debug view), with tokens, cache read/write, reasoning tokens, cost and connection |
| `request_counts` | model calls per provider connection per UTC day (free-model limits) |
| `memory_objects` | roster: characters, items, places, factions, events, lore (+ aliases, salience) |
| `memory_facts` + `memory_fts` | classic engine: atomic facts with category, detail level, tier, game time; full-text index |
| `knowledge_links` | classic engine: which character (or the player) knows which fact |
| `story_summaries` | scene summaries and the story digest |
| `memory_suggestions` | merge/contradiction inbox for the user |
| `npc_profiles` | NPC Story Mode: personality + notes per character (also the classic engine's prose portrait) |
| `turn_snapshots` | pre-turn copy of mutable state, last 16 per story (rewind, edit, regenerate) |
| `jobs` | background work queue (`not_before`: backoff between attempts) |
| `settings` | runtime settings (`runtimeConfig`), seeded from `config.json` on first boot |
| `rules` | unused (the overseer was never built) |
| `character_sheets` | Minds: description, the narrator's hand-over (`concept`), appearance, pronouns, known-as, one-sentence state, awareness (awake / asleep / unconscious), player flag, tier override |
| `variable_defs` / `variable_values` / `variable_changes` | Minds: scenario variables (Zod JSON), values per holder or 'world', every attempted change |
| `thoughts` / `thought_tags` | Minds: self-written memories: kind (agenda / opinion / feeling / note), importance 1–10 that fades, subject, tags; active / revoked / revised / faded; hand edits marked (`user_edited_at`, kept across rewinds) |
| `character_met` | Minds: pairs of characters who have met (relation variables exist for them) |
| `undo_slots` | one Revert step per story: the full state saved before a regenerate, Edit, remove or edit |
| `name_knowledge` | Minds: who knows whose name (viewer → subject) |
| `character_ties` | Minds: how one character relates to another, from the holder's side ("older sister") |

`memory_objects.handle` (unique per story) gives every roster object a `#handle`. `agent_messages` gained `kind`
and `compacted` for Minds threads.

## 5. Models and settings

- `config.json` (copy from `config.example.json`) is only the **first-boot seed**. After that the DB holds the
  settings (key `runtimeConfig`, version 2), edited on the Settings page:
  - **Providers:** named connections, several at once (presets: DeepSeek, OpenRouter, OpenAI, local, Anthropic,
    custom).
  - **Models:** a model id on a connection, with caps (accepts temperature; reasoning none / switchable / always;
    JSON via JSON mode, structured outputs or prompt only).
  - **Tiers:** a model + max tokens + optional temperature + reasoning + effort. Heavy / Medium / Light by
    default, more can be added.
  - **Role mapping:** each role points at a tier.
  - Plus prompt overrides, style strings, job concurrency and request timeout.

  Old per-role settings migrate on load without changing any role's model or parameters (see doc 12 §7).
- The compiled `EffectiveConfig` has profiles `tier:<id>`, `role:<role>` and `fav:<model>`. A story can override a
  role with any of these names in its settings; a stale override falls back to the role's model.
- Roles: `storyteller`, `npc`, `scribe_memory`, `scribe_story`, `context_planner`, `adjudicator`,
  `player_intake`, `randomizer`, `overseer` (unused).
- **Per-provider behaviour** (`openaiDriver.ts`): temperature only when set; DeepSeek gets the `thinking`
  switch and `reasoning_effort`; OpenRouter gets `session_id` per agent thread (sticky routing for cache hits),
  the `reasoning` object, and `json_schema` + `provider.require_parameters` for structured outputs. Usage (cache
  read/write, reasoning tokens, cost) is normalized and logged per call.
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
| `minds_seed` | a character the Minds narrator introduces | description, nature, state, starting values, thoughts |
| `minds_nature` | a present character seeded before natures existed | its nature (traits) |
| `minds_compact` | a Minds thread over its threshold after a turn | fold its oldest half into a recap (rewind undoes it) |

Jobs retry 3 times with a growing wait between attempts (15 s, 1 min, 4 min), survive restarts (stuck `running`
jobs are requeued on boot), and report failures on the bus (shown as one quiet line with Retry now).

## 7. API and events (summary; the full list is in `src/api/http.ts`)

- **Stories:** CRUD, randomize premise, turns (list, edit, delete, accept a reply waiting for review), rewind, new scene, summaries, failed jobs.
- **Memory:** objects and facts CRUD, merge, knowledge links, maintenance, rescan, suggestions, "look at".
- **Characters:** promote, demote, enter by name, rebuild mind, NPC profiles, NPC knowledge, player interview.
- **Minds** (`src/api/mindsRoutes.ts`): scenario variable definitions, templates and a preview of how the AIs read
  them, character sheets (normal or `?advanced=1` view, pronouns included), values, change log, thoughts, and
  POV: a mind's thread and its exact next/last prompt.
- **Settings:** config (masked keys) for connections / models / tiers / roles, per-connection test, model listing
  (with caps from OpenRouter metadata), OpenRouter credits and free-model limits, requests today, prompts, seeds,
  style.
- **System:** health, models, `version` (the running commit; whether the code on disk differs, docs/10 §11.2).
- **Debug:** thread log per story/turn, the Threads view (`/calls`: one row per agent call, request and response
  paired, whose mind, turn and game time, cache, errors; `src/api/callsView.ts`), agent sessions.

WebSocket in: `turn.submit` (Minds options: `force`, character ids that must act; `dialogue: { partner }`, one
dialogue exchange; `review: true`, hold the reply for review), `turn.retry` (`turnId`: undo the last turn and run
it again; `review`), `turn.cancel`.
WebSocket out: `turn.accepted|status|delta|final|rejected|error`, `summary.updated`, `memory.updated`, `minds.updated`,
`scene.changed`, `npc.profile.updated`, `story.rewound`, `job.failed`, `provider.waiting` (an overloaded provider:
the call waits), `thread.activity` (live agent status bar).

## 8. Testing and commands

```bash
npm install
npm test            # Vitest, 319 tests, deterministic — fake and replay LLM drivers, no network
npm run typecheck   # tsc --noEmit
npm start           # http://127.0.0.1:7777 (needs config.json)
npm run smoke       # live check against each configured provider (needs real keys)
npm run migrate     # apply DB migrations only
```

Pipeline tests drive full turns through `createApp` with scripted drivers. New behaviour should come with a test
in that style.

## 9. Known gaps in the current code

- The Anthropic driver always sends `temperature` and prefills `{` for JSON; current Claude models reject both
  (fix planned as M1b, low priority).
- Classic and NPC Story Mode rebuild prompts every turn, so provider caches rarely hit (Minds threads fix this).
- Minds: dialogue is manual only (automatic mode is a TODO); Retry replaces the last reply (no branching yet); switching a legacy story to Minds keeps the
  transcript but the minds start fresh (doc 10 §14).
- The legacy engines' code (classic pipeline, NPC Story Mode, scribes, memory maintenance, overseer, planner) is
  still in the tree until M9.
- NPC Story Mode: the storyteller sees present characters only by name (their one-liner reads memory facts,
  which that mode never writes).
- Classic and NPC Story Mode never set a scene's location (the Minds narrator does).
- The rule overseer and the `rules` table are unused.
