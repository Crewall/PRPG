# PRPG docs: index and status

Last reviewed 2026-11-22.

**How the system works today** (source map, turn flow, data, jobs, API, known gaps) is in
[`/ARCHITECTURE.md`](../ARCHITECTURE.md). This folder holds **specs**: what is being built and why. Obsolete
design docs (the original 01–08 plan) are in [`/old`](../old/README.md); don't use them.

| Doc | What it specifies | Status |
|---|---|---|
| [09-npc-story-mode](09-npc-story-mode.md) | NPC Story Mode: narrative character minds in the current code | **Built, legacy** (retired in M8: runs existing stories only). Two gaps: §5 storyteller one-liners, §4 scene location. |
| [10-minds-engine](10-minds-engine.md) | Next engine: one narrator, a thread per character, briefs, dialogue mode, advanced mode, help panel | **M1–M8 built: the engine for new stories**, with learned names and the director (§5.1b), event order (§6), focus tiers (§5.1e), Revert (§10a). M9 (deleting the legacy engines) waits for the owner. Build order in §13. |
| [11-character-sheets](11-character-sheets.md) | Description, appearance, state, scenario variables, self-written thoughts | **Built** (M2, M4, M6, the public profile, names: §2.5, the hand-over and ties: §2.3, §2.6, relation variables: §4.9, the guided editor: §4.8, thoughts v2 and the sheet: §5.6–5.10). |
| [12-models-and-providers](12-models-and-providers.md) | Provider connections (DeepSeek, OpenRouter first), model tiers, caching | **M1 built.** M1b (Claude via the official SDK) not built. |

## Conventions

- Spec before code. A spec covers decisions, contracts, data model, a build order with acceptance criteria, and
  open questions.
- Each spec starts with a **Status** line. Update it, this table, `ARCHITECTURE.md` and the README status list
  when a milestone lands.
- When a spec is fully superseded, move it to `/old/docs/` and add a row to `/old/README.md`.
