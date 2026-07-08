# 05 — Memory System

The memory system is the backbone that lets the story scale beyond a context
window and lets different agents know *different things*. Two core ideas:

1. **Facts, not blobs.** Memory is a set of atomic, categorized statements
   (`memory_facts`) attached to objects — not free-text character sheets. Atomic
   facts can be individually disclosed, superseded, distorted, and retrieved.
2. **Scoped views.** No consumer reads facts directly; everything goes through
   `getObjectView(objectId, scope)`, which filters by detail level and knowledge
   links. "Only give the relevant categories, e.g. visible aspects when looked
   at" is implemented here, once, for every agent.

## Object types & standard categories

| type | typical categories |
|---|---|
| `character` | appearance, personality, voice, state (health/mood), inventory, abilities, relations, history, goals, location |
| `item` | appearance, properties, state, location, history, ownership |
| `location` | appearance, layout, contents, inhabitants, history, state |
| `faction` | purpose, members, relations, resources, history |
| `event` | what-happened, participants, consequences, when/where |
| `lore` | free (world rules, religions, customs...) |

Categories are **soft taxonomy**: the scribe is prompted with this standard list
but may create subcategories (`appearance/clothing`, `relations/marta`). Retrieval
and views treat them as strings; the UI groups by them.

## Detail levels — the disclosure ladder

| level | meaning | who gets it |
|---|---|---|
| `visible` | perceivable by anyone looking: appearance, overt behavior, obvious properties | any scope, including bare `perception` ("you look at the stranger" → only these) |
| `known` | learnable, non-obvious info | scopes explicitly linked via `knowledge_links` (player and/or specific NPCs) |
| `secret` | actively concealed; a knower guards it | linked knowers only; storyteller told it is guarded |
| `hidden` | authorial truth not yet in play (planned twists, true identities) | storyteller & overseer only — never player, never NPCs (even the subject NPC, e.g. an amnesiac) |

Example — object *"The Hooded Stranger"*:

```
visible  appearance      "Tall figure in a rain-soaked grey cloak, face shadowed."
visible  state           "Keeps the right hand under the cloak at all times."
known    identity        "Calls himself 'Corvin', a spice merchant."   (player, Marta)
secret   identity        "Is actually Sera Voss, fugitive court mage." (Marta only)
hidden   goals           "Plans to burn the archive on the solstice."  (storyteller only)
```

When the player types "I look at the stranger", the context builder requests
`getObjectView(strangerId, {kind:'perception'})` → the two `visible` facts only.
When Marta's NPC agent is consulted, her context includes the `secret` identity
fact — and *only hers* does.

### Distortions (misinformation)

`knowledge_links.distortion` lets a knower hold a *wrong* version: the link's
distortion text replaces the fact content in that knower's view. This enables
lies, disguises and mistaken beliefs without forking the truth — the canonical
fact stays intact for the storyteller.

## The view API

```ts
interface ObjectView {
  id: string; type: ObjectType; name: string; aliases: string[];
  summary: string;                       // always included
  facts: { category: string; subcategory?: string; content: string;
           detailLevel: DetailLevel }[]; // filtered + distortion-substituted
}

getObjectView(objectId, scope: KnowledgeScope, opts?: {
  categories?: string[];    // e.g. only ['appearance','state'] for a glance
  maxTokens?: number;       // budget → keep highest-salience facts that fit
}): ObjectView
```

`opts.categories` implements *relevance filtering by category*: the context
builder passes different category sets per situation (a "look at" action requests
appearance/state; a combat action requests state/abilities/inventory; a social
action requests personality/relations/voice).

## Retrieval — `searchFacts`

Goal: given a turn about to be generated, find the facts each agent needs.
No embeddings in the MVP; ranked lexical retrieval is sufficient and phone-cheap:

