# 08 — Development Roadmap

Functionality is layered so that **every layer ends with a playable/testable
artifact** and each layer only consumes the outputs of layers below it. Build
strictly in order; nothing in a layer depends on a later one.

Legend per layer: **Needs** (inputs/preconditions) → **Builds** (modules & key
functions) → **Delivers** (outputs/observable result) → **Done when** (acceptance).

---

## Layer 0 — Foundation: config, DB, LLM adapter
*Everything else stands on this.*

**Needs:** an API key; the schemas from `03-data-model.md`.

**Builds:**
- `config/config.ts` — `loadConfig(path): Config` (Zod-validated, clear errors on
  missing keys).
- `db/db.ts` — `openDb(path)`, `migrate(db)`; migration `001-init.sql` with all
  tables from doc 03 (create everything now; empty tables are free).
- `llm/`: `types.ts`, `anthropicDriver.ts`, `openaiDriver.ts`,
  `registry.ts` (`getProfile(name): BoundDriver`), `jsonCall.ts`
  (`callJson<T>(profile, ctx, schema): Promise<T>` with the repair-retry).
- `util/`: `id()`, `estimateTokens()`, structured logger.
- `test/fixtures` harness: a `RecordingDriver` that wraps a real driver and
  records to JSON, and a `ReplayDriver` for deterministic tests.

**Delivers:** `npm run smoke` — CLI script that loads config, opens DB, runs one
streamed completion and one schema-enforced JSON completion against each
configured provider.

**Done when:** smoke passes on desktop **and inside Termux**; unit tests for
config validation, migrations idempotency, JSON repair-retry (via ReplayDriver).

---

## Layer 1 — Minimal playable: server, storyteller, chat UI
*A working single-agent roleplay app — the walking skeleton.*

**Needs:** Layer 0.

**Builds:**
- `db/stores/storyStore.ts`, `agentStore.ts`, `threadLog.ts`, `settingsStore.ts`.
- `agents/agent.ts` base (invoke/invokeJson + thread logging),
  `agents/storyteller.ts` v1 (no directives yet: pure narration),
  `prompts/storyteller.md` v1.
- Naive context builder v1: system prompt + **full raw history** (fine for now;
  replaced in Layer 2) + player input.
- `orchestrator/turnPipeline.ts` v1: steps 0→2→3→7 only, per-story mutex, cancel.
- `api/http.ts`: stories CRUD + turns page; `api/ws.ts`: submit/delta/final/cancel.
- `client/`: Home + Play views, transcript with streaming, input bar, WS store.
- `scripts/termux-install.sh`.

**Delivers:** create a story with a premise seed, play an ongoing streamed
roleplay in the browser, restart the server, continue the story.

**Done when:** a 30+ turn session works end-to-end on Termux; turn latency ≈ one
LLM call; every prompt/response visible in `thread_log` (query via sqlite CLI is
acceptable at this layer); pipeline unit-tested against ReplayDriver.

---

## Layer 2 — Story compression: scribe_story + bounded context
*Removes the "full history in prompt" crutch — stories can now run indefinitely.*

**Needs:** Layer 1 (turns exist, thread logging works).

**Builds:**
- `jobs` worker loop (`orchestrator/postTurn.ts`): enqueue/drain/retry/requeue-on-boot.
- `agents/scribeStory.ts` + prompts: rolling scene summary (per turn) and story
  digest fold (on scene close). Scenes introduced here in minimal form: manual
  "new scene" button first; storyteller `scene_break` directive comes in Layer 4.
- `db/stores` additions: `story_summaries`, `scenes`.
- `contextBuilder.forStoryteller` v2: digest + scene summary + last-K raw turns
  (budgeted per `06-orchestration.md` table), replacing full history.
- `directives.ts` parser (fenced block extraction) — parsing only, `scene_break`
  handled, others ignored for now.
- UI: summaries visible under debug flag; "new scene" control.

**Delivers:** prompt size stays flat as turn count grows; summaries update in
the background without blocking play.

**Done when:** a 100-turn replayed story keeps storyteller prompts under budget;
killing the process mid-summary loses nothing (job re-runs); summary quality
spot-checked (premise, open threads, current situation all present).

---

## Layer 3 — Memory: objects, facts, scoped views, scribe_memory, retrieval
*The engine's defining feature. Biggest layer — split into 3a/3b/3c.*

**Needs:** Layer 2 (job queue, budgeted context builder).

### 3a — Memory store & scoped views (no AI yet)
- `memory/model.ts` (types + Zod), `memoryStore.ts` (all functions from doc 03),
  FTS5 table + sync triggers, `knowledge.ts` scopes,
  **`getObjectView(objectId, scope, opts)`** with detail-level filtering,
  distortion substitution, category filtering, token budgeting.
- REST memory CRUD + knowledge-link endpoints; UI Memory tab (manual editing).
- **Done when:** unit tests prove every scope sees exactly the doc-05 matrix
  (visible/known/secret/hidden × player/npc/perception/storyteller, incl.
  distortions); manual objects usable in play by pasting into premise.

### 3b — scribe_memory pipeline
- `agents/scribeMemory.ts` + extraction prompt with taxonomy; `MemoryDelta`
  schema; post-processing (tempIds, alias auto-merge, supersede, clamps,
  knowledge links from `knownBy`); job type registered; `memory.updated` WS event.
