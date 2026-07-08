# 03 — Data Model & Persistence

One SQLite database file per install (`data/prpg.db`). All tables carry
`created_at` / `updated_at` (unix ms). IDs are short random strings (nanoid).
Migrations are plain SQL files applied in order by `src/db/db.ts`.

## Entity-relationship overview

```
Story 1─* Scene 1─* Turn
Story 1─* AgentSession 1─* AgentMessage
Story 1─* MemoryObject 1─* MemoryFact
MemoryFact *─* KnowledgeLink ─ (player | AgentSession[npc])
Story 1─* StorySummary (rolling, per scene + per story)
Story 1─* Rule
Turn  1─* ThreadLogEntry
Jobs  (persistent queue for scribe work)
```

## Tables

### `stories`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| title | TEXT | |
| settings_json | TEXT | `StorySettings` (Zod-validated): role→modelProfile map, overseer enabled, context budgets, debug flags |
| current_scene_id | TEXT | |
| clock_min | INTEGER | hidden in-game clock, minutes since Day 1 00:00 (stories start at 480 = Day 1, 08:00); advanced by the storyteller's `advance_time` directive or a small per-turn default |
| status | TEXT | `active` \| `archived` |

### `scenes`
A scene is a continuity unit (location + present cast). Scene breaks are declared
by the storyteller via directive (see `06-orchestration.md`) and drive summary
granularity and NPC activation.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id | TEXT FK | |
| index | INTEGER | per story |
| title | TEXT | short label, e.g. "The Rusty Flagon, night" |
| location_object_id | TEXT | FK → memory_objects, nullable |
| active_npc_ids | TEXT | JSON array of memory_object ids present in scene |
| status | TEXT | `open` \| `closed` |

### `turns`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id, scene_id | TEXT FK | |
| index | INTEGER | per story, monotonic |
| player_input | TEXT | |
| narration | TEXT | final player-visible text |
| status | TEXT | `streaming` \| `complete` \| `rejected` \| `error` |
| meta_json | TEXT | token counts, regen count, overseer verdicts, timings |

### `agent_sessions`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id | TEXT FK | |
| role | TEXT | `storyteller` \| `npc` \| `scribe_memory` \| `scribe_story` \| `overseer` |
| npc_object_id | TEXT | FK → memory_objects; only for role=npc |
| model_profile | TEXT | |
| state | TEXT | `active` \| `dormant` (NPC left scene) \| `closed` |

### `agent_messages`
The *session-local* history of each agent (what that agent believes the
conversation is). Distinct from `thread_log` (the audit record).

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| session_id | TEXT FK | |
| turn_id | TEXT FK | nullable (bootstrap msgs) |
| role | TEXT | `system` \| `user` \| `assistant` |
| content | TEXT | |
| pinned | INTEGER | pinned messages survive window compaction |

### `memory_objects`
The core memory entity — a character, item, location, faction, event, or lore
entry. Full field semantics in `05-memory-system.md`.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id | TEXT FK | |
| type | TEXT | `character` \| `item` \| `location` \| `faction` \| `event` \| `lore` |
| name | TEXT | canonical name |
| aliases_json | TEXT | JSON array of alternate names ("the innkeeper", "Old Marta") |
| summary | TEXT | 1–3 sentence always-safe descriptor (scribe-maintained) |
| salience | REAL | 0–1, scribe-adjusted; drives retrieval ranking |
| status | TEXT | `active` \| `dormant` \| `destroyed`/`dead` |

### `memory_facts`
Atomic statements about an object, each carrying **category, subcategory, and
detail level** — the unit of scoped disclosure.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| object_id | TEXT FK | |
| category | TEXT | e.g. `appearance`, `personality`, `state`, `inventory`, `relations`, `history`, `abilities`, `location` |
| subcategory | TEXT | free-form refinement, e.g. `appearance/clothing` |
| detail_level | TEXT | `visible` \| `known` \| `secret` \| `hidden` (see 05) |
| content | TEXT | one self-contained statement |
| source_turn_id | TEXT | provenance |
| supersedes_id | TEXT | old fact this replaces (soft history; superseded facts kept, flagged) |
| superseded | INTEGER | 0/1 |
| confidence | REAL | scribe's certainty, 0–1 |
| game_time_min | INTEGER | in-game clock stamp (minutes) when the fact was recorded; NULL on pre-clock rows. Rendered as `d2 14:30` in agent prompts and the memory UI |

