# PRPG — briefing for every session

PRPG is a self-hosted, multi-agent AI roleplay engine: a Node.js server + browser client that also runs on
Android through Termux. The player chats with a narrator; separate AI threads play the characters.

## Read first, in this order

1. [`README.md`](README.md): what it is and how to run it.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md): **the system as it is built today**: source map, how a turn works, data,
   jobs, API, known gaps.
3. [`docs/README.md`](docs/README.md): the spec index and status.
4. The spec for whatever you're working on:
   - [`docs/10-minds-engine.md`](docs/10-minds-engine.md): the next engine;
   - [`docs/11-character-sheets.md`](docs/11-character-sheets.md): descriptions, state, variables, thoughts;
   - [`docs/12-models-and-providers.md`](docs/12-models-and-providers.md): providers, model tiers, caching;
   - [`docs/09-npc-story-mode.md`](docs/09-npc-story-mode.md): the existing NPC Story Mode.

**Ignore `old/`.** It holds the obsolete pre-build design (docs 01–08). Code comments still cite those files
("see 06-orchestration.md", "doc 04"); they point at the old plan. When a comment and the code disagree, the code
is right.

## Where the project is

- **Built and working:**
  - **the Minds engine** (docs 10–12), the engine for new stories:
    - M1 provider connections + model tiers (DeepSeek and OpenRouter at once, presets, usage and request counting);
    - M2 the data layer (sheets, scenario variables and their rules, self-written thoughts, handles; `src/minds/`);
    - M3 append-only threads and their builders; M4 the round; M5 dialogue mode (`src/minds/dialogue.ts`);
    - M6 thread compaction (`src/minds/compaction.ts`); the public profile and a guaranteed player character;
    - M7 the UI (character cards, advanced mode, sheet and scenario editors, POV, help panel;
      `client/dist/minds.js`, `help.js`, `help.json`);
    - M8 the old engines retired (new stories are Minds; legacy stories keep running);
    - names that are learned (known-as labels, neutral handles; `src/minds/names.ts`) and the director that works
      out who the player is talking to (`src/minds/director.ts`);
    - the narrator's hand-over and ties (`src/minds/ties.ts`), a seeder that reads the whole frame
      (`seedContext` in `src/minds/seed.ts`), perception-only briefs;
    - thoughts v2: agenda / opinion / feeling / note, importance 1–10 that fades, revising (`src/minds/thoughts.ts`),
      a state that is only body and mood; relation variables per pair who have met; the guided scenario editor and
      the full character sheet; places and things reused by #handle (`src/minds/places.ts`);
    - overload handling: real waits on 429/503, a fallback model per tier, job backoff, re-seeding;
  - shared: rewind/edit and ↻ regenerate on every reply (failed attempts are dropped before the next turn), the premise randomizer, the
    Settings UI, the adjudicator + hidden dice (kept, not in the Minds round);
  - **legacy** (retired, existing stories only): the classic engine and NPC Story Mode, the player interview;
  - 272 passing tests.
- **Designed, not built:** branching retries, converting legacy stories, the interviewer for Minds, automatic
  dialogue mode, referee + dice for special cases, a reload-on-update check (doc 10 §14).

  Build order: doc 10 §13. M1–M8 are done. Next: M9 (delete the legacy engines) only on the owner's go-ahead.
- **Provider focus: DeepSeek and OpenRouter.** Claude/Anthropic is low priority; its driver is known broken on
  current Claude models (see ARCHITECTURE §9) and gets fixed later.

## Backup

The pre-Minds code is frozen on branch **`v1-backup`** (`main` at `d506cd2`: classic engine + NPC Story Mode).
**Never push to it.** New work goes to feature branches and reaches `main` through PRs.

## Keep (don't delete without the owner's say-so)

- **The dice/adjudication system** (`src/orchestrator/resolution.ts`, `src/agents/adjudicator.ts`,
  `prompts/adjudicator.md`). It is not part of the Minds v1 round (the narrator decides outcomes), but it will
  come back later for special cases (doc 10 §9.4).
- The classic engine and NPC Story Mode are **retired** (doc 10 §13, M8): they run the stories that already use
  them (marked legacy); new stories are Minds. Delete them only when the owner says so (M9). They remain
  available on `v1-backup` either way.

## Commands

```bash
npm install
npm test            # Vitest; deterministic fake/replay LLM drivers, no network, no keys
npm run typecheck   # tsc --noEmit — keep it clean
npm start           # serves http://127.0.0.1:7777 (needs config.json; copy config.example.json)
npm run smoke       # live provider check (needs real keys)
```

Node ≥ 22 is required (`node:sqlite`; `.ts` files run directly with type stripping, no build step).

## Conventions

- **Spec first.** A feature gets (or extends) a numbered doc in `docs/`: decisions, contracts, data model, build
  order with acceptance criteria, open questions. When a milestone lands, update the doc's **Status** line,
  `docs/README.md`, `ARCHITECTURE.md`, and the README status list in the same change.
- **Tests with every behaviour change**, in the style of `test/pipeline.test.ts` (full turns through `createApp`
  with scripted drivers from `test/fixtures/drivers.ts`). Never call a real API from tests.
- **Prompts** live in `src/agents/prompts/*.md`, rendered with `{{var}}`. Anything user-tunable is registered in
  `EDITABLE_PROMPTS` (`src/config/settingsService.ts`) so it shows in Settings.
- **Zod schemas are the source of truth** for settings, API bodies and every AI JSON reply. Validate AI output and
  clamp it server-side; an AI misstep should degrade gracefully, not fail the turn.
- **Prompt assembly only in `src/orchestrator/contextBuilder.ts`** (and its Minds successors). Agents never build
  their own context; that boundary is how characters are kept from seeing what they shouldn't.
- **Cache-friendly threads (Minds):** stored messages are byte-exact and append-only; nothing volatile goes
  before the log. See doc 10 §8.
- **Minimal dependencies.** No native modules (Termux). Imports use explicit `.ts` extensions (ESM, NodeNext).
- **User-facing features get a help entry** in `client/dist/help.json` (the in-app help panel, doc 10 §11.1),
  and a `helpLink(id)` next to the feature where it helps.
- Never put API keys in code, tests, logs or commits; keys live in `config.json` (gitignored) or the settings DB.
