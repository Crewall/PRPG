# 11 — Character sheets: description, state, variables, thoughts

**Status: built (milestones M2, M4 and M6 of doc 10)**, seeding and recaps after compaction included; the compactor does not propose thought merges yet (doc 10 §14). Part of the Minds engine ([doc 10](10-minds-engine.md)). This doc defines what a
character *is* in data, who may see and change each part, and how its self-written memory works.

---

## 1. What a sheet holds, and who sees it

Every character has a sheet, including the player character (who has no AI mind). The narrator keeps its own
notes in the same thought store (§5).

| Part | Holder (its own prompt) | Narrator | Other characters | Player, normal mode | Advanced mode |
|---|---|---|---|---|---|
| Description | always (system prompt) | always | never | own character only | all, editable |
| Appearance | always | always | when present | own + present characters | all, editable |
| State | always (each round) | always | never (they perceive effects via briefs) | own character only | all, editable |
| Variable, `public` | yes | yes | when present | yes | all, editable |
| Variable, `self` | yes | yes | no | own character only | all, editable |
| Variable, `hidden` | **no** | yes | no | no | all, editable |
| Thoughts | its own (recap + recall) | only if `narratorSeesThoughts` | never | no | all (incl. revoked), editable |

"Always sees its own description, state and non-hidden variables" (R10) and "the narrator sees all of those" are
invariants enforced by the context builders and pinned by tests.

## 2. Description and appearance

- **Description** (private, ≤ `descriptionMaxWords`, default 250): who the character is, meaning identity,
  personality, voice and manner, drives and fears, background, what it knows about itself (secrets included).
  It sits in the character's **frozen system prompt**, so editing it costs one cache miss and is fine.
- **Appearance** (public, 1–2 lines): what anyone perceives at a glance. Used in cast lists, given to other
  present characters, shown on the cast bar.

### 2.1 The player character

Created at story setup, in one of two ways:

- written by the user: description, appearance, starting variable values;
- drafted by the existing interviewer (≤ 3 questions; it now outputs a sheet instead of memory facts), then
  edited by the user.

Its state and variables are changed by the narrator (and the user). It has no thread of its own; the narrator's
prose is its POV.

### 2.2 Predefined cast

The scenario can list characters up front, with full sheets. They join the scene when the narrator brings them in
(`cast.enter` with a matching name or handle) or when the user adds them.

### 2.3 New characters during play (seeding)

When the narrator's block introduces a character (`cast.enter`: name + appearance) or the user adds one by name,
the app:

1. creates the roster object, a handle and a bare sheet;
2. queues a **seed** job (Medium tier).

The seeder reuses today's parse-first approach (`npc-story-seed`): first comb the recent story for everything
already established about the character, then invent the rest. It writes:

- the description;
- starting values for the character's variables, within their rules;
- 3–10 starting thoughts with tags (what it knows right now).

Until the job lands, the character plays from its appearance plus an "improvise consistently" note, as today.

## 3. State

- **One sentence**, ≤ 25 words: the character's current emotional and/or physical condition. Example:
  "Bruised ribs, adrenaline still high, suspicious of everyone."
- **Written by:** the holder (a proposal in its reply, usually emotional) and the narrator (in the round block,
  final, usually physical consequences). In the same round, the narrator's version wins. The user can change it
  in advanced mode (normal mode: own character only).
- **Shown:** to the holder in every round message, to the narrator in every round message, to the player for
  the player character.
- **History:** every change goes to the change log (§4.7) under the pseudo-key `$state`.

## 4. Variables

Defined **per story** (the scenario). A definition says what the variable means, its type and range, who holds
it, who sees it and who may change it, plus guidance for the AIs on when and how. Values are stored per holder.

### 4.1 Definition fields

| Field | Meaning |
|---|---|
| `key` | Stable identifier (`health`, `suspicion`, `alarm`). |
| `label` | Display name. |
| `type` | `number` · `text` · `choice` · `flag` · `list` (§4.2). |
| type options | Per type: range, step, options, length limits, item caps. |
| `scope` | `character` (each holder has its own value) or `world` (one value for the story). |
| `appliesTo` | For character scope: `all` · `player` · `npcs` · a list of handles. |
| `default` | Starting value for each holder (the seeder may set others within rules). |
| `visibility` | `public` · `self` · `hidden` (§4.4). |
| `changedBy` | Any of `narrator`, `self` (the user can always change values in advanced mode). |
| `maxStep` | Numbers only, optional: largest change one AI may make in one round. |
| `description` | For the AIs: what it means, what the ends of the range mean. |
| `changeGuide` | For the AIs: **when and how** to change it ("lower by 1–3 when hurt; 0 = unconscious"). |
| `bands` | Numbers only, optional: labelled ranges ("0–2 critical, 3–5 hurt, 6–10 fine") rendered next to the value so models read numbers consistently. |
| `order` | Display order. |

