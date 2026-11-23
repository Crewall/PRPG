# 11 — Character sheets: description, state, variables, thoughts

**Status: built (milestones M2, M4, M6 and M7 of doc 10)**, seeding, recaps after compaction, the public profile (§2.4), the guaranteed player character (§2.1), names that are learned (§2.5), the narrator's hand-over and ties (§2.3, §2.6), relation variables (§4.9), the guided scenario editor (§4.8), thoughts v2 with kinds, importance and fading (§5.6–5.9) and the full character sheet (§5.10) included; the compactor does not propose thought merges yet (doc 10 §14). Part of the Minds engine ([doc 10](10-minds-engine.md)). This doc defines what a
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
- **Pronouns** (public, short: "she/her", "he/him", "they/them", or anything else): how others refer to the
  character. Shown with the name everywhere others see the character (§2.4).

### 2.1 The player character

A Minds story **always has a player character**: without one the player is an anonymous voice, absent from
everyone's "Here:" line and without a #handle, so characters can't tell the player from anyone else (a bug seen
in play: the barkeep took the player and the stranger for one person). It is created in one of these ways:

- written by the user: a small form (name, pronouns, appearance, who they are) that opens before a new Minds story
  starts, and from the 🎭 chip in the Present bar at any time;
- carried over from the classic player interview (the story's player object gets a sheet);
- **by the narrator**, as a fallback: while the story has no player character, or its sheet lacks a name-worthy
  appearance or pronouns, the narrator's round message asks for them and the round block's `player` field
  (`{ "name", "pronouns", "appearance" }`) creates the character or fills **only the empty fields**. What the
  user wrote is never overwritten.

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

Until the job lands, the character plays from what the narrator handed over (below), or, without that, from its
appearance plus an "improvise consistently" note.

**The narrator's hand-over (settled after a play test).** A seeder that only gets a name, a look and the prose
written to "you" has to guess who someone is: a player's 15-year-old sister came out as a stranger who knew "Rin
from the market, he sells spices". The narrator knows more at the moment it brings someone in, so `cast.enter`
carries it:

- `who`: 1–3 sentences of fact, from the player's words and the narrator's own plan: who they are, why they are
  here ("Rin's younger sister, 15; came to the market with Rin to buy a kettle"). Stored as the sheet's
  **concept**: the character's "Who you are" until the seeder's description lands, and canon for the seeder;
- `ties`: how the newcomer relates to people already in the story (§2.6).

**The seeder's inputs** (`seedContext` in `src/minds/seed.ts`):
1. **the frame:** the premise, genre, tone, the in-story time;
2. **the player character:** `#handle Name (pronouns) — look`, and the rule that "you" in the story text is always
   them, never the newcomer; the player's lines in the story are labelled `Player (#handle)`;
3. **the newcomer:** handle, look, pronouns, known-as, the narrator's hand-over (concept) and ties as canon, any
   description already written;
4. **what the newcomer perceived on arriving:** its first round messages (the narrator's brief, the words heard);
5. **who is around, as the newcomer perceives it:** the same "Here:" block its mind will get (place, people with
   their public profiles, names it doesn't know left out), and whose names it knows;
6. **the story:** the narrator's recap (after a compaction) and the recent story;
7. **its variables,** each with its range and visibility (hidden ones are theirs but unknown to them).

Left out on purpose: the narrator's secret notes, and every other character's description, state and thoughts.

**The seeder's outputs:**
- the **description** is who someone is (identity, voice, drives, fears, background, their people, secrets), never
  the current scene: the moment goes into **state** and the first **thoughts**. It is held to
  `descriptionMaxWords` (line breaks kept), and stray escaped newlines (`\n` written as text) become real ones;
- the **state** (one sentence, ≤ 40 words), starting values, and 3–10 first thoughts (the established canon first);
- **ties** the story shows but nobody recorded (added only; an existing tie is never changed).

### 2.4 The public profile (what others perceive)

Everything another character perceives about someone present, in one line of its "Here:" list:

```
#marta Marta (she/her) — Stout, flour on her apron, sharp eyes. · visibly: health hurt
```

- name and #handle, **pronouns**, **appearance**;
- the holder's **public variables** ("visibly: …"), so a visible wound or a drawn sword is known to everyone
  present (the table in §1 always said so; the builders now show it).

The narrator sees the same header on every sheet (`#marta (Marta, she/her) — …`). Pronouns come from the user,
the narrator's `cast.enter` (`pronouns` beside `appearance`) or the seeder, which fills them when empty.

**Places and things** have a public one-liner too: the object's summary, set by the narrator's `objects` list
(`line`) and updatable by it, including whose they are ("Kael's rented room"). The "Here:" line shows the
location's line and each item in view with its line.

**Briefs name people by #handle.** The narrator prompt says so, and a soft check backs it up: a brief that uses
he/she/him/her/his without any #handle, while its reader has two or more people around, earns the narrator a note
in its next round message ("name people by #handle so each character knows who is meant"). The brief is still
delivered.

*Later (doc 10 §14):* "known as" names per observer (Marta knows the player only as "the stranger" until told).

### 2.5 Names: who knows whom

Nobody knows a stranger's name. Until a name is heard, people are known by what they look like, and the app keeps
it that way for the player and for every mind. (A play test showed the leak: the player asked an unnamed girl her
name, her name was already on her chip, in everyone's "Here:" list and inside her handle, `#liraelen`.)

**Data.** Each sheet has a **known-as** label (≤ 5 words, public, e.g. "the elf girl in green"): how someone who
doesn't know the name refers to them. A `name_knowledge` row (viewer → subject) records that the viewer knows the
subject's name: a character's object id, or the player character's id for the player. Rewind and Retry cover it.

**Neutral handles.** In a story with names on, a new character's handle comes from its known-as label
(`#elf-girl-in-green`), never from its name, so the handle gives nothing away. Handles never change once given; the
label can be updated (she changes clothes) without changing the handle.

**Who knows a name:**
- every character knows its own;
- `cast.enter` may say whom the newcomer already knows (`"knows": ["#handle"]`) and who already knows the
  newcomer (`"knownBy": [...]`): family, old friends;
- **heard speech teaches names**: when a name of someone in the story is said aloud (as a whole word, the full name
  or its first word), everyone who heard the line learns that name; the player hears what is said around them;
- the narrator records any other learning in its block: `"names": { "#learner": ["#whose name"] }` (a letter, a
  name tag, an introduction it narrated without quoting);
- the user can mark a name as known or unknown for the player in advanced mode.

**What each viewer sees:**
- **A character's "Here:" block and the lines it heard** name a person only if it knows the name:
  `- #elf-girl-in-green (name unknown to you; she/her) — An elf girl in a green cloak.` /
  `#elf-girl-in-green: "Have you seen my brother?"`.
- **Briefs:** the narrator is told who knows which name; as a safety net, the app replaces any name the reader
  doesn't know with that person's #handle before delivery (heard speech is never altered: hearing a name is how
  it is learned).
- **The player:** chips, cards, the dialogue banner and the Cast tab show the known-as label until the player knows
  the name. Advanced mode shows the real name, marked "unknown to you".
- **The narrator** knows every name; its round message lists, per person present, whose names they know, and its
  prose uses a name only when the player knows it.

**Switch:** `minds.nameKnowledge` (Story options → Minds engine). On for new stories; off for stories created
before it existed, where everyone keeps knowing everyone's name (their handles were made from names anyway).

### 2.6 Ties: how people are related

A **tie** is how one character relates to another, from the holder's side: Mira → Rin "older sister",
Rin → Mira "younger sister", Briony → Liraelen "stranger she distrusts". Ties are data, so they reach every place
that needs them instead of living only in the prose.

- **Set by:** the narrator (`cast.enter.ties` for a newcomer, keyed by #handle or name, so two newcomers of the
  same round can be tied; `"ties": { "#holder": { "#other": "label" } }` in any round block, `""` removes one), the
  seeder (only ties the story shows that nobody recorded; it never changes one) and the user (the sheet editor:
  the player's own sheet, any sheet in advanced mode; `PATCH …/minds/:oid` with `ties: { "<object id or #handle>":
  "label" }`, `""` removes).
- **Seen by:** the holder (its own ties, in its system prompt under "Your people": `- #tall-stranger Rin: older
  sister`), the narrator (every tie, on each sheet), the seeder (as fact), the player (their own character's ties
  on its card; advanced mode: all).
- **Names come with ties:** a tie means the holder knows the other's name, and the other knows the holder's
  (§2.5).
- A label is short (≤ 8 words, a leading "my"/"your" and a trailing period dropped) and says what the other person
  is *to the holder*.
- Data: `character_ties` (story, holder, other, label, turn), covered by rewind and Retry.

## 3. State

- **One sentence**, ≤ 25 words: the character's current **physical and emotional condition, nothing else**.
  Example: "Bruised ribs, adrenaline still high, scared." (Settled after a play test where plans, opinions of
  people and facts piled up in the state.) Plans go to the agenda, views of people to opinions, facts to notes
  (§5.6); the character, narrator and seeder prompts say so.
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

Relation variables (a value per pair of characters) are §4.9. Later: derived variables or triggers (doc 10 §14).

### 4.3 Scope

- `character` values exist for every holder `appliesTo` selects; a holder created later gets the default (or a
  seeded value).
- `world` values exist once (holder `world`), e.g. alarm level, weather, day count, faction standing.
- `relation` values exist per pair of characters who have met (§4.9), e.g. Mira's trust in Agnes.

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

**Story options → Minds engine → Scenario variables** (also on the Cast tab). Rebuilt after a play test asked for a
"fluent" editor; the first version was a technical form (key, type, a free-text "all, player, npcs, or #handles"
field).

- **Three groups,** each with its own "+ Add": **The world** (one value for the story), **Each character** (every
  character, or the player, or the others, or chosen characters), **Between characters** (§4.9).
- **Quick start presets** per group, one tap each, then editable: world: weather, day, alarm, supplies; each
  character: health, stamina, mood, carrying, money, suspicion of the player; between characters: trust,
  affection, respect, fear, debt.
- **Each variable is a card** with a plain sentence instead of codes: "**Health**: a number 0–10, starts at 10.
  Every character has one. They see it; the narrator changes it." Tap to edit in place; ↑ ↓ to reorder; × to
  delete.
- **The form asks in plain words**, in this order: *Name* (the key is made from it; editable under "More");
  *What kind of value* (buttons: Number · Words · One of a list · Yes / no · A list of things) with only that
  kind's fields; *Who has it* (buttons, and for chosen characters a checklist of the cast by name); *Who can see
  it* (three cards: Everyone present · Only them (and the narrator) · Only the narrator); *Who changes it*
  (the narrator, they themselves); *What it means* and *When it changes* (for the AIs, with example
  placeholders). "More" holds the key, unit, largest change per round and labelled ranges.
- Problems show on the card they belong to as you type (the server's validation, through the preview call).
- The live preview of how a character and the narrator read it stays at the bottom (§4.5).
- **Values** are edited where they live: each character's sheet (§5.10), the world card on the Cast tab
  (advanced mode).

Templates are only starting points that fill the list, and the user edits from there. Examples, not final:

| Template | Variables |
|---|---|
| Simple adventure | health 0–10 (self, narrator) · stamina 0–10 (self, narrator) · mood text (self, self+narrator) · carrying list (self, narrator+self) |
| Intrigue | trust_in_player 0–100 (hidden, narrator) · loyalty choice (hidden, narrator) · composure 0–10 (self, self+narrator) |
| Survival | supplies number ≥ 0 (world, public) · weather choice (world, public) · day number (world, public) · exhaustion 0–10 (self, narrator) |

Saving your own scenarios as templates is a TODO (doc 10 §14).

### 4.9 Relation variables

A **relation variable** holds one value per pair of characters: Mira's trust in Agnes, Agnes's debt to Rin.
Settled with the owner: pairs exist **for characters who have met**.

- **Definition:** `scope: "relation"`, plus `mutual` (default false). One-way: Mira → Agnes and Agnes → Mira are
  two values (her trust in her ≠ hers in her). Mutual: one shared value per pair ("rivalry"). `appliesTo`
  selects the *holder* side (all · player · npcs · chosen); the other side is any character.
- **Pairs:** two characters have met once they were present in the same round (both in the scene, the player
  character included) or are tied (§2.6). Recorded in `character_met` (covered by rewind). A pair that never
  changed reads the default.
- **Storage:** `variable_values` with the holder `<from id>><to id>` (mutual: the two ids in sorted order); the
  change log uses the same holder.
- **Visibility:** `self` = the holder side sees its own value toward each person (mutual: both sides);
  `public` = anyone present sees it ("visibly: trust #mira → #agnes 2/10"); `hidden` = narrator only.
  `changedBy: self` means the holder side may change its own value.
- **The AIs see:** a character, in its round message, its values toward the people present ("Toward others:
  trust #agnes 2/10 · #rin 9/10"), with the definitions in its system prompt; the narrator, on each present
  character's sheet, their values toward the others present ("Toward others: trust → #agnes 2/10").
- **Changing:** the round block's `vars` entry takes `"to"`: `{ "who": "#mira", "to": "#agnes", "key": "trust",
  "delta": -2 }`; a character proposes `{ "key": "trust", "to": "#agnes", "delta": -1 }` for its own side. The same
  rules apply (§4.6): known key, the pair has met, changer allowed, type and range.
- **The sheet** (§5.10) has a "Toward others" table: one row per person met, one column per relation variable,
  editable in advanced mode.

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
| `kind` | `agenda` · `opinion` · `feeling` · `note` (§5.6). Older thoughts are notes. |
| `importance` | 1–10 as written (§5.6); the current importance fades (§5.7). Older thoughts are 5. |
| `about` | For opinions and feelings: the object id it is about. |
| `renewed_clock_min` | When it was written, revised or last came up (§5.7). |
| `revises` | The thought this one replaced (§5.8). |
| `tags` | 0–6 tags (§5.3). |
| `pinned` | Always delivered (see §5.4). Untagged thoughts are pinned automatically, since nothing could recall them. |
| `status` | `active` · `revoked` (forgotten) · `revised` (replaced, §5.8) · `faded` (§5.7). History kept. |
| `source` | `self` · `seed` · `compactor` (proposal) · `user`. |
| `created_clock_min` | The in-story time it was written. Shown with the thought (`t12 · Day 2, 19:40 [tags] text`) so a character keeps events in order. Empty for thoughts written before it existed. |
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

### 5.6 Kinds, importance and what is worth noting (settled with the owner)

Thoughts are a character's **memory of what matters**, not a log. After a play test the owner asked for marked,
rated thoughts: deep feelings, impressions of the people that matter, the character's own goals, written briefly
each round when something important happened, fading when old.

**Kinds** (`kind`):

| Kind | What it holds | `about` | Fades |
|---|---|---|---|
| `agenda` | What they are after and how: a goal or a plan. At most 3 active per character. | — | never; dropped or revised when done |
| `opinion` | What they think of someone (or something): an impression, a judgement. | required (#handle) | by importance |
| `feeling` | A deep feeling: love, fear, guilt, a grudge, a longing. | optional | by importance |
| `note` | A fact or event worth keeping: something learned, a promise, a secret. | optional | by importance |

**Importance** (`importance`, 1–10, set by the writer, editable by the user):

- 1–3 a passing detail · 4–6 matters for now · 7–8 strong: it shapes how they act · 9–10 defining: a vow, a
  life-changing event, love or hatred.
- **8–10 never fade.** **9–10 and the agenda are always on their mind** (like pinned).

**What is worth noting.** The character prompt asks for a note only when something happened that matters to
them, at most 3 per reply, a few words to one sentence each; trivia is skipped. Conflicting opinions about the
same person may stand side by side: that is ambivalence, and the sheet shows them together.

### 5.7 Fading (settled with the owner: fade by importance)

- Each thought has `renewed_clock_min`: when it was written, last revised, or last came up: recalled into a round
  message, restated, or already in the owner's thread and relevant again (its tags are active or its subject is
  present) in a round the owner acts.
- Its **current importance** = importance − one point per `minds.fadeHours` in-story hours since it was renewed
  (default 8 hours, Story options → Minds engine). Agenda items, pinned thoughts and importance 8–10 don't fade.
- At 0 the thought **fades**: status `faded`. It is no longer recalled or shown to its owner; it stays in the sheet
  under "Faded", where the user can restore it (renewed now). Fading runs at the end of every round, in the same
  transaction as the rest, so rewind restores it.
- The narrator's notes don't fade.

### 5.8 Revising

`revise: [{ "id": "t7", "text": "…", "importance": 6 }]` (at most 3 per reply) replaces a thought: the old one
becomes `revised` (kept as history: the sheet shows "was: …"), a new one takes its place with the same kind,
`about` and tags unless given, and `revises` pointing at the old one. `forget` stays for dropping a thought.

### 5.9 How thoughts reach the minds

- **Rendering:** `t12 · Day 2, 19:40 · opinion of #agnes, 7/10 [caseworker] She says what the file says, not
  what she sees.` Agenda: `t3 · agenda · Keep Agnes out of the foster system.` A note: `t9 · Day 1, 08:10 · 5/10
  [kettle] Rin promised the copper kettle.`
- **The character's round message:** "Your agenda:" and "Always on your mind:" (agenda, pinned and 9–10, each
  shown once per thread window as pinned thoughts are, §5.4), then "You recall:".
- **Recall score** = 2 × matching tags + 2 if its `about` is present + current importance ÷ 2 + recency; the
  `about` person counts as a tag. Taking the best within `thoughtRecallTokens`, as before. Recalled thoughts are
  renewed.
- **The narrator** (settled with the owner) sees, on each present character's sheet in its round message, their
  agenda and their opinions and feelings of current importance 7+: `Agenda: …` / `Strongly: (opinion of #agnes,
  8) …`. Everything else stays private, unless `narratorSeesThoughts` is on.
- **The seeder** writes the first thoughts with kinds and importance: one or two agenda items, opinions of the
  people present and tied, deep feelings the story or the hand-over implies, and key notes.
- **The compactor's** recap keeps what the high-importance thoughts point to; the recap lists the always-on
  thoughts (agenda, pinned, 9–10) in full.

### 5.10 The character sheet (advanced mode; settled with the owner)

Advanced mode → a character's card → **Sheet**: everything about one mind on one page, each part editable in
place.

- **Profile:** name, pronouns, known-as, appearance, "In short", description, state, model tier.
- **Variables:** every variable they hold, with inline editors (number field, text, choice, yes/no, list);
  hidden ones marked.
- **Toward others:** relation variables, one row per person met (§4.9).
- **Agenda:** up to 3 goals, editable, with add.
- **Opinions and feelings, by person:** grouped under each person (as the character knows them), with
  importance shown as a 1–10 bar; mixed opinions sit together.
- **Notes:** the other thoughts, highest current importance first.
- **Faded / revised / forgotten:** collapsed; faded ones can be restored.
- Each thought: kind, about, importance (current and written), text, tags, pin, forget; all editable. New
  thoughts can be added with kind, about and importance.

Normal mode keeps the public card for others and your own character's sheet.

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
(`id, story_id, key, sort, def_json`), because the shape differs per type. Later migrations: `013-minds-ties.sql`
(`character_sheets.concept`, `character_ties`), `014-minds-thoughts-v2.sql` (`thoughts.kind`, `importance`,
`about`, `renewed_clock_min`, `revises`, `status_turn_id`), `015-minds-met.sql` (`character_met`); relation values
use `variable_values.holder = "<from>><to>"`. Handles are stored without the `#`
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
