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
| Character dossiers | A focused single-character AI pass (at promotion, or "⟳ rebuild from story") parses the verbatim story text and writes both a full fact sheet and a prose **portrait** kept nearly verbatim from the narration; dossiers are fully editable (portrait, summary, facts) |
| Story compression | The story scribe keeps a rolling scene summary and a whole-story digest (checkpointed mid-scene so long scenes can't stale it) so prompts never need the full history; details are recovered from memory on demand |
| Memory cleanup | A periodic (and on-demand) maintenance pass unifies entities recorded under different names, deduplicates/merges facts, and refreshes summaries; duplicate entities can also be merged manually, losslessly |
| In-game clock | A hidden day/hour/minute clock advanced by the storyteller (`advance_time`) — memory facts are stamped with when they happened in the fiction |
| Rule enforcement | Optional overseer validates outputs against user-defined rules and requests regeneration when violated |
| Hidden threads | Support threads invisible to the player by default; a debug setting exposes every thread and prompt for troubleshooting |

## Documentation

- **[`ARCHITECTURE.md`](ARCHITECTURE.md)**: how the system works today (source map, turn flow, data, jobs, API,
  known gaps).
- **[`docs/`](docs/README.md)**: specs with their status:
  - [09](docs/09-npc-story-mode.md) NPC Story Mode (built);
  - [10](docs/10-minds-engine.md) the next engine: narrator + character minds, briefs, dialogue mode, advanced mode
    (draft);
  - [11](docs/11-character-sheets.md) description, state, variables, self-written thoughts (draft);
  - [12](docs/12-models-and-providers.md) providers (DeepSeek, OpenRouter), model tiers, prompt caching (draft).
- **[`CLAUDE.md`](CLAUDE.md)**: the briefing for AI coding sessions (read order, conventions, what to keep).
- `old/` holds the obsolete original design (docs 01–08). Don't use it as a reference.

## Implementation status

- **Layer 0 — Foundation (config, DB, LLM adapter):** ✅ implemented.
- **Layer 1 — Minimal playable (server, storyteller, chat UI):** ✅ implemented.
- **Layer 2 — Story compression (job queue, scribe_story, bounded context):** ✅ implemented.
- **Layer 3 — Memory (objects/facts, scoped views, scribe_memory, retrieval):** ✅ implemented (3a/3b/3c).
- **Layer 4 — NPC agents (personas, isolation, consult loop):** ✅ implemented.
- Layers 5–6 (rule overseer, debug/polish): designed in the original plan (`old/`), not built.
- **NPC Story Mode (extra):** ✅ implemented ([docs/09](docs/09-npc-story-mode.md)), now **legacy** like the
  classic engine (Layers 1–4): both keep running the stories that use them; new stories use Minds.
- **Settings UI (extra):** in-app page for provider connections (DeepSeek, OpenRouter and others at once, with
  test, model listing and limits), models, **model tiers** (Heavy / Medium / Light + your own; every AI role
  follows its tier), role mapping and each role's prompt. All persisted in the DB; `config.json` is just the
  initial seed.
- **Minds engine** (docs 10–12): M1 (providers + tiers), M2 (character sheets, scenario variables, thoughts),
  M3 (thread builders), M4 (the round), M5 (dialogue mode), M6 (thread compaction) and M7 (the UI: character
  cards with Talk and Act next round, your own character, advanced mode with sheet editing and a POV view, the
  scenario variable editor, the **?** help panel) and M8 (the old engines retired) ✅ built — **every new story is
  a Minds story**. Since then: names are learned (strangers stay unnamed, for you and for every mind), a director
  works out whom you are talking to (only they answer), ↻ regenerates any recent reply, a failed turn offers Retry
  or Discard, and overloaded providers are ridden out (waits, a fallback model per tier, quiet notices). New
  characters arrive whole: the narrator hands over who they are and how they are related to others (ties), and
  their mind is written from that, from what they perceived and from who is around them. Characters keep an
  agenda, opinions of the people that matter and deep feelings, each rated 1–10 and fading when old; variables can
  hold a value per pair of characters (trust, affection) and are set up in a guided editor; advanced mode shows
  each character's full sheet. Your words and actions keep the order you typed them; a character says as much as
  the moment's focus on them allows (⚡⚡ gives one the floor); ↶ Revert undoes the last regenerate, Edit, remove
  or edit, and editing the last reply updates what every character knows.

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
- **Frontend:** static single-page web app (vanilla JS, no build step; Svelte was planned) served by the backend, used from any browser — including the phone's own browser when hosted in Termux
- **Orchestration:** an in-process turn pipeline (no external agent framework) that fans out to agent sessions, each with independently constructed context