### 4.2 Types

| Type | Options | Value | Examples |
|---|---|---|---|
| `number` | `min`, `max` (each optional: unbounded allowed), `step` (default 1), `unit` | number | health 0–10, suspicion 0–100, standing −5…+5, gold ≥ 0 |
| `text` | `maxWords` (default 8) | short string | mood, title, current goal |
| `choice` | `options[]` | one option | loyalty: `crown` / `rebels` / `self` |
| `flag` | — | true / false | has_met_player, is_disguised |
| `list` | `maxItems`, `itemMaxWords` | list of short strings | inventory, conditions, known passwords |

Later: relation variables (a value per holder × target) and derived variables or triggers (doc 10 §14).

### 4.3 Scope

- `character` values exist for every holder `appliesTo` selects; a holder created later gets the default (or a
  seeded value).
- `world` values exist once (holder `world`), e.g. alarm level, weather, day count, faction standing.

### 4.4 Visibility and changers

| `visibility` | Holder sees | Other present characters see | Narrator | Player (normal) |
|---|---|---|---|---|
| `public` | ✓ | ✓ | ✓ | ✓ |
| `self` | ✓ | — | ✓ | for own character |
| `hidden` | — | — | ✓ | — |

For `world` variables: `public` = every present character and the player; `self` is invalid; `hidden` = narrator
only.

Validation of definitions (the scenario editor refuses these):

- `hidden` ⇒ `changedBy` must not include `self` (a character can't change what it can't see).
- `world` ⇒ `changedBy` must not include `self`. Later: allow named characters to change world variables.
- `choice` needs ≥ 2 options; `number` needs `min < max` when both are set; `default` must satisfy the type.

### 4.5 How the AIs see variables

**Character system prompt** (frozen): only the definitions it can see, with its permissions spelled out:

```
## Your variables
- health (0–10; 0–2 critical, 3–5 hurt, 6–10 fine): your physical condition.
  The narrator changes it when you are hurt or recover. You cannot change it.
- resolve (0–10): your will to keep going. YOU may change it, by at most 2 per round,
  when something shakes or steadies you.
- mood (a few words): how you feel. YOU may change it whenever it shifts.
- carrying (list): what you have on you. The narrator updates it; you may drop items.
```

**Character round message** (every round, short):

```
Your state: Pale and shaking, but defiant.
Your variables: health 4/10 (hurt) · resolve 7/10 · mood "cornered" · carrying [ledger, kitchen knife]
```

**Narrator system prompt:** all definitions, including `changeGuide` and who may change what.

**Narrator round message:** every present character's full sheet, with hidden variables marked:

```
#marta (Marta Vell): state "Pale and shaking, but defiant."
  health 4/10 (hurt) · resolve 7/10 · mood "cornered" · carrying [ledger, kitchen knife]
  hidden: suspicion_of_player 62/100 · secretly_informant true
World: alarm 2/5 · weather "rain" (public) · day 3
```

### 4.6 Change operations and validation

Operations: `set` (any type), `delta` (number), `add` / `remove` (list items), `toggle` (flag).

Pipeline for each proposed change (characters' proposals first, then the narrator's; user edits apply at once):

1. **Known key** and the holder is covered by `appliesTo` → else *rejected*.
2. **Changer allowed** (`changedBy`, and for `self` the holder must be the proposer) → else *rejected*.
3. **Type check** (number, valid option, list item length) → else *rejected*.
4. **Limits:** numbers clamped to `min`/`max`, delta clamped to `maxStep` → *clamped* (applied).
5. Otherwise *applied*. If the narrator and the holder both changed the same key this round, the narrator's
   value is final; the holder's is logged as *overridden*.

Each result is written to the change log. **Feedback:** rejected or clamped changes are reported to the proposer
in its next round message ("Not applied: you can't change health."), so models learn the rules without failing
the round.

### 4.7 Change log

