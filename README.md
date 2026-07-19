# PRPG — AI-Orchestrated Roleplay Engine

PRPG is a self-hostable, multi-agent AI roleplay engine. A player interacts with a
**Storyteller** AI, while a set of hidden support agents (per-NPC personas, memory
scribe, story compressor, rule overseer) run in parallel threads to keep the story
consistent, persistent, and rule-abiding — all driven by an LLM API key the user
supplies. It runs as a local web server, light enough for **Android via Termux**
(same deployment model as SillyTavern).

## Core capabilities

| Capability | Description |
|---|---|
| Multi-agent threads | Separate AI sessions per role: storyteller, one per active NPC, memory scribe, story scribe, rule overseer |
| Structured memory | Characters, objects, locations, events stored as memory objects with categories, subcategories and **detail levels** (e.g. only "visible" aspects returned when something is looked at) |
| NPC isolation | Each NPC has its own persona and its own knowledge subset — NPCs never leak each other's knowledge |
| NPC Story Mode | Optional per-story mode ([docs/09](docs/09-npc-story-mode.md)): each NPC's mind is a narrative document (personality + self-written notes) instead of extracted facts; present NPCs act proactively every round (a mechanical gate skips idle ones) and the storyteller weaves their words/intents in one pass |
| Story compression | The story scribe keeps a rolling scene summary and a whole-story digest (checkpointed mid-scene so long scenes can't stale it) so prompts never need the full history; details are recovered from memory on demand |
| Memory cleanup | A periodic (and on-demand) maintenance pass unifies entities recorded under different names, deduplicates/merges facts, and refreshes summaries; duplicate entities can also be merged manually, losslessly |
| In-game clock | A hidden day/hour/minute clock advanced by the storyteller (`advance_time`) — memory facts are stamped with when they happened in the fiction |
| Rule enforcement | Optional overseer validates outputs against user-defined rules and requests regeneration when violated |
| Hidden threads | Support threads invisible to the player by default; a debug setting exposes every thread and prompt for troubleshooting |

## Documentation / development plan

The full design is in `docs/`, ordered as a reading path and as a build guideline:

1. [`docs/01-tech-stack.md`](docs/01-tech-stack.md) — recommended languages, frameworks, storage, and why
2. [`docs/02-architecture.md`](docs/02-architecture.md) — system architecture, processes, module layout
3. [`docs/03-data-model.md`](docs/03-data-model.md) — entities, schemas, persistence layout
4. [`docs/04-agents.md`](docs/04-agents.md) — every agent thread: role, inputs, outputs, prompt design
5. [`docs/05-memory-system.md`](docs/05-memory-system.md) — memory objects, detail levels, retrieval, scribe pipeline
6. [`docs/06-orchestration.md`](docs/06-orchestration.md) — the turn loop: how a player input flows through all agents
7. [`docs/07-api-and-ui.md`](docs/07-api-and-ui.md) — HTTP/WebSocket API surface and the web client
8. [`docs/08-roadmap.md`](docs/08-roadmap.md) — layered build plan: milestones, inputs/outputs, acceptance criteria

## Implementation status

- **Layer 0 — Foundation (config, DB, LLM adapter):** ✅ implemented.
- **Layer 1 — Minimal playable (server, storyteller, chat UI):** ✅ implemented.
- **Layer 2 — Story compression (job queue, scribe_story, bounded context):** ✅ implemented.
- **Layer 3 — Memory (objects/facts, scoped views, scribe_memory, retrieval):** ✅ implemented (3a/3b/3c).
- **Layer 4 — NPC agents (personas, isolation, consult loop):** ✅ implemented.
- Layers 5–6 (rule overseer, debug/polish): designed in `docs/`, not yet built.
- **NPC Story Mode (extra):** ✅ implemented ([docs/09](docs/09-npc-story-mode.md)) —
  a per-story switch replacing the structured memory pipeline with per-NPC
  narrative minds (proactive rounds, skip gate, seeding, NPC-minds panel).
- **Settings UI (extra):** in-app page to set provider API keys (with a live
  "test key" button), curate a favourites list of models, pick a model +
  temperature + max-tokens per AI role, and edit each role's prompt. All
  persisted in the DB and auto-loaded; `config.json` is just the initial seed.

## Running it

Requires **Node.js ≥ 22** (the DB uses the built-in `node:sqlite` module — no
native compilation, which is what makes the Termux path painless).

```bash
npm install                       # runtime + dev deps
cp config.example.json config.json   # then add your API key(s)
npm run smoke                     # verify config, DB, and each provider
npm start                         # serves http://127.0.0.1:7777
```

Then open `http://127.0.0.1:7777`, create a story with a premise, and play.

- `npm test` — unit + pipeline tests (deterministic, no API key needed).
- `npm run migrate` — apply DB migrations without starting the server.
- On Android: `bash scripts/termux-install.sh` (see below).

## Quick architectural summary

- **Backend:** Node.js + TypeScript (Fastify), SQLite storage, provider-agnostic LLM adapter
- **Frontend:** static single-page web app (Svelte) served by the backend, used from any browser — including the phone's own browser when hosted in Termux
- **Orchestration:** an in-process turn pipeline (no external agent framework) that fans out to agent sessions, each with independently constructed context
