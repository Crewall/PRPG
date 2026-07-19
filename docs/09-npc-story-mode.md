# 09 — NPC Story Mode (narrative minds)

**Status: planned — this document is the implementation spec.**

An alternative, per-story mode for NPC simulation that bypasses the structured
memory pipeline (fact extraction → knowledge links → scoped retrieval), which
in practice misfires: irrelevant facts get injected, crucial ones get missed,
and NPCs and the storyteller drift out of context. In this mode each NPC's
mind is a small *narrative document* instead of a fact database:

- every major NPC keeps a **personality** (stable) and **private notes**
  (brief factual bullet lines, evolving) — their "own story";
- **every round**, each present NPC receives a *personalized excerpt of the
  main story* (built mechanically from data the engine already tracks) plus
  the player's input, and answers with **what they say and what they intend
  to do**;
- those answers are handed to the **storyteller**, which weaves the round's
  narration in a single pass. The storyteller remains the sole authority on
  outcomes; NPC intents are attempts, not results.

The mode is a per-story settings switch (like `context.summaryDriven`).
Existing stories are unaffected; the default stays the structured-memory mode.

## Design decisions (settled with the user)

| Question | Decision |
|---|---|
| When do NPCs act? | **Every round, NPCs first** (user-confirmed). All present NPCs run in parallel, then one storyteller pass. This is *faster* than today's consult flow (2 sequential stages instead of up to 3) at the cost of N NPC calls per turn. |
| Who maintains an NPC's notes? | **The NPC itself, inside its round reply** (default; user had no preference). The same call that produces dialogue/intent also returns the rewritten notes. One LLM call per NPC per round, total. |
| Fate of the structured memory system in this mode? | **Off, roster only** (default). No `scribe_memory` jobs, no fact extraction, no retrieval blocks, no maintenance passes. `memory_objects` stays as the character/location roster — agent sessions (`npc_object_id`) and scenes (`active_npc_ids`) key on those ids. Personality + notes live in a new lightweight table. |
| How is the personalized excerpt built? | **Mechanical filter** (default): story digest + scene summary + last-K raw turns *while the NPC was present* + gap notes for absences. Zero extra LLM calls, fully deterministic. An LLM "what you learned while away" bridge on re-entry is future work. |

## What is reused unchanged

- `TurnPipeline` skeleton: lock, snapshot, streaming gate, directive parsing,
  clock, adjudicator weave loop, error handling.
- `scribe_story` (rolling scene summary + story digest + checkpoint folds) —
  this *is* the "main story" the excerpts are cut from. Unchanged.
- Scene lifecycle: `scene_break` / `npc_enter` / `npc_exit` directives,
  `scenes.active_npc_ids`, active/dormant NPC sessions.
- The jobs queue, thread log, settings UI plumbing, snapshot/rewind machinery.
- Adjudicator and overseer work exactly as before.

## What is switched off in this mode

- `scribe_memory` per-turn jobs (not enqueued), maintenance/cleanup passes,
  merge-suggestion generation.
- The retrieved-memory and focus-object blocks in the storyteller context, the
  `context_planner` pass, and `getObjectView`-based NPC personas.
- `consult_npc` directives: parsed but **ignored with a log line** (the NPCs
  already spoke this round; the storyteller prompt says so). `resolve_action`,
  `scene_break`, `npc_enter`, `npc_exit`, `advance_time` all remain active.
- `npc_dossier` jobs (replaced by `npc_seed`, below).

The memory browser still works for objects created before a mode switch; the
mode simply stops feeding it. (Manual player edits remain possible but unused.)

---

## 1. Data model

### Migration `005-npc-profiles.sql`

```sql
CREATE TABLE npc_profiles (
  object_id   TEXT PRIMARY KEY REFERENCES memory_objects(id) ON DELETE CASCADE,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  personality TEXT NOT NULL DEFAULT '',   -- stable: temperament, voice, manner, drives
  notes       TEXT NOT NULL DEFAULT '',   -- evolving private notes, brief factual bullets
  last_present_turn_idx INTEGER NOT NULL DEFAULT -1,  -- for gap notes
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_npc_profiles_story ON npc_profiles(story_id);
```