`variable_changes` keeps every attempt: holder, key, old → new, operation, who (`narrator` | `self` | `user` |
`seed` | `system`), result (`applied` | `clamped` | `rejected` | `overridden`), reason (the AI's `why`), turn. Advanced
mode shows it as a per-holder timeline. Rewind deletes the rows written after the restored point.

### 4.8 Scenario editor and templates

**Story options → Scenario:** a list of definitions with add / edit / reorder / delete. Deleting a definition
that has values asks first. The editor shows a live preview of how a character and the narrator will see it
(§4.5). Templates are only starting points that fill the list, and the user edits from there. Examples, not final:

| Template | Variables |
|---|---|
| Simple adventure | health 0–10 (self, narrator) · stamina 0–10 (self, narrator) · mood text (self, self+narrator) · carrying list (self, narrator+self) |
| Intrigue | trust_in_player 0–100 (hidden, narrator) · loyalty choice (hidden, narrator) · composure 0–10 (self, self+narrator) |
| Survival | supplies number ≥ 0 (world, public) · weather choice (world, public) · day number (world, public) · exhaustion 0–10 (self, narrator) |

Saving your own scenarios as templates is a TODO (doc 10 §14).

## 5. Thoughts (self-written memory)

### 5.1 Why

Today's two memory designs both take authorship away from the character:

- **Classic:** a third-party scribe extracts "facts" about everything.
- **NPC Story Mode:** the character rewrites one notes blob every round, and the app cuts it at about 300 tokens,
  so anything a rewrite drops or truncation cuts is silently gone.

Thoughts are **additive records the character writes itself**, kept until it revokes them, each with tags so the
app can bring the right ones back at the right time.

### 5.2 Record

| Field | Meaning |
|---|---|
| `id` | Global id. |
| `owner` | The character's object id, or `narrator`. |
| `seq` → handle `t<seq>` | Short per-owner id the model uses (`t12`). |
| `text` | One statement, ≤ 40 words, first person or factual: "Marta keeps the ledger under the counter." |
| `tags` | 0–6 tags (§5.3). |
| `pinned` | Always delivered (see §5.4). Untagged thoughts are pinned automatically, since nothing could recall them. |
| `status` | `active` · `revoked` (soft; history kept). |
| `source` | `self` · `seed` · `compactor` (proposal) · `user`. |
| bookkeeping | `created_turn_id`, `revoked_turn_id`, `last_recalled_turn_id`, `recall_count`. |

### 5.3 Operations, tags and handles

- **remember** `{text, tags, pin}`: at most 3 per reply.
- **forget** `[t…]`: at most 5 per reply; only the owner's own thoughts.
- **Edit** = forget + remember, so history stays readable.
- **User** (advanced mode): add, edit, revoke, pin or unpin any thought.

**Tags** are normalized: lowercase, trimmed, spaces → hyphens, ≤ 32 characters.

- `#handle` tags refer to roster objects (§6) and are checked against the roster. An unknown `#x` is stored as
  the plain tag `x` and logged.
- The owner's **tag vocabulary** (its tags with counts) is shown in its recap and in the round message whenever
  it has changed, so it reuses tags instead of inventing synonyms. The narrator sees the tags in use among
  present characters for the same reason.

### 5.4 Recall: which thoughts a character gets each round

- **Pinned thoughts:** listed in full in the recap after each compaction. Between compactions the character
  already sees every pinned thought it created in its own earlier replies, so nothing is repeated (cache-friendly).
- **Tagged (unpinned) thoughts** are recalled when the situation evokes them.

**Active tag set** for owner O this round:

- the narrator's `tags` from the last round block;
- the narrator's `evoke[O]` from the last round block;
- the handles of present characters, the location, and items in view (`scene.items`);
- the addressee of anything said to O;
- any of O's own tags that appear as a word or phrase in O's pending briefs, the lines it heard, or the player's
  speech (normalized match).

**Selection:**

1. Candidates are O's active, unpinned thoughts with at least one tag in the active set, minus those already
   shown since the last compaction.
2. Score = 2 × matching tags + recency.
3. Take the highest until `thoughtRecallTokens` (default 300) is used.
4. They go into the round message as `You recall: t12 [ledger, #marta] Marta keeps the ledger under the counter.`
5. Mark `last_recalled_turn_id`.

**Limits and nudges:**

- Pinned thoughts over `pinnedTokens` (default 400): the round message adds "Your pinned thoughts are long;
  unpin or merge some."
- More than `maxActiveThoughts` (default 80) active thoughts: new `remember`s are rejected with a note, and the
  compactor proposes merges *(not built yet: doc 10 §14)*.

**The narrator** uses the same store and the same recall (owner `narrator`): its `notes` in the round block are
its thoughts, and recalled ones appear in its round message. If `narratorSeesThoughts` is on, the narrator's
round message also lists the thoughts each character recalled this round.

### 5.5 What the character is told about thoughts (system prompt excerpt)

```
## Your memory
You keep your own memory as short thoughts. Record what matters to you: facts you learned,
what you believe about people, promises, plans, grudges. One statement each, with a few tags
(topics, people as #handles, places, objects). Untagged or pinned thoughts are always with you;
tagged ones come back when something related happens. Forget thoughts that turned out wrong
or no longer matter. Your memory is private — no one else reads it.
```

## 6. Roster and handles

- Every roster object (`memory_objects`) gets a **handle**, unique within the story: `#` + a slug of the name
  (`#marta`, `#broken-wheel`, `#silver-locket`). Collisions get a suffix (`#marta-2`).
- **Created by:** the narrator's `cast.enter` (characters), `scene.location` with a new name (places), its
  `objects` list (items: name, type, one line), or the user.
- **Shown:** the narrator's recap lists the roster (handle + one line). Each character's round message starts
  with "Here:" followed by the location, present characters (handle + appearance) and items in view, so
  characters can address people (`to`) and tag thoughts with real handles.

## 7. Data model (migration `007-minds-sheets.sql`)

As built, with one change from the sketch below: `variable_defs` stores each definition as Zod-validated JSON
(`id, story_id, key, sort, def_json`), because the shape differs per type. Handles are stored without the `#`
(`marta`) and shown with it (`#marta`). The code: `src/minds/` (rules, pure) and `src/db/stores/mindsStore.ts`.

```sql
ALTER TABLE memory_objects ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX idx_objects_handle ON memory_objects(story_id, handle);

CREATE TABLE character_sheets (
  object_id    TEXT PRIMARY KEY REFERENCES memory_objects(id) ON DELETE CASCADE,
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  is_player    INTEGER NOT NULL DEFAULT 0,
  description  TEXT NOT NULL DEFAULT '',
  appearance   TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT '',
  tier_id      TEXT,                          -- per-character model tier override (doc 12)
  seeded       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE variable_defs (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,      -- number|text|choice|flag|list
  options_json TEXT NOT NULL DEFAULT '{}',                          -- min/max/step/unit/options/maxWords/maxItems
  scope TEXT NOT NULL, applies_to_json TEXT NOT NULL DEFAULT '"all"',
  default_json TEXT, visibility TEXT NOT NULL, changed_by_json TEXT NOT NULL DEFAULT '["narrator"]',
  max_step REAL, description TEXT NOT NULL DEFAULT '', change_guide TEXT NOT NULL DEFAULT '',
  bands_json TEXT, sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (story_id, key)
);

CREATE TABLE variable_values (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  def_key TEXT NOT NULL, holder TEXT NOT NULL,                      -- object id or 'world'
  value_json TEXT NOT NULL, updated_turn_id TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, def_key, holder)
);

CREATE TABLE variable_changes (                                     -- append-only log (also $state)
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  turn_id TEXT, holder TEXT NOT NULL, def_key TEXT NOT NULL,
  old_json TEXT, new_json TEXT, op_json TEXT NOT NULL,
  by TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE thoughts (
  id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  owner TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL,
  created_turn_id TEXT, revoked_turn_id TEXT, last_recalled_turn_id TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (story_id, owner, seq)
);
CREATE TABLE thought_tags (
  thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL, PRIMARY KEY (thought_id, tag)
);
CREATE INDEX idx_thought_tags_tag ON thought_tags(tag);
```

**Snapshots:**

- Copied whole per story: `character_sheets`, `variable_values`, `thoughts` + `thought_tags` (they stay small).
- Rowid watermark: `variable_changes`, which is append-only, like `agent_messages`.

## 8. Acceptance tests (milestone M2 of doc 10)

- Definition validation rejects `hidden` + `self`, a `world` variable with `self`, a bad `default`.
- Change pipeline: unknown key / disallowed changer / wrong type → rejected; out of range and over `maxStep` →
  clamped; narrator vs holder on the same key → narrator final, holder logged as overridden.
- Builders: a `hidden` variable **never** appears in its holder's prompt; a `self` variable never appears in
  another character's prompt; the narrator's prompt contains all of them.
- Thoughts: `forget` only affects the owner's own; untagged thoughts are pinned; recall picks by tag overlap
  within budget and never repeats a thought shown since the last compaction.
- Rewind restores sheets, variable values, thoughts, and deletes newer change-log rows.