```
query(scope, queryText, opts) →
  1. Entity pass: normalize queryText, match object names + aliases
     (exact, then prefix/fuzzy-lite) → hit objects get their view included whole
     (subject to category/budget opts).
  2. FTS pass: FTS5 MATCH over fact contents for remaining query terms
     (BM25 rank) → candidate facts.
  3. Scope filter: drop facts the scope may not see (same rules as views).
  4. Score: bm25 · w1 + object.salience · w2 + recency(source_turn) · w3.
  5. Return top-N within a token budget.
```

Also always included regardless of query: views of the current scene's location
and present NPCs (the "ambient" set). Optional later upgrade: embedding
rerank via `sqlite-vec` behind the same function signature.

## Write path — scribe pipeline (per turn, async)

```
turn completed
  └─ job: scribe_memory
       1. Detect mentioned entities (alias scan of turn text) → load their
          current facts → build extraction prompt. A compact roster of ALL
          objects (id/type/name/aliases) is always included so the scribe can
          resolve "the woman" to an existing Kate instead of duplicating her.
       2. LLM → MemoryDelta JSON (schema in 04-agents.md).
       3. Orchestrator post-processing:
          a. tempId resolution; alias/normalized-name match against existing
             objects → auto-merge exact matches, queue fuzzy ones as suggestions.
          b. Supersede handling: new fact contradicting an old one (same
             object+category, scribe sets supersedesFactId) → old fact flagged
             superseded (kept for history), new one inserted.
          c. knowledge_links from `knownBy` — the scribe decides *who perceived
             the reveal* from the narration (present NPCs list is in its prompt).
          d. Clamp fact count, clamp salience to [0,1], validate detail levels
             (a fact can move down the ladder over time — hidden→known when
             revealed — via supersede with same content, lower level).
          e. Stamp each new fact with the hidden in-game clock of its source
             turn (`game_time_min`) — events in memory carry an in-fiction
             "when", rendered as `d2 14:30` in prompts and the UI.
       4. Commit in one transaction; emit `memory.updated` WS event (UI refresh).
```

### Maintenance ("cleanup") job

Every M turns (default 10), or on demand from the memory UI ("clean up"):
- **entity unification** — an LLM pass over the object roster finds the same
  entity recorded under different names; `certain` merges apply automatically,
  `likely` ones are queued as suggestions for the player,
- **fact consolidation** — for the objects with the most live facts, an LLM
  pass deduplicates and unifies facts (supersede — history kept, knowledge
  links carried over) and refreshes `summary`,
- decay salience of long-unmentioned objects (×0.95 per cycle, floor 0.1).

### Entity merge

`mergeMemoryObjects(keep, merge)` folds a duplicate object into its canonical
twin **losslessly**: facts move over (near-duplicate contents are superseded,
their knowledge links copied to the surviving fact), knowledge links where the
duplicate was the *knower* follow it, scene rosters / NPC agent sessions / the
player-character setting are re-pointed, and the duplicate's name+aliases fold
into the kept object's aliases. Exposed as
`POST /api/memory/objects/:keepId/merge {mergeId}`, used by the suggestion
inbox's accept action, the maintenance job's certain merges, and the manual
"merge another object into this" control in the memory browser.

## Player-facing memory browser

The memory UI (read/write) shows the **player scope** by default — browsing it is
"what does my character know". Debug mode unlocks storyteller scope (all facts,
all levels, provenance links to source turns). Manual edits (player is the
game master of their own game) are allowed: create/edit objects and facts, change
detail levels, grant/revoke knowledge links; every manual change is journaled to
`thread_log` with `agent_role='user'`.

## Budgets (defaults, all settings)

| budget | default |
|---|---|
| story digest | 1200 tokens |
| scene summary | 500 tokens |
| storyteller retrieved-memory block | 1500 tokens |
| NPC persona + knowledge block | 1200 tokens |
| scribe_memory input snapshot | 2000 tokens |
| scribe_memory object roster | 120 objects |
| facts per object per view | 30 (salience-ranked) |
| new facts per turn | 20 |

The per-story budgets (digest, scene summary, retrieved memory, recent raw
turns) are editable in Story options → "Context budgets" — raising the digest
budget is the first lever when a long story starts losing its beginning.