New store `src/db/stores/npcProfileStore.ts`:

```ts
get(objectId): NpcProfile | undefined
listForStory(storyId): NpcProfile[]
upsert(storyId, objectId, patch: { personality?; notes?; lastPresentTurnIdx? })
```

### Per-turn presence

Stamp `meta.presentNpcIds: string[]` on every completed turn (in **both**
modes — it is cheap, needs no migration, and improves the old mode's gap notes
too). Value: the scene's `activeNpcIds` at the time of storyteller pass 1.
Old turns without the field are treated as "presence unknown" and simply not
matched by the present-turn filter.

### Snapshots / rewind

`SnapshotPayload` gains `npcProfiles: Row[]` (all `npc_profiles` rows for the
story, captured and restored like `objects`/`facts`). Restore must tolerate
old snapshots without the field (leave profiles untouched). This makes rewind
correctly roll back notes written by the rewound turn.

---

## 2. Settings

In `src/domain.ts` `StorySettings`:

```ts
npcStories: z.object({
  enabled: z.boolean().default(false),
  /** Max tokens kept of each NPC's private notes (server-side truncation). */
  notesTokens: z.number().int().positive().default(300),
  /** How many recent present-turns each NPC sees verbatim. */
  presentTurns: z.number().int().positive().default(4),
  /** Cap on NPC calls per round (first-listed in the scene win). */
  maxNpcsPerRound: z.number().int().positive().default(4),
}).default({}),
```

Precedence rules, documented in the schema comment:
- `npcStories.enabled` governs the **NPC path and memory usage** only.
- The storyteller's history assembly still follows `context.summaryDriven`,
  but the planner (`context.plannerEnabled`) is **skipped** in this mode
  (it only plans memory retrieval, which is off).

---

## 3. Turn loop in NPC Story Mode

`TurnPipeline.runLocked` branches after preflight when
`story.settings.npcStories.enabled`:

```
0. preflight, appendTurn, snapshot.capture           (unchanged)
1. present = scene.activeNpcIds.slice(0, maxNpcsPerRound)
2. NPC round (parallel, Promise.all):
     for each npc: buildNpcRoundContext → NpcAgent.respondRound
     → { dialogue, intent, innerState, notes }
   a failed/timeout NPC degrades to an "unavailable" entry (like consult
   errors today) — the turn never fails because an NPC did
3. storyteller pass — SINGLE pass, streamed LIVE (the round replies are in
   the context from the start, so there is no draft-then-rewrite buffering)
   – context = normal storyteller context, minus memory blocks, plus the
     "characters act this round" block (see §5)
   – directive cascade loop stays for resolve_action (continuation weave,
     as in the live path today); consult_npc directives are ignored+logged
4. clock advance, updateTurn(complete), meta.presentNpcIds = present,
   appendMessage to storyteller session                (as today)
5. persist NPC state (post-emit, pre-scene-effects):
     for each successful reply: npcProfiles.upsert(notes: truncate(reply.notes,
       notesTokens) || previous, lastPresentTurnIdx: turn.index)
   append each reply JSON to that NPC's session transcript (debug parity
   with today's consults)
6. applySceneDirectives                                (unchanged)
7. post-turn jobs: enqueue scribe_story ONLY (no scribe_memory)
```

Implementation shape: extract the NPC round into
`src/orchestrator/npcRound.ts` (`runNpcRound(deps, story, turn, playerInput,
signal): NpcRoundOutcome[]`) rather than growing `runLocked`; the pipeline
branch then reads as: `const round = npcStories ? await runNpcRound(...) : []`.

Status lines: reuse the existing emitter — `out.status('the characters are
thinking…')` during step 2, `'the storyteller is writing…'` for step 3.

---

## 4. NPC round context (the personalized excerpt)

Built in `contextBuilder.ts` as a new `forNpcRound(story, npcObjectId, opts)`
(keep `forNpc` untouched for the old mode).

**System prompt** — new template `src/agents/prompts/npc-story.md`:

