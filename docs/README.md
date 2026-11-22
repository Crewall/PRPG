# PRPG docs: index and status

Last reviewed 2026-11-22, against commit `d506cd2`.

## What each document is, and how far to trust it

| Doc | What it is | Status |
|---|---|---|
| [01-tech-stack](01-tech-stack.md) | Technology choices and reasons | **Original plan (pre-build).** Two choices changed, see below. |
| [02-architecture](02-architecture.md) | Processes, module layout, key decisions | **Original plan.** The decisions (D1–D4) still hold; the module tree has grown. |
| [03-data-model](03-data-model.md) | Tables and store contracts | **Original plan.** Migrations 002–005 added tables and columns it doesn't list. |
| [04-agents](04-agents.md) | Every agent: role, inputs, outputs | **Original plan.** Missing: adjudicator, context planner, interviewer, randomizer. |
| [05-memory-system](05-memory-system.md) | Facts, detail levels, retrieval, scribe | **Mostly current** for the classic engine (includes cleanup/merge). Tiers are only in code. |
| [06-orchestration](06-orchestration.md) | The turn loop | **Outdated.** Describes the classic loop before the adjudicator and NPC Story Mode. See "How a chat turn works today" below. |
| [07-api-and-ui](07-api-and-ui.md) | REST/WS API and web UI | **Original plan.** The API grew a lot (see `src/api/http.ts`); the UI is not Svelte. |
| [08-roadmap](08-roadmap.md) | Layered build plan | **Original plan.** Layers 0–4 are built, 5–6 are not (see the README status list). |
| [09-npc-story-mode](09-npc-story-mode.md) | NPC Story Mode spec | **Current**, with the two gaps listed below. |
| [10-minds-engine](10-minds-engine.md) | Next engine: narrator + character minds | **Draft spec, not built.** |
| [11-character-sheets](11-character-sheets.md) | Description, state, variables, thoughts | **Draft spec, not built.** |
| [12-models-and-providers](12-models-and-providers.md) | Providers (DeepSeek), model tiers, caching | **Draft spec, not built.** |

## Where the code differs from the original plan (01–08)

- **Client:** planned as Svelte + Vite; built as zero-build vanilla JS (`client/dist/app.js`).
- **Database:** planned on `better-sqlite3`; built on Node's built-in `node:sqlite` (Node ≥ 22).
- **Rule overseer** (rule checks + regeneration): designed in 04/06, **not built**. The `rules` table exists but is unused.
- **`roll` directive:** never built; replaced by the adjudicator (`resolve_action` → impartial AI judges a chance → hidden d100).
- **Built later, documented only in code and the README:** adjudicator and hidden dice, context planner and
  summary-driven context, fact importance tiers, turn snapshots/rewind/edit, player character interview,
  story randomizer, the Settings page (keys, favourites, per-role models, prompt editor, performance).
- **Known gaps against doc 09:**
  - §5 says present characters' one-liners for the storyteller come from their personality. The code still reads
    memory facts, which NPC Story Mode never writes, so the storyteller sees only their names
    (`src/orchestrator/contextBuilder.ts:267`).
  - §4 "where you are": nothing ever sets a scene's location, so that block never appears.

## How a chat turn works today

A story runs on one of two engines (`settings.npcStories.enabled` picks).

### Classic engine (default)

1. Create the turn row and snapshot everything mutable (for rewind).
2. *Summary-driven mode only:* the context planner (cheap model) picks memory queries and depth.
3. Build the storyteller prompt: rules, premise, hidden clock, the player character's sheet, story digest, scene
   summary, present characters, retrieved memory facts, and the last 6 raw turns (only the last one in
   summary-driven mode).
4. Storyteller pass 1: streamed live if no major character is present; otherwise **buffered** (the player sees
   nothing yet), because it may consult them.
5. Directives in the reply: `consult_npc` runs each named character (parallel, persona built from memory facts);
   `resolve_action` runs the adjudicator and rolls dice. The storyteller then rewrites (buffered) or continues
   (live). Up to 3 storyteller calls per turn.
6. Advance the clock, save, apply `scene_break` / `npc_enter` / `npc_exit`.
7. Background jobs: the scene summary is rewritten every turn and folded into the story digest every 8 turns or
   at a scene break. The memory scribe extracts facts. Cleanup runs every 10 turns. Details that drop out of
   summaries are archived as facts.

### NPC Story Mode (per-story switch)

1. Turn row and snapshot, as above.
2. A rule-based filter picks which present characters act (mentioned, acted last round, just arrived; at most 4).
3. Each picked character gets one **one-off** call (parallel): personality + notes + the shared digest + the
   shared scene summary + raw narration from turns it was present for + the player's raw input. It returns
   `{dialogue, intent, innerState, notes}`. The notes come back fully rewritten each time.
4. One streamed storyteller pass with the characters' contributions in its prompt (+ adjudicator and continuation
   if needed).
5. Save each character's notes (cut to about 300 tokens). Background: scene summary and digest only; no fact
   extraction.

**Common to both:** every call rebuilds its prompt from scratch. `agent_messages` are written but never read
back, so there are no real conversation threads, and the prompt prefix changes every turn, so provider prompt
caches rarely hit.

## What's next

Docs 10–12 specify the **Minds engine**, a third engine that sits beside the two above:

- one narrator,
- one persistent thread per character,
- per-character briefs,
- scenario variables, states and self-written thoughts,
- a dialogue mode,
- advanced mode with POV filtering,
- model tiers and DeepSeek.

Doc 10 §13 holds the build order.

## Conventions

- Spec before code: a feature gets a numbered doc with decisions, contracts, a data model, a build order with
  acceptance criteria, and open questions.
- Each spec starts with a **Status** line. Update it (and this table) when a milestone lands.