### `memory_fts` (virtual, FTS5)
Content-indexed over `memory_facts.content + memory_objects.name + aliases`,
kept in sync by triggers. Retrieval queries in `05-memory-system.md`.

### `knowledge_links`
Who knows a given fact. The player and each NPC are "knowers".

| column | type | notes |
|---|---|---|
| fact_id | TEXT FK | |
| knower_type | TEXT | `player` \| `npc` |
| knower_npc_object_id | TEXT | when knower_type=npc |
| learned_turn_id | TEXT | provenance |
| distortion | TEXT | nullable — what this knower *wrongly* believes instead (enables misinformation) |

Rule of thumb: `detail_level=visible` facts don't need links (anyone perceiving
the object gets them); `known/secret` facts are disclosed only to linked knowers;
`hidden` facts go only to the storyteller/overseer.

### `story_summaries`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id | TEXT FK | |
| scope | TEXT | `scene` (one per closed scene) \| `story` (single rolling digest) |
| scene_id | TEXT | for scope=scene |
| content | TEXT | scribe_story output |
| covers_to_turn_index | INTEGER | freshness marker |

### `rules`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id | TEXT FK | |
| scope | TEXT | `story` \| `npc:<object_id>` \| `world` |
| text | TEXT | natural-language rule the overseer enforces |
| severity | TEXT | `hard` (block & regenerate) \| `soft` (annotate/warn only) |
| enabled | INTEGER | |

### `thread_log`
Append-only audit of every LLM interaction. Backs the debug UI.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| story_id, turn_id, session_id | TEXT | |
| agent_role | TEXT | |
| direction | TEXT | `request` \| `response` |
| payload_json | TEXT | full prompt or full completion + params |
| tokens_in / tokens_out | INTEGER | |
| duration_ms | INTEGER | |

Retention: configurable cap (e.g. keep last N turns' logs or size-based pruning) —
important on a phone.

### `jobs`
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| type | TEXT | `scribe_memory` \| `scribe_story` |
| turn_id | TEXT | |
| status | TEXT | `pending` \| `running` \| `done` \| `failed` |
| attempts | INTEGER | max 3, then `failed` + UI badge |
| payload_json | TEXT | |

### `settings`
Key-value runtime settings (debug visibility, context budgets, retention),
editable from the UI without touching `config.json`.

## Store APIs (contracts the code layers on)

```ts
// storyStore.ts
createStory(input: NewStory): Story
getStory(id): Story
appendTurn(t: NewTurn): Turn
updateTurn(id, patch): void
openScene(storyId, seed: SceneSeed): Scene
closeScene(sceneId): void
listTurns(storyId, { fromIndex, limit }): Turn[]

// memoryStore.ts
upsertObject(o: NewMemoryObject): MemoryObject
addFact(f: NewFact): MemoryFact
supersedeFact(oldId, f: NewFact): MemoryFact
linkKnowledge(factId, knower: Knower, opts?): void
getObjectView(objectId, scope: KnowledgeScope): ObjectView   // detail-level filtered!
searchFacts(query: MemoryQuery): RankedFact[]                // FTS + salience ranking

// agentStore.ts
ensureSession(storyId, role, npcObjectId?): AgentSession
appendMessage(sessionId, msg): void
getWindow(sessionId, budgetTokens): AgentMessage[]           // pinned + recent within budget

// threadLog.ts
log(entry: ThreadLogEntry): void
query(storyId, { turnId?, role?, limit }): ThreadLogEntry[]
```

`getObjectView(objectId, scope)` is the single choke point where detail-level
filtering happens — **no agent context is ever built from raw fact rows**, only
through this function. `KnowledgeScope` is one of:

```ts
type KnowledgeScope =
  | { kind: 'storyteller' }                    // sees everything incl. hidden
  | { kind: 'player' }                         // visible + facts linked to player
  | { kind: 'npc'; npcObjectId: string }       // visible + facts linked to this NPC (with distortions applied)
  | { kind: 'perception' }                     // visible only ("what you see when you look at it")
```