- You are **{{name}}**. First person, fully in character.
- `## Your personality` → `{{personality}}`
- `## Your private notes (your own memory — everything you know)` → `{{notes}}`
- Hard rules (adapted from `npc.md`): you know ONLY personality + notes +
  the recap below; react in character to unknown things; guard your secrets;
  staying silent / doing nothing is a valid response.
- Notes contract: *"Return your notes REWRITTEN to stay current: short
  factual bullet lines ('- ...'), each one thing you know, believe, feel or
  want. Update what changed this round, drop what stopped mattering. Never
  exceed ~{{notesBudget}} words. Notes are facts about your world, not prose
  or plans for the narrator."*
- Reply schema (see §6).

**Messages** (one user message, assembled mechanically):

1. *Recap* — `## The story as you know it`:
   - story digest, truncated to ~250 tk, framed "as you would plausibly
     know it" (same framing `forNpc` uses today);
   - current scene summary (~300 tk) **only if** the NPC has been present in
     this scene (its id appears in a `presentNpcIds` meta of any turn of the
     scene, or it is in `activeNpcIds` now);
   - gap note when `lastPresentTurnIdx < turn.index - 1`:
     `"You were elsewhere for the last N exchanges (since <formatGameClock>)."`
2. *Recent moments you witnessed* — the last `presentTurns` completed turns
   whose `meta.presentNpcIds` contains this NPC (player input + narration,
   each truncated ~150 tk). Turns without presence meta are skipped.
3. *This round* —
   `The player just said or did: <input>` +
   `React as {{name}}: what do you say aloud (if anything), and what do you
   do or intend to do? Then return your updated private notes. Reply as JSON.`

No LLM is involved in building any of this.

---

## 5. Storyteller context in this mode

`forStoryteller` gains an `extras.npcRound?: NpcRoundForWeave[]` input (same
pattern as `extras.plan`). Changes when `npcStories.enabled`:

- **Omit**: retrieved-memory block, focus-objects block, goals block,
  "present major characters — you may consult them" block.
- **Keep**: persona/tone/verbosity, premise, clock, player-character section
  (see §8), digest, scene summary, scene state (location view still comes
  from the roster; present-NPC one-liners now come from
  `npc_profiles.personality` first line instead of `getObjectView`).
- **Add** (when the round produced anything):

```
## The characters act this round
Each present character has already spoken/acted through their own mind.
Their words are theirs — quote or faithfully paraphrase them. Their intents
are ATTEMPTS, not outcomes: you decide what actually happens (or request
adjudication for uncertain, consequential attempts). Omit characters who do
nothing notable. Do not use consult_npc — they have already answered.
- Marta says: "Not here. Back room." — intends: slip the ledger under the counter
- Old Tom says nothing — intends: keep drinking and watch the stranger
- Guard Held is unavailable (timeout); voice him briefly yourself, consistent with his known character.
```

`innerState` entries are appended per character as `(inwardly: …)` — the
storyteller may use them for subtext, never quote them.

