# 10 — Minds engine: one narrator, character minds, per-character briefs

**Status: M1–M8 are built: the Minds engine is the engine for new stories (dialogue mode, thread compaction, the public profile, names that are learned, the narrator's hand-over and ties, the director that works out who is spoken to, the full UI); the classic engine and NPC story mode are retired (they run existing stories only) and get deleted in M9, when the owner says so.** Companion docs:
[11 — character sheets](11-character-sheets.md) (description, state, variables, thoughts) and
[12 — models and providers](12-models-and-providers.md) (tiers, DeepSeek, caching).

A third engine beside the classic one and NPC Story Mode (see [docs/README](README.md) for those two). Every
character is a persistent AI mind with its own thread. A single narrator resolves each round and writes two
kinds of output: rich prose for the player and a short brief for each character, covering only what that
character perceived. The app (code, not AI) checks that output and delivers each part to the right thread.

---

## 1. Requirements (from the owner's brief)

| # | Requirement |
|---|---|
| R1 | A separate AI mind per character, each with its own persistent thread. |
| R2 | Characters have a description, a state (one sentence: emotional and/or physical) and scenario variables (stats). |
| R3 | Each character receives its **own brief version** of the story, limited to what it perceived. |
| R4 | Characters only declare a **short intent** and their **exact words**. Everything that happens to them is told by the narrator. |
| R5 | **Dialogue mode**: quick back-and-forth with one character instead of simultaneous rounds. Manual toggle first; automatic detection is a TODO. |
| R6 | One narrator weaves the story: verbose prose for the player, brief versions for the AIs. The app routes each part. |
| R7 | Threads are laid out for prompt-cache hits. |
| R8 | Characters write, keep and revoke their **own thoughts** (memories). Thoughts carry tags. Tagged thoughts are recalled when the situation evokes their tags. The narrator can evoke tags, and object IDs work as tags. |
| R9 | Variables are flexible: numbers with any range, text, choices, flags, lists. Each has rules: visibility (may be hidden even from its holder), who may change it, how and when. Defined per story scenario. The user sees and edits them in advanced mode. |
| R10 | A character always sees its own description, state and non-hidden variables. The narrator sees everything. |
| R11 | **Advanced mode**: everything visible and editable, plus a **POV filter** showing what each character sees, down to its exact prompt. |
| R12 | Model **tiers** (3 by default, user can add more) instead of picking a model per role; DeepSeek as a provider. (Doc 12.) |

## 2. Decisions

### Settled with the owner

| Topic | Decision |
|---|---|
| Narrator topology | **One central narrator.** Its single call returns prose for the player plus a hidden block of per-character briefs and state changes. The app does the routing; there is no AI "orchestrator". |
| Variables | Many types (any numeric range, text, choices, flags, lists), with visibility and changer rules. Defined per scenario. Visible and editable by the user in advanced mode. Doc 11. |
| Dialogue mode | Manual toggle in v1. Automatic detection: **TODO** (§14). |
| Player character | Gets the same sheet (description, state, variables), set up with the story. No AI mind. |
| Model tiers | User-defined; three by default (Heavy, Medium, Light). Doc 12. |
| Visibility | A character always sees its own description, state and non-hidden variables; the narrator sees all of them for everyone. |
| Advanced mode | Shows everything, allows editing everything, and has a POV filter (§10). |
| Player input syntax | `"…"` = speech, `((…))` = out-of-character note to the narrator, the rest = action (§6). Made obvious in the UI: placeholder hint, live preview, and the help panel. |
| Help | A **?** button opens a help panel that briefly explains every user-facing feature: syntax, modes, sheets, settings (§11.1). |
| Dice | The adjudicator + hidden dice **stay in the code** but are **not part of the v1 round**: the narrator decides outcomes itself. They may come back later for special cases (§9.4, §14). Never deleted. |
| Providers | DeepSeek and OpenRouter first. Claude moves to the official SDK later, at low priority (doc 12 §5.1). |

### Settled after the first review

| Topic | Decision |
|---|---|
| What characters hear of the player's turn | They hear the player's **spoken words** at once (the player has initiative). They do **not** see the player's *action*; they learn its outcome from the narrator. |
| Uncertain actions | v1: the **narrator decides** outcomes (no dice in the round). A referee pass with dice is a later feature for special cases (§9.4). |
| Narrator and thoughts | The narrator does **not** read characters' thoughts by default (they are private; characters reveal things through speech and intent). Per-story setting to allow it. |
| Old engines | The pre-Minds code is frozen on branch **`v1-backup`** (= `main` at `d506cd2`). Minds replaces the old engines on `main`, through PRs. The dice system is kept regardless. |

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Round** | One beat of play in normal mode: everyone declares → narrator → distribution. One `turns` row. |
| **Declaration** | What an actor puts in for a round: `say` (exact words) + `intent`/`do` (a short attempt, never an outcome). |
| **Brief** | The narrator's short second-person account for one character of what it perceived this round and what happened to it. |
| **Round block** | The fenced JSON the narrator appends after its prose: briefs, state and variable changes, tags, cast/scene/clock changes. Hidden from the player. |
| **Thread** | One agent's persistent conversation (narrator, or one character): a frozen system prompt + an append-only log. |
| **Sheet** | A character's description, appearance, state and variables. Doc 11. |
| **Thought** | One self-written memory record with optional tags; can be revoked. Doc 11. |
| **Handle** | A short `#name` ID for a roster object (character, place, item). Usable as a tag. |
| **Referee** | *(Later, special cases.)* The impartial chance-judge (today's adjudicator) plus hidden dice. |
| **Distributor** | A light fallback call that rebuilds a missing or broken round block from the narrator's prose. |
| **Compactor** | A light call that folds the oldest part of a thread into a recap when the thread grows too long. |
| **Tier** | A named model setting (Heavy / Medium / Light / user-defined) that roles point at. Doc 12. |

## 4. Coexistence with the existing engines

A story setting `engine: 'classic' | 'npc_stories' | 'minds'` replaces the `npcStories.enabled` flag. A migration
maps the old flag: `true` → `npc_stories`, otherwise `classic`. Existing stories keep their engine. Once milestone
M4 (§13) is in, new stories default to `minds`.

**Reused as-is:** story lock, snapshots/rewind (extended, §12), streaming gate (hides fenced blocks), clock,
scenes and the present-cast list, `memory_objects` as the roster (characters, places, items), the job queue,
`thread_log`, settings plumbing, the player interview (for drafting the player character's sheet), the dice and
outcome bands from `resolution.ts`.

**Not used by Minds:** memory facts and knowledge links, retrieval, the context planner, `scribe_memory` and its
cleanup jobs, `consult_npc`, scene summaries and the digest (the narrator's own thread plus compaction replace
them), `npc_profiles`.

## 5. A normal round

```
player input ──▶ parse {say, do, ooc}
                    │
   ┌────────────────┴──────────────────┐
   ▼ (parallel, Medium tier)           │
 character minds: declarations        │   stage 1
   └────────────────┬──────────────────┘
                    ▼ (Heavy tier, streamed to the player)
 narrator: prose ⏎ ```round {briefs, states, vars, tags, …}```   stage 2
                    ▼ (code)
 validate → commit in one transaction → distribute briefs
```

0. **Preflight.** Take the story lock, create the turn row, capture the snapshot.
1. **Parse the player's input** into a declaration (§6).
2. **Character calls** (parallel, Medium tier or the character's own tier override). Present characters are
   called when the gate passes (§5.1). Each call appends the round message to the character's thread and
   returns a `CharacterReply` (§9.1). Replies are **held in memory**, not applied yet, so a failed round leaves
   nothing behind. A failed call becomes "unavailable this round", as today.
3. **No referee in v1.** The narrator decides what every attempt achieves, judging by the sheets it sees
   (skills, health, state). The dice code stays; a referee for special cases is planned (§9.4).
4. **Narrator** (Heavy tier, streamed). Its thread receives the round message (§8.2). It writes prose for the
   player (verbosity setting applies), then a ```` ```round ```` block (§9.3). The existing gate stops
   streaming at the fence.
5. **Block check.** Parse and validate the block against the schema and the variable rules (doc 11 §4.6). If it
   is missing or unparseable, run the **distributor** (Light tier) on the prose and the cast list to produce
   one. If that also fails, give each present character a generic brief built mechanically (everyone's spoken
   lines + "see what happens next"). The round still completes.
6. **Commit** (single transaction):
   - Character replies → each character's thread as its assistant message, stored **byte-for-byte** as received.
   - Thought operations → `thoughts` (doc 11 §5).
   - Variable and state changes: characters' allowed proposals first, then the narrator's (the narrator wins on
     the same field). All of them go to the change log.
   - Briefs → stored as pending brief text for each character. They are delivered as the opening part of that
     character's next round message (§8.1), together with everyone's spoken lines they heard, so the exact
     words never depend on the narrator's paraphrase.
   - Narrator notes, situation tags, cast/scene changes, clock → applied.
   - The narrator's reply → its thread.
   - The turn row → `complete`, with meta: declarations, round block, call timings, cache usage.
7. **Post-round jobs (async):** compaction for any thread over its threshold (§8.4), seeding for newly entered
   characters (doc 11 §2.3).

**Latency:** two sequential stages (characters in parallel → streamed narration). The classic engine worst case is up to three storyteller calls plus consults, and the
player sees nothing until the end. The heavy background scribes are gone; the only post-round work is occasional
compaction.

**Requests per round** matter for rate-limited free models (OpenRouter `:free`: 20 per minute; 50 per day
without purchased credits, 1000 with; doc 12 §6.1).

| Case | Calls |
|---|---|
| Typical round | 1 narrator + 1 per called character (≤ `maxCharactersPerRound`). With 3 characters: **4**. |
| Occasional | + distributor (broken block), + compactor (per thread over its threshold), + seeder (new character) |
| Dialogue mode | **1** per exchange; 1 narrator call at wrap-up |

The UI shows the day's request count per provider (doc 12 §6.1) so a free quota running out is visible before it
fails.

### 5.1 Who gets called (the gate)

Reuses `shouldInvokeNpc`. A present character is called when any of these holds:

- it has no reply yet in its thread (just created or just entered);
- the player's speech or `do` mentions it;
- its pending brief is non-empty and the narrator listed it in `spotlight` (§9.3);
- it acted last round;
- the user forces it (UI: tap the character chip).

Present but not called: no call, but its pending brief stays pending, so the next time it is called it reads
everything it witnessed, in order. Cap: `maxCharactersPerRound` (default 4; spotlighted characters first).

### 5.1b Who is being spoken to (the director)

The gate above calls everyone who is new or acted last round, and the player's words reach everyone with no
addressee. So when the player asked one girl her name, all three people present answered. The player can't name
the addressee either: they may not know the name yet (doc 11 §2.5). Before the gate, the round works out **the
direction** of the player's words:

1. **Obvious cases, no AI call:**
   - no speech (only an action): no direction, the gate works as above;
   - only one other person present: them;
   - the player's message names someone present: by a #handle, a name the player knows, or their known-as label
     ("the wary woman");
   - pure speech (no action) when exactly one person spoke to the player last round: a reply to them.
2. **Otherwise a director** (role `director`, Light tier, prompt `minds-director`, a stateless helper) reads the
   people present as the player knows them, the last lines spoken (who said what to whom) and the player's
   message, and answers `{ "to": ["#handle"], "all": false, "react": ["#handle"], "why": "…" }`. If it fails,
   there is no direction and the gate works as above.

**What the direction changes:**
- **The gate:** when the words are for particular people, those are called, plus anyone the director says would
  react, the narrator's spotlight and forced characters; nobody else (no "first appearance" or "acted last
  round" calls). `all` calls everyone (capped).
- **What everyone hears:** the player's line carries its direction, `#tall-stranger: "What's your name?" (to
  #elf-girl-in-green)`, live and in the *Heard* lists; the narrator reads "says … to #…".
- **The character prompt:** words said to someone else aren't yours to answer: react, or cut in only when you
  really would.
- The turn records it (`meta.direction`: to, all, react, and whether it came from a rule or the director).

### 5.1c Briefs carry perception only

A brief tells a character what it perceived: what it saw, heard and felt in its body, and the outcomes that touch
it. It never says what the character thinks, plans, concludes or wants: that is the character's own mind's job. (A
play test brief said "You're calculating: is this a scam?"; the character then acted out the narrator's thought.)
The narrator and distributor prompts say so, and a soft check (like the he/she check) flags briefs that tell a
character its thoughts ("you're calculating", "you decide", "you wonder") and reminds the narrator next round; the
brief is still delivered.

### 5.1d Places and things (settled after a play test)

A play test's Memory tab filled with empty duplicates: "Agnes's stuffed rabbit" and "Agnes's stuffed rabbit
(Bun)", "Caseworker's clipboard" and "Caseworker's clipboard (removed)". The narrator was never shown which places
and things already existed or their #handles, so it named them afresh each time, and marked a removal by renaming.

- **The narrator's round message lists them:** `Places and things (reuse these #handles):` the location, the
  things in view, then up to 12 other known places and things, most recently touched first (`#handle (name) —
  line`). Things that are gone are left out.
- **`objects` matches what exists** by #handle, by name ignoring case and a trailing parenthesis ("(Bun)" becomes
  an alias), and by the handle its name would get. A trailing "(removed)", "(gone)", "(destroyed)", "(lost)" or
  "(taken)" marks the thing gone instead of creating one. `"gone": true` is the proper way.
- **The Memory tab in a Minds story** shows what Minds keeps: places and things with their public line, whether
  they are here, in view or gone, and (advanced mode) how many thoughts mention them; edit the name and line,
  mark gone or back, merge a duplicate into another (its thoughts' tags follow), delete. No facts, no
  promote/demote: those belong to the legacy engines. Characters live on the Cast tab.

### 5.2 Settled while building M4

- **The player's words, once.** A called character hears the player's words in its round message ("Right
  now"), so its brief's *Heard* list leaves them out; characters not called get them in the *Heard* list.
- **The opening round.** The first round of a story with an empty message carries an out-of-character note
  asking the narrator to set the scene and bring in the first characters (`cast.enter`, with briefs). The client
  sends that empty message automatically when a story with no turns is opened.
- **Narrator changes are computed from the start of the round** (the state the narrator saw); a character's own
  change to the same key that round is logged as *overridden*.
- **Names and handles in the block** are resolved leniently: `#handle`, the character's name, or a slug of the
  name; `#player` / `player` mean the player character. Unknown holders are recorded in the turn's
  `blockProblems`, never fatal.
- **Turn meta** keeps the gate's choices and reasons, every declaration (with errors and parse problems), the
  parsed block, where it came from (`narrator` / `distributor` / `fallback`), and change counts.
- **Scene items** are stored on the scene (`items_json`, migration 009); the narrator's `scene.location` and
  `scene.items` create roster objects for names it hasn't introduced.

## 6. The player's input

One input box, three lanes, parsed mechanically:

| Lane | Syntax | Who sees it |
|---|---|---|
| **Say** | text inside double quotes `"…"` | Narrator; present characters (heard immediately, §2 proposal) |
| **Do** | everything else | Narrator only. Characters learn the outcome from their brief. |
| **OOC** | text inside double parentheses `((…))` | Narrator only, as an out-of-character note ("make it rain", "skip to evening") |

Making it obvious:

- the empty box's placeholder reads `"Say this" · do that · ((note to narrator))`;
- a live preview under the box splits the text as it will be read: **heard:** … / **doing:** … / **to narrator:**
  …, so a stray quote can't leak an intention;
- a small **?** next to the box opens the syntax entry of the help panel (§11.1).

Empty input = "continue / wait".

## 7. Dialogue mode (manual)

**Entering.** The user taps a present character's chip → "Talk". The UI switches to chat bubbles. The round
loop pauses.

**Each exchange.**

1. The player's line (speech, plus an optional short gesture outside quotes) is appended to the partner's thread.
2. One call to the partner (its tier), reply `DialogueReply` (§9.2): `say`, `gesture` (small visible action, no
   outcome), optional `state` and thought operations.
3. The reply shows immediately as a bubble. Clock +1 minute per exchange.

No narrator, no referee, no other characters are called.

**Leaving** (any of these):

- the user taps "End conversation";
- the partner's reply sets `act` (it wants to do something consequential) — the app ends the dialogue and starts
  a normal round with that intent already declared;
- the player types an action with "Act" instead of "Say" — same thing, normal round with the player's `do`.

**Wrap-up.** One narrator call with the dialogue transcript appended to its thread. It returns short bridging
prose (optional, may be empty) and a block: briefs for **bystanders** (what they overheard or noticed), state
and variable changes, tags. The partner's own thread already holds the whole conversation, so it gets no brief
unless something happened around it.

**Settled while building M5** (`src/minds/dialogue.ts`, the wrap-up in `src/minds/round.ts`):

- **Each exchange is its own turn** (`meta.mode: 'dialogue'`, `meta.partner`, `meta.reply`), so rewind and edit work
  on single exchanges. The server keeps no dialogue state: the open conversation is the run of dialogue turns at
  the end of the story. The client sends `turn.submit` with `dialogue: { partner }`.
- **The partner's round message** carries its waiting briefs as usual, then `Right now:` with the player's line
  (`#kael Kael: "…" (gesture)`), and asks for the conversation format (§9.2). The reply is stored byte-exact in its
  thread; `state` and memory operations apply as in a round; the player reads `Marta: "…" (gesture)`.
- **Ending is just a normal message.** Any normal turn after open dialogue turns is the **wrap-up**
  (`meta.mode: 'wrapup'`): nobody is called; the narrator's round message gets the transcript and the instruction
  to bridge back, resolve what the player (and the partner, if it acted) now try, and brief every bystander. An
  empty message = "End conversation"; text sent with **Act** = the player's action. When the partner's reply has
  `act`, the client ends the conversation itself and sends the wrap-up; the act is the partner's declaration.
- **The player's line in dialogue** follows the input syntax (§6): speech in quotes, a gesture outside them, an
  OOC note in `((…))`. The OOC note reaches the narrator at the wrap-up (in the transcript), never the partner.
- **UI:** tap a character in the Present bar → confirm → a banner ("💬 Talking with Marta — only they hear you",
  End conversation, Act); Send becomes Say. An open conversation is restored after a reload.

**TODO (automatic dialogue mode):** detect a conversation (the player addresses one character with speech only,
twice in a row) and suggest entering dialogue mode; later, switch automatically. Not in v1.

## 8. Threads and context assembly (cache layout)

Every thread has the same shape, and each part is **append-only**:

```
[ system ]   frozen: rules, output contract, the agent's description, scenario variable definitions
[ recap  ]   present only after a compaction: "what you remember so far" + your sheet at that point
[ log    ]   round message, reply, round message, reply, …   (stored exactly as sent and received)
[ newest round message ]   the only uncached part of a request
```

Why this works with every provider: Anthropic's automatic caching and its explicit breakpoints, OpenAI's
automatic prefix cache, and DeepSeek's disk cache all reuse an **unchanged prefix**. DeepSeek creates cache units
at the end of each user input and each model output, so a thread that only appends hits at every boundary
(details in doc 12 §6). Nothing volatile (clock, dates, changing summaries) is placed before the log.

**Rules (enforced by tests):**

- Messages are stored as the exact strings sent and received; the builder never re-renders old messages.
- Rendering is deterministic: sorted keys, stable ordering, no timestamps in the system prompt.
- Adjacent same-role messages are merged by one fixed rule (newline join), the same every time.
- Edits that rewrite the system prompt or old log messages (description edits, editing a past brief in advanced
  mode) are allowed. They cost one cache miss and are marked in `thread_log`.
- **Building is read-only.** `buildCharacterCall` / `buildNarratorCall` (`src/minds/builders.ts`) only read, so the
  advanced-mode "next prompt" preview uses the same function as the round. `commitCall` then stores the round
  message **together with** its reply (a failed call stores nothing, so no dangling message can break the
  prefix), marks the pending items delivered and the shown thoughts recalled.
- **Which thoughts a round message shows** (settled while building M3): pinned thoughts not yet visible in the
  thread are shown once ("Always on your mind"), which covers seeded and user-added pins before any compaction;
  tagged thoughts follow doc 11 §5.4. "Already visible" means shown in a round message since the last
  compaction, or written by the owner in its own reply since then.

### 8.1 A character's thread

| Part | Content |
|---|---|
| System (frozen) | Character rules (stay in character; declare, never narrate outcomes; brevity; how to use thoughts and tags), the reply contract (§9.1), **its own description**, its appearance, the definitions of the variables it can see (meaning, range, how and when it may change them). |
| Recap (after compaction) | First-person summary of what it experienced before, its pinned thoughts, its tag vocabulary. |
| Round message | ① **Here:** location, present characters (handle + appearance), items in view; ② pending brief(s) since its last call, oldest first; ③ lines it heard, verbatim, with speakers; ④ **its sheet now**: state + visible variables (short, every round), plus "not applied" notes for any rejected or clamped change it proposed (doc 11 §4.6); ⑤ **recalled thoughts**: tagged thoughts evoked this round that it hasn't been shown since the last compaction (doc 11 §5.4); ⑥ the ask: "Declare what you say and what you try to do." |
| Reply | `CharacterReply` JSON as received. |

The character sees its own earlier `remember`/`forget` operations in its own replies, so pinned thoughts created
since the last compaction never need repeating; the recap restates the full pinned list after each compaction.

### 8.2 The narrator's thread

| Part | Content |
|---|---|
| System (frozen) | Narrator rules, prose style (genre, tone, verbosity), the round-block contract (§9.3), the premise, scenario variable definitions with their rules, the narrator's secret setup notes. |
| Recap (after compaction) | "The story so far" + the roster (handles, one line each). |
| Round message | ① the player's declaration (say / do / OOC) and the player character's sheet; ② each present character's **full sheet** (description, appearance, state, all variables including hidden ones) + its declaration (say, intent, proposed state); ③ *(later, special cases)* referee outcomes (band guidance + complication; no numbers); ④ the clock; ⑤ the narrator's evoked notes and the tags currently in use; ⑥ the ask. |
| Reply | Prose + round block, as received. |

Full sheets every round cost a few hundred tokens per character. They are cached from the next round on, and
they keep the narrator from drifting on numbers. Optimization for later: send full sheets only on entry and after
compaction, and changes in between.

### 8.3 Stateless helpers

Referee, distributor, compactor, seeder and wrap-up don't keep threads. Each gets a small, fixed system prompt
(cached across calls) plus its inputs. They are logged in `thread_log` like every call.

### 8.4 Compaction

When a thread's log exceeds its threshold (settings: `characterLogTokens` default 8k, `narratorLogTokens`
default 32k), a Light-tier compactor folds the **oldest half** of the log into the recap:

- First person for a character ("what I experienced, what I said"). It may propose pinned thoughts for anything
  important, which the character confirms or revokes on its next call.
- Third person for the narrator.

The new recap replaces the old one (it is rewritten to include it), and the folded messages are flagged
`compacted`. Cost: one cache miss for that thread on its next call. A compaction is tied to the turn that
triggered it, so rewind undoes it (§12).

**Settled while building M6** (`src/minds/compaction.ts`):

- **When:** after a round (or a dialogue exchange) commits, each thread it touched is measured (live log tokens,
  estimated); one over its threshold gets a `minds_compact` job, at most one queued per thread. The player never
  waits for it.
- **What is folded:** whole rounds (a round message + its reply) from the oldest, until they hold half the log's
  tokens. The newest round always stays live, so a thread with one round is never folded.
- **The compactor** is a stateless helper (role `compactor`, Light tier by default) with one fixed system prompt
  (`minds-compactor`, editable in Settings) for every thread, so it caches across calls. It reads whose thread it
  is, the earlier recap (to fold in) and the folded rounds (the narrator's hidden blocks left out), and replies
  `{ "recap": "…", "pins": [{ "text", "tags" }] }`. Recap caps: 350 words (character), 900 (narrator).
- **The stored recap** is the compactor's text plus what must not be lost, rendered by the server: the owner's
  pinned thoughts, a character's tag vocabulary, the narrator's roster (handle, name, appearance). The restated
  pins are marked recalled at the compaction's turn, so round messages don't repeat them. Up to three `pins` a
  character's compactor proposes become pinned thoughts (source `compactor`), shown once on its next turn under
  "Always on your mind", where it keeps or forgets them.
- **Safety:** the fold applies in one transaction, and only if the folded rows are still the oldest live ones and
  the recap is still the one folded in; a job whose turn was rewound does nothing. A failing compactor leaves the
  thread as it was (the job retries, then fails).
- **Thresholds** are in Story options → Minds engine.

## 9. Output contracts

All JSON is validated with Zod; server-side clamps are listed for each. On validation failure the existing
repair-retry applies once; after that, the fallbacks of §5 step 5 (narrator) or "unavailable" (character).

### 9.1 `CharacterReply` (normal round)

```json
{
  "say": "exact words spoken aloud, or \"\"",
  "to": "optional #handle of who they address",
  "intent": "what they try to do, ≤ 25 words, or \"\"",
  "state": "optional: their physical and emotional condition now, one sentence",
  "vars": [{ "key": "resolve", "set": 6, "why": "short reason" }, { "key": "trust", "to": "#agnes", "delta": -1 }],
  "remember": [{ "kind": "opinion", "about": "#agnes", "importance": 7, "text": "one statement ≤ 40 words", "tags": ["caseworker"] }],
  "revise": [{ "id": "t4", "text": "the thought as it stands now", "importance": 6 }],
  "forget": ["t7"]
}
```

Clamps: `say` ≤ 80 words; `intent` ≤ 25 words; `state` ≤ 25 words (one sentence); at most 3 `remember`, 3
`revise` and 5 `forget` per reply; `kind` defaults to `note`, `importance` to 5 (clamped to 1–10); at most 3
active agenda items (doc 11 §5.6–5.8). `vars` may only touch variables this character can see **and** may change (doc 11 §4.4);
anything else is rejected and logged, never fatal. Whispering (`to` + private) is a TODO.

### 9.2 `DialogueReply`

```json
{ "say": "…", "gesture": "small visible action, no outcome, ≤ 15 words", "state": "…",
  "remember": [], "forget": [], "act": "optional: a consequential intent → ends the dialogue" }
```

### 9.3 The narrator's round block

Written after the prose, fenced as ```` ```round ````, never shown to the player:

```json
{
  "briefs": { "#marta": "You see the stranger…", "#tom": "…" },
  "spotlight": ["#marta"],
  "state": { "#marta": "Pale and shaking, but defiant.", "#player": "Bruised ribs, adrenaline high." },
  "vars": [ { "who": "#marta", "key": "health", "delta": -2, "why": "struck by the bottle" },
            { "who": "world", "key": "alarm", "set": 2, "why": "glass shattered" } ],
  "tags": ["tavern", "ledger", "violence"],
  "evoke": { "#marta": ["debt"] },
  "notes": { "remember": [{ "text": "Tom is the informant", "tags": ["#tom", "informant"] }], "forget": [] },
  "cast": { "enter": [{ "name": "Guard Captain Held", "appearance": "tall, scarred, city colours" }], "exit": ["#tom"] },
  "objects": [{ "name": "silver locket", "type": "item", "line": "tarnished, engraved with an M" },
              { "name": "#ledger", "gone": true }],
  "scene": { "break": false, "title": null, "location": "#tavern", "items": ["#ledger", "#silver-locket"] },
  "time": 10
}
```

- `briefs`: one per present character that perceived anything. Second person, ≤ `briefMaxWords` (default 70).
  What it saw, felt and suffered, and the outcomes that touch it. Others' spoken lines are added by the app
  (§5 step 6), so briefs don't need to quote them. A character the narrator omits gets "nothing notable
  changes" plus the heard lines.
- `state`: final state sentences; overrides the character's own proposal for the same round.
- `vars`: checked against each variable's rules; the narrator may change only variables whose `changedBy`
  includes `narrator`.
- `tags`: situation tags for this round. `evoke`: extra per-character tags. Both feed recall next round (doc 11 §5.4).
- `notes`: the narrator's own thoughts (owner = narrator; same store and recall as characters' thoughts).
- `cast.enter`: creates a roster object + sheet; a seeding job fleshes it out. `cast.exit` removes from the scene.
- `objects`: new roster items (handles assigned by the app), or existing ones by #handle to update their line;
  `"gone": true` when one is destroyed, taken away for good or no longer exists. `scene.items`: what is in view;
  feeds the "Here:" line and thought recall (doc 11 §6). See §5.1d.
- `vars` entries for relation variables carry `"to"` (doc 11 §4.9).
- `time`: in-game minutes this round spans (replaces `advance_time`); missing → default.

### 9.4 Referee (later: special cases)

**Not in v1.** Planned for special cases, e.g. contested or high-stakes attempts that the narrator (via a block
field) or the user (via a button) flags for a roll. The code it builds on (`resolution.ts`, the adjudicator) stays
in the repository. Sketch:

Input: a list of `{actor, action, sheet excerpt}`, the location, and the round context in one paragraph. Output:

```json
{ "rulings": [ { "actor": "#player", "action": "…", "ruling": "trivial" },
               { "actor": "#marta", "action": "…", "ruling": "roll", "chance": 35,
                 "complication": "…", "factors": ["…"] } ] }
```

The existing adjudicator prompt (realism over drama, physics not morals) carries over, extended to many actions,
and reads numeric variables (skills, health) as factors.

## 10. Advanced mode and the POV filter

A global toggle in the header (persisted per installation). It replaces today's `debug.showThreads`.

**Visibility.**

| | Normal mode | Advanced mode |
|---|---|---|
| Story | Narrator prose; dialogue bubbles | + round blocks, referee rulings with numbers, cache stats per call |
| Player character | Description, appearance, state, its `public`/`self` variables | everything, editable |
| Other characters | Appearance; `public` variables | description, state, all variables (hidden ones marked), thoughts (active and revoked), briefs |
| World variables | `public` ones | all |
| Narrator | — | its notes, tags in use, its thread |

**Editing (advanced only):** descriptions, appearance, states, variable values (validated by type; logged as
`by: user`), thoughts (add, edit = revoke + add, revoke, pin), the narrator's notes, past briefs (costs one cache
miss), and variable definitions (the scenario editor).

**POV filter.** A selector above the transcript: `Player · Narrator · <each character>`.

- **Player:** the normal transcript.
- **Character X:** X's thread rendered as a story: the briefs it received, the lines it heard, its sheet per
  round, recalled thoughts, and its own replies (say / intent / thought operations). This is exactly what X's
  mind experienced, nothing more.
- **Narrator:** declarations, referee rulings, prose and blocks.

Each POV has two buttons:

- **Last prompt:** the exact request that was sent, from `thread_log`.
- **Next prompt:** a preview built by the **same builder function** the round will use, so preview and reality
  cannot diverge. A test pins this.

## 11. API and UI (as built in M7)

```
GET   /api/stories/:id/minds[?advanced=1]         → sheets of all characters + the world's values (filtered by mode)
POST  /api/stories/:id/minds                      { name, isPlayer?, pronouns?, appearance?, description?, state? }
PATCH /api/stories/:id/minds/:oid                 { name?, pronouns?, description?, appearance?, state?, tierId? }
GET   /api/stories/:id/variables/defs             → definitions
PUT   /api/stories/:id/variables/defs             { defs: [...] }   (scenario editor; validated, ordered)
POST  /api/stories/:id/variables/preview          { defs: [...] } → how a character and the narrator read them (not saved)
PATCH /api/stories/:id/variables/values           { changes: [{ holder, key, op?, value }] }   (advanced; logged by:user)
GET   /api/stories/:id/variables/changes          → the change log, with holder names
GET   /api/stories/:id/thoughts?owner=…&includeRevoked=1 → thoughts + tag vocabulary
POST  /api/stories/:id/thoughts                   { owner, text, tags, pin }   (advanced)
PATCH /api/thoughts/:tid                          { revoked?, pinned? }   (advanced)
GET   /api/stories/:id/pov/:oid                   → one mind's thread: recap, log, what waits for its next round
GET   /api/stories/:id/pov/:oid/prompt?which=last|next → exact prompt (advanced)
GET   /api/stories/:id/calls                      → the Threads view: one row per agent call
```

Dialogue mode needs no endpoints of its own: `turn.submit` carries `dialogue: { partner }` for an exchange and
`force: [ids]` for "act next round" (settled in M5). The WebSocket's existing `turn.status`, `turn.final` and
`minds.updated` cover the UI's needs.

UI pieces (`client/dist/minds.js`, `help.js`, wired in `app.js`):

- **Present bar:** tap a character → their **card** (what you perceive; everything in advanced mode) with
  **Talk**, **Act next round** (⚡ on the chip until the next round) and **Edit**; 🎭 is your own sheet, or the
  player-character form while there is none. 🔍 toggles **advanced mode** (per story, remembered in the browser).
- **Input preview** under the chat (Minds): how the message will be read (🗣 said · 🤚 tried · 📝 note), or the
  syntax when the box is empty.
- **Drawer tabs (Minds):** **Cast** (every sheet; in advanced mode also absent characters, the narrator's notes
  and the change log), **POV** (advanced: a mind's thread, its next and last prompt), Memory, and with Debug on
  Summaries and **Threads**.
- **Sheet editor** (advanced, and your own sheet always): name, pronouns, appearance, description, state, tier
  override, every value by type, thoughts (pin, forget, add).
- **Scenario editor** (Story options → Minds engine, or the Cast tab): templates, add / edit / reorder / delete,
  each field by type, and a live preview of what the AIs will read.
- **Help** (**?**) in every top bar (§11.1).

### 11.1 Help panel

A **?** button in the header opens a side panel of short, scannable entries: a few sentences and one example
each, grouped:

| Group | Entries |
|---|---|
| Playing | Input syntax (say / do / OOC, with examples) · what a round is · what the narrator decides vs what you decide · dice and chance (described, never numbers) |
| Characters | Dialogue mode (enter, exit, what bystanders notice) · the cast bar · forcing a character to act |
| Sheets | Description vs appearance · state · variables (types, visibility, who may change them) · thoughts and tags |
| Modes | Advanced mode · the POV filter · prompt viewer |
| Story setup | Scenario variables and templates · the player character · premise, tone, verbosity |
| Settings | Providers (DeepSeek, OpenRouter) · tiers and roles · free-model request limits · cache stats |

Rules:

- **Context links:** small **?** icons next to features (input box, Advanced toggle, scenario editor, tier rows)
  open the panel at the matching entry.
- **One source:** all entries live in one file, `client/dist/help.json` (`{ id, group, title, body, example }`),
  so text is edited in one place and the panel needs no code changes for new entries.
- **Definition of done:** a user-facing feature isn't finished until it has a help entry (CLAUDE.md conventions).
- **First run:** a dismissible one-line hint on the first story ("New here? Tap ? for how to play") remembered in
  browser storage.

## 12. Data model summary

Sheets, variables and thoughts are in doc 11 §7. Threads reuse the existing session tables:

- `agent_sessions` — role `narrator` | `character` (plus helper roles). For characters, `npc_object_id` = the
  character. New column `tier_id` (nullable override).
- `agent_messages` — **read back for the first time** (migration 008). New columns: `kind` (`log` | `pending` |
  `delivered` | `recap` | `recap_old`) and `compacted` (0/1); the existing `turn_id` ties a row to its round. The
  stored `content` is the exact string sent or received.
- `turns.meta` — declarations, round block, per-call timings, cache usage (later: referee rulings with numbers).
- `stories.settings` — `engine`; a `minds` block: `maxCharactersPerRound`, `briefMaxWords`, `characterLogTokens`,
  `narratorLogTokens`, `descriptionMaxWords`, `thoughtRecallTokens`, `pinnedTokens`, `maxActiveThoughts`,
  `narratorSeesThoughts`, `playerSpeechHeardImmediately`, `narratorNotes` (the narrator's secret setup notes).

**Snapshots/rewind.** The payload gains character sheets, variable values, the variable change log watermark,
thoughts (status included), and the `compacted`/`kind` flags of messages (the rowid watermark alone can't undo a
compaction's flag updates). Old snapshots without these fields restore as today.

## 13. Build order

Each milestone is committed on its own and keeps the existing engines working.

| # | Milestone | Done when |
|---|---|---|
| M1 ✅ | **Providers and tiers** (doc 12, built): multiple named connections with DeepSeek + OpenRouter presets, tiers (3 default + custom), role → tier mapping, settings migration, DeepSeek/OpenRouter specifics (thinking/reasoning switches, JSON modes, sticky sessions), cache and request-count capture. | Settings migration test proves old role bindings map losslessly. Driver tests cover DeepSeek and OpenRouter usage fields, reasoning off, whitespace-only JSON. |
| M1b | *(low priority, any time later)* **Claude via the official SDK** (doc 12 §5.1). | Request body has no temperature or prefill; cache markers present. |
| M2 ✅ | **Sheets data layer** (built) (doc 11): engine setting, sheets, variable definitions/values/change log, thoughts, snapshot coverage. | Store tests; rewind restores sheets, variables and thoughts; rule validation tests (who may change what). |
| M3 ✅ | **Thread builders** (built): system/recap/log/round-message assembly, deterministic rendering, recall selection, preview = real. | **Prefix test:** for two consecutive rounds, the earlier request is a byte-exact prefix of the later one. Preview test. |
| M4 ✅ | **Normal round** (built): parse input, gate, character calls, narrator + block, validation, distributor fallback, commit, distribution. | Replay-driver pipeline tests: briefs land in the right threads only; a hidden variable never appears in its holder's prompt; a failed character call degrades gracefully; a broken block falls back. |
| M5 ✅ | **Dialogue mode** (manual) + wrap-up (built). | Tests: exchanges call only the partner; `act` ends the dialogue into a round; bystanders get briefs at wrap-up. |
| M6 ✅ | **Compaction** for character and narrator threads (built). | Tests: threshold triggers; recap replaces folded messages; rewind undoes it. |
| M7 ✅ | **UI** (built): scenario editor, sheets, input preview, dialogue view, advanced mode, POV selector, prompt viewer, **help panel** with an entry for every feature above. | Manual smoke on desktop and phone width; http tests for every new endpoint; every feature has a help entry. |
| M8 ✅ | **Retire the old engines** (built; the owner chose "retire, delete later"): new stories use Minds only (the API forces it); a Minds story can't switch back; classic and NPC story mode keep running the stories that use them, marked *legacy*, with their own options only for those stories; a legacy story can switch to Minds (the transcript stays, the minds start fresh). Docs updated. **The dice/adjudication code stays.** | A new story is Minds; a Minds story refuses a legacy engine (400); legacy stories still play. |
| M9 | **Delete the legacy engines** once the owner has played Minds enough: the classic pipeline, NPC story mode, scribes, memory maintenance, the overseer and context planner. **Keep the dice/adjudication code.** `v1-backup` keeps everything. | Owner's go-ahead; the suite and typecheck stay green. |

## 14. TODO (explicitly later)

- **Branching:** ↻ regenerates a reply (an earlier one takes the later turns with it); keeping the replaced attempts
  as alternatives to switch between (per turn, with their snapshots) is later.
- A version check: the page notices the server was updated and offers to reload (an open tab keeps running the
  old scripts after an update).
- Converting a legacy story to Minds properly (characters → sheets, memory facts → descriptions and thoughts, the
  transcript → a narrator recap); today a switch keeps the transcript and the minds start fresh.
- The character interviewer for Minds: draft the player's sheet in ≤ 3 questions (doc 11 §2.1); today the player
  fills a form or the narrator decides.

- A sheet view on the cast chips (M7); today the chips show appearance and visible values as a tooltip.
- Show a character its tag vocabulary when it changes (doc 11 §5.3); today only the narrator gets the tags in use.
- Tell a character when the user revokes one of its thoughts in advanced mode (it stays visible in older log messages).
- Referee + dice for special cases (§9.4), reusing `resolution.ts` and the adjudicator.
- Automatic dialogue mode (detect, then suggest, then switch).
- The compactor proposing thought merges for a character at `maxActiveThoughts` (doc 11 §5); today it only
  proposes up to three pins.
- Whispering: private `say` with `to` for characters; a whisper selector for the player.
- Relation variables (a value per holder × target, e.g. Marta's trust in the player).
- Derived variables and triggers (e.g. "health reaches 0 → the narrator is told the character is down").
- Off-screen life for absent characters ("what were you doing meanwhile?").
- Saving and loading scenarios (variable sets, cast) as templates.
- Sending full sheets to the narrator only on change (token optimization, §8.2).
- Migrating NPC Story Mode stories (personality → description, notes → thoughts).

## 15. Open questions

None right now. Settled after review:

- the input syntax, with a help panel;
- characters hear the player's words in the same round; the narrator is blind to thoughts by default;
- the backup: branch `v1-backup`; the old engines leave `main` later;
- dice: kept in the code, out of the v1 round, back later for special cases;
- Claude moves to the official SDK at low priority.