- Maintenance job (dedupe/summary-refresh/salience decay) on the M-turn cadence.
- UI: suggestion inbox (merges/contradictions), provenance links fact→turn.
- **Done when:** replaying a fixed 20-turn fixture story produces a stable,
  sensible object set (golden-file test with tolerances); no duplicate objects
  for aliased mentions; superseding works (character changes clothes → old
  appearance fact superseded).

### 3c — Retrieval into the turn
- `memory/retrieval.ts` (`searchFacts` per doc 05: entity pass → FTS → scope →
  score → budget).
- `contextBuilder.forStoryteller` v3: + ambient scene views + retrieved block.
- Perception affordance: `/look <name>` command + "player examines X" detection
  → `perception`-scope view (this is the "only visible aspects when looked at"
  requirement, player-facing).
- **Done when:** a fact established 80 turns ago and absent from summaries is
  correctly used by the storyteller when relevant (scripted test); `/look`
  returns only `visible` facts.

---

## Layer 4 — NPC agents: personas, isolation, consult loop
*Multi-agent storytelling proper.*

**Needs:** Layer 3 (NPC personas are built from scoped memory views).

**Builds:**
- `agents/npcAgent.ts` + persona prompt template + `NpcReply` schema.
- Full `directives.ts`: `consult_npc`, `npc_enter`, `npc_exit`, `scene_break`
  wired into the pipeline (steps 4, 5, 8 of doc 06); parallel consults;
  graceful degradation on consult failure; dormant-bridge notes.
- `contextBuilder.forNpc`; NPC-perceived scene recap tracking (presence per turn).
- promote/demote endpoints + UI (NPC chips in scene header, promote button on
  character cards); `revealsFactIds` → knowledge links.
- Storyteller prompt v2: directive contract + when-to-consult guidance.

**Delivers:** major NPCs speak through their own sessions with their own
knowledge; secrets held by one NPC never surface through another.

**Done when:** the **isolation test** passes — a scripted story where NPC A holds
a `secret` fact and NPC B doesn't: across 20 probing turns B never reveals it
(assert via fact-string absence + LLM-judged leak check on B's outputs); consult
round-trip adds ≤1 extra storyteller call; a consult failure still yields a
complete turn.

---

## Layer 5 — Rule overseer
**Needs:** Layer 4 (verdicts must see final woven narration).

**Builds:**
- `agents/overseer.ts` + judge prompt + `OverseerVerdict` schema; rules CRUD +
  UI tab; pipeline step 6 with the ≤2-regeneration loop and `revise()` on the
  storyteller; optional player-input pre-gate (step 1); soft-notice chips;
  hard rules also inlined into the storyteller system prompt (prevention beats
  correction).
- Settings: overseer on/off per story, checkPlayerInput, stream-after-validate.

**Done when:** a story with rule "no character death without player consent"
blocks and successfully revises a violating narration in fixture tests; soft
rules annotate without blocking; overseer-off stories have zero added latency;
the unresolvable case (2 failed regens) emits with a warning, never deadlocks.

---

## Layer 6 — Debug visibility, polish, hardening, release
**Needs:** all previous layers (it surfaces them).

**Builds:**
- Threads tab: live `thread.activity` tail, prompt/response inspector, filters,
  per-turn inspect link; memory scope switcher in debug mode.
- Settings UI completion (budgets, K, retention, model profile pickers per role).
- Export/import; thread-log retention pruning; DB `VACUUM` maintenance task.
- Auth token middleware for LAN exposure + docs warning; rate/size limits on API.
- Termux hardening: wake-lock docs, low-memory behavior (worker concurrency 1 on
  small devices), `npm start` resilience (auto-restart wrapper script).
- Docs: user guide (setup, play, memory editing, rules), prompt-tuning guide.

**Done when:** a fresh user can install on Termux from the README alone, play a
multi-scene story with 2+ major NPCs, inspect any agent thread after flipping one
setting, export the story, and re-import it on a desktop install.

---

## Post-MVP backlog (explicitly out of scope above)
- Embedding rerank for retrieval (`sqlite-vec`) behind the same `searchFacts` signature.
- Dice/uncertainty mechanics (`roll` directive), character sheets, inventories as
  first-class mechanics.
- Multiplayer (multiple players in one story), spectator mode.
- Optimistic streaming with retraction under overseer.
- Voice (TTS/STT), image generation for scenes/portraits.
- Lorebook import (SillyTavern card compatibility for personas).
- Per-NPC model personalities (different providers per character).

## Cross-cutting engineering rules (all layers)
1. **Every prompt is a versioned file**; changing a prompt requires re-running its
   golden-fixture test.
2. **No agent reads global state** — contexts only via `contextBuilder`; enforce
   by keeping store handles private to the orchestrator.
3. **LLM nondeterminism is quarantined in tests**: pipeline/store/view logic
   tests use ReplayDriver fixtures; prompt-quality checks are separate, marked,
   real-API test suites run manually.
4. **The player path never blocks on a scribe**; scribes fail → lag, not breakage.
5. **Phone budget discipline**: track tokens per turn in `turn.meta_json`; the
   settings UI shows per-story token/cost counters from day one (Layer 1).