Message history: unchanged from the current mode logic (last-K raw turns, or
summary-driven single exchange — whichever the story's `context` settings say).

---

## 6. NPC round reply schema

In `src/agents/npcAgent.ts`, alongside the existing `NpcReply`:

```ts
export const NpcRoundReply = z.object({
  dialogue: z.string(),                    // may be empty (silence)
  intent: z.string().optional(),           // what you do or intend to do this round
  innerState: z.string().optional(),       // private; storyteller subtext only
  notes: z.string(),                       // full REWRITTEN private notes
});
export type NpcRoundReply = z.infer<typeof NpcRoundReply>;
```

`NpcAgent.respondRound(ctx, opts)` = `invokeJson` with this schema (existing
empty-reply retry + one repair round apply automatically). Server-side
post-processing (never trusted to the LLM):
- `notes` truncated to `notesTokens` (via `truncateToTokens`); empty/blank
  notes → keep the previous notes unchanged;
- `dialogue`/`intent` length-clamped defensively (~200 tk each).

`revealsFactIds` does not exist here — there are no facts.

---

## 7. NPC creation & seeding (`npc_seed` job)

In this mode `npc_enter` / `promoteNpc` must work without the memory scribe:

- `npcEnter` with an **unknown name** (today a no-op): when
  `npcStories.enabled`, create a bare `character` object (name only) in the
  roster, add to the scene, ensure the session, then enqueue `npc_seed`.
- `promoteNpc`: when `npcStories.enabled`, enqueue `npc_seed` instead of
  `npc_dossier` whenever the profile is missing or has empty personality.

`npc_seed` handler (`handlers.ts`, cheap model — reuse the `npc` role profile
or `scribe_story` as fallback):

1. **Conversion path (no LLM):** if the object already has memory facts
   (story switched modes mid-way), render them mechanically —
   `personality` ← facts in categories personality/voice/appearance,
   `notes` ← one bullet per remaining non-superseded fact the NPC knows
   about itself + `npcKnowledge` world facts. Deterministic, lossless enough.
2. **Generation path:** otherwise one `invokeJson` call — inputs: name, story
   digest, current scene summary, the narration of the turn that introduced
   them; output `{ personality: string, notes: string }`. New prompt
   `src/agents/prompts/npc-story-seed.md`: *"Invent a coherent, playable
   character consistent with everything given; personality = 3–6 lines of
   temperament/voice/manner/drives; notes = 5–12 first-person factual
   bullets of what they know, want and feel at this moment. Do not
   contradict anything established."*

Until the seed job lands, a profile-less NPC still plays: `forNpcRound`
substitutes `personality: '(improvise a plausible personality from the story
so far; stay consistent from now on)'` and empty notes. The next round after
seeding, the real profile takes over.

---

## 8. Player character & intake

Unchanged. The intake interview writes the PC as memory facts at story
creation (a one-shot, not the misfiring per-turn extraction), and the
storyteller's PC section keeps using `getObjectView(playerObjectId,
{kind:'storyteller'})`. This works in both modes; nothing to build.

---

## 9. API & UI

**HTTP (`src/api/http.ts`):**

```
GET  /api/stories/:id/npc-profiles          → [{ objectId, name, personality, notes, lastPresentTurnIdx }]
PUT  /api/npc-profiles/:objectId            { personality?, notes? }   → updated row
```
Manual edits are journaled to `thread_log` with `agent_role='user'` (same
convention as manual memory edits).

**Client (`client/dist/app.js` — vanilla, no build step):**

1. Story options: a toggle **"NPC minds: narrative stories"** wired exactly
   like the existing `summaryDriven` toggle
   (`patchSettings({ npcStories: { enabled: on } })`), with a one-line
   explanation that this replaces the structured memory system for NPCs.
2. A minimal **"NPC minds"** panel (visible when the mode is on): list of
   NPCs with editable `personality` and `notes` textareas + save. This is
   the player's window into (and repair tool for) each NPC's head, replacing
   the memory browser's role for NPCs in this mode.
3. Debug thread view needs no changes — round replies flow through
   `thread_log` like consults do today.

**WS:** emit `{ t: 'npc.profile.updated', storyId, objectId }` after step 5
of the turn loop and after manual PUTs, so an open panel refreshes live.

---

## 10. Implementation checklist (file by file)

| File | Change |
|---|---|
| `src/db/migrations/005-npc-profiles.sql` | new table (§1) |
| `src/db/stores/npcProfileStore.ts` | new store (§1) |
| `src/db/stores/snapshotStore.ts` | capture/restore `npc_profiles`; tolerate old payloads |
| `src/domain.ts` | `npcStories` settings block (§2) |
| `src/agents/prompts/npc-story.md` | new NPC round prompt (§4) |
| `src/agents/prompts/npc-story-seed.md` | new seed prompt (§7) |
| `src/agents/prompts.ts` | register the two templates |
| `src/agents/npcAgent.ts` | `NpcRoundReply` + `respondRound` (§6) |
| `src/orchestrator/npcRound.ts` | new: parallel round runner (§3) |
| `src/orchestrator/turnPipeline.ts` | mode branch; presence stamping (both modes); notes persistence; skip `scribe_memory` enqueue; ignore `consult_npc` in-mode |
| `src/orchestrator/contextBuilder.ts` | `forNpcRound`; storyteller omissions + round block (§5) |
| `src/orchestrator/npc.ts` | in-mode: create-on-unknown `npcEnter`, `npc_seed` instead of `npc_dossier` |
| `src/orchestrator/handlers.ts` | `npc_seed` handler (conversion + generation paths) |
| `src/db/stores/jobStore.ts` | add `npc_seed` to `JobType` |
| `src/api/http.ts` | profile endpoints (§9) |
| `src/api/ws.ts` / `src/util/events.ts` | `npc.profile.updated` event |
| `src/app.ts` | wire store + handler + routes |
| `client/dist/app.js` | toggle + NPC minds panel (§9) |
| `docs/09-npc-story-mode.md`, `README.md` | this spec; status row |

## 11. Build order (milestones with acceptance criteria)

1. **Data + settings.** Migration, store, snapshot inclusion, settings block.
   ✔ `npm test` green; settings roundtrip test for `npcStories`; rewind test
   proves notes are restored.
2. **NPC round.** Prompts, `NpcRoundReply`, `respondRound`, `forNpcRound`,
   `npcRound.ts`, presence stamping. ✔ unit tests with the fake LLM driver:
   context contains personality/notes/gap-note/present-turns-only; parallel
   failure degrades to "unavailable"; notes truncation + empty-notes-keep-old.
3. **Pipeline integration.** Mode branch, storyteller block + omissions,
   notes persistence, `consult_npc` ignored, `scribe_memory` not enqueued.
   ✔ pipeline test (pattern of `test/pipeline.test.ts`): a scripted turn with
   2 NPCs shows round replies in the storyteller prompt, single live
   storyteller pass, adjudication continuation still works, meta stamped.
4. **Seeding + mode switch.** `npc_seed` both paths, `npcEnter`
   create-on-unknown, `promoteNpc` routing. ✔ tests: facts→profile conversion
   is faithful; unknown `npc_enter` creates roster object + queues seed;
   profile-less NPC plays with the improvise fallback.
5. **API + UI.** Endpoints, events, toggle, NPC minds panel. ✔ http test for
   GET/PUT + journaling; manual smoke via `npm start`.
6. **Docs + polish.** README status row, doc cross-references in 04/05/06.

Each milestone is independently committable and keeps the default mode fully
working — the switch stays off until milestone 5 exposes it.

## 12. Risks & mitigations

- **Notes drift / self-serving memory.** Strict rewrite contract in the
  prompt, hard server-side token cap, keep-old-on-empty, and the notes are
  player-visible and editable in the NPC minds panel.
- **Cost: N NPC calls every round.** `maxNpcsPerRound` cap; the `npc` role
  already supports binding a cheap/fast model per story; calls run parallel
  so latency stays ~2 stages.
- **NPC replies contradicting the storyteller's outcome.** The contract is
  explicit: dialogue is quoted, intents are attempts; the adjudicator still
  arbitrates uncertain attempts. The NPC learns what *actually* happened
  from the next round's excerpt (final narration), not from its own intent.
- **A silent NPC every round wastes a call.** Accepted for v1 (user chose
  every-round cadence); the prompt legitimizes silence and the storyteller
  omits it. Future: a cheap relevance gate or "skip if not addressed and
  nothing changed" heuristic.
- **Long-absent NPC re-entry quality.** Gap note + digest is v1; an LLM
  "what you learned while away" bridge is listed as future work.
- **Old stories switching modes.** Handled by the conversion path of
  `npc_seed`; switching back is lossless for the old system (its data was
  never deleted) though facts extracted during narrative-mode play are
  simply absent.

## 13. Future work (explicitly out of scope for v1)

- LLM re-entry bridge for long-dormant NPCs.
- Off-screen NPC life: a periodic cheap pass advancing absent NPCs' notes
  ("what were you doing meanwhile?").
- Relevance gating to skip obviously-idle NPCs.
- Per-NPC model/temperature overrides in the NPC minds panel.
- Location "minds" (same narrative-document trick for places/factions).
