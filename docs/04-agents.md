# 04 — Agent Threads

Every agent is an instance of a common base class plus a role definition. All
agents are invisible to the player except the storyteller's final narration;
the debug setting (`settings.debug.showThreads`) exposes all of them in the UI.

## Common base

```ts
abstract class Agent {
  constructor(
    readonly session: AgentSession,
    readonly llm: LlmRegistry,
    readonly log: ThreadLog,
  ) {}

  /** Free-text call with streaming (storyteller, NPC dialogue). */
  protected invoke(ctx: BuiltContext, onDelta?: (s: string) => void): Promise<string>

  /** Schema-enforced JSON call with 1 auto-repair retry (scribes, overseer, NPC replies). */
  protected invokeJson<T>(ctx: BuiltContext, schema: ZodSchema<T>): Promise<T>
}
```

- `BuiltContext` = system prompt + message list, produced by the orchestrator's
  `contextBuilder` for this specific agent and turn (agents never build their own
  context from global state — this is the isolation boundary).
- Both invoke paths write full request/response into `thread_log`.
- `invokeJson` embeds the JSON schema in the prompt, parses with Zod, and on
  failure sends one repair message ("Your reply failed validation: <errors>.
  Reply with only corrected JSON."). Second failure → job failure (scribes) or
  fallback behavior (documented per agent below).

Prompts live in `src/agents/prompts/*.md` as versioned templates with
`{{placeholders}}` — never inline strings — so they can be diffed, tested, and
shown in the debug UI.

---

## 1. Storyteller

The single player-facing agent: narrates the world, adjudicates actions,
voices minor characters directly, and delegates to NPC agents for major
characters. Uses the strongest configured model.

**Input (context built per turn):**
1. System prompt: narrator persona + tone/genre settings + *output contract*
   (below) + hard rules (severity=hard rules inlined so most violations never
   happen; the overseer is the backstop).
2. Story digest: rolling story summary + current scene summary (from `story_summaries`).
3. Scene state: location view, present NPC list with one-line summaries.
4. Retrieved memory: `getObjectView(..., {kind:'storyteller'})` for entities
   detected in the player input + top FTS hits (storyteller sees *everything*,
   including `hidden` facts — it needs to know the assassin's secret to
   foreshadow it).
5. Recent raw turns (last K, default 6) verbatim.
6. The player input.
7. If NPC consult results exist (second pass): the NPC replies as structured data.

**Output contract** — narration text plus an optional fenced directive block the
orchestrator strips before display:

````
<narration text — what the player reads>

```directives
{ "directives": [
  { "type": "consult_npc", "npcName": "Marta", "situation": "player asked about the stolen ledger", "expects": "dialogue" },
  { "type": "scene_break", "title": "Cellar of the Flagon", "carryNpcs": ["Marta"] },
  { "type": "npc_enter", "name": "Guard Captain Held" },
  { "type": "npc_exit",  "name": "Old Tom" },
  { "type": "roll", "kind": "persuasion", "difficulty": "hard" }   // optional dice/uncertainty hook, post-MVP
] }
```
````

**Directive semantics** (full loop in `06-orchestration.md`):
- `consult_npc` — orchestrator invokes that NPC agent and re-calls the storyteller
  with the reply; the storyteller then weaves the dialogue into final narration.
  Max 1 consult round per turn by default (latency), configurable.
- `scene_break` / `npc_enter` / `npc_exit` — scene lifecycle; orchestrator updates
  `scenes`, activates/dormants NPC sessions.
- Unknown/invalid directives are logged and ignored (fail-open to plain narration).

**Session policy:** persistent session per story, but its message window is
synthetic — rebuilt each turn from digest + recent turns rather than an
ever-growing transcript. That is the whole point of scribe_story.

---

## 2. NPC agents (one session per active major NPC)

Instantiated when an NPC becomes "major" (storyteller directive or player
promotion in the UI). Minor background characters stay storyteller-voiced.

**Persona construction (at activation):**
- System prompt from template + the NPC's `ObjectView` with scope
  `{kind:'npc', npcObjectId}`:
  - identity: name, `personality`, `appearance`, `history` facts at levels the
    NPC would know about itself (an amnesiac NPC genuinely lacks its own `hidden` facts),
  - knowledge: every fact linked to this NPC via `knowledge_links`, **with
    distortions substituted** — the NPC believes the distorted version,
  - explicit *ignorance note*: "You do NOT know anything not listed above. If
    asked, react as your character would to unknown information."
- Speech style guidance (from `personality`/`voice` facts).

**Input per consult:**
1. Persona system prompt (pinned).
2. NPC-scoped scene digest: what this NPC has perceived (subset of scene events —
   the orchestrator tracks presence, so an NPC who was absent for turns 12–15
   gets a gap note: "time passed; you were elsewhere").
3. The consult `situation` from the storyteller + the player's words/actions as
   perceivable by the NPC.

**Output (JSON via `invokeJson`):**
```ts
const NpcReply = z.object({
  dialogue: z.string(),                 // what the NPC says (may be empty)
  action: z.string().optional(),        // physical behavior, tone
  innerState: z.string().optional(),    // hidden: feelings/intent — for storyteller & memory only
  revealsFactIds: z.array(z.string()).optional(), // facts the NPC just disclosed → new knowledge_links for player
});
```
`dialogue/action` go to the storyteller for weaving; `innerState` is stored
(thread log + optionally memory) but never shown to the player.

**Isolation guarantees (the "no persona mixing" requirement):**
- Separate session per NPC — histories never share a context window.
- Context is built exclusively through `getObjectView` with the NPC's scope.
- Other NPCs appear in an NPC's context only as *perceived externals*
  (name + visible facts), never with their personas or knowledge.

**Lifecycle:** `active` (in scene) → `dormant` on exit (session kept; on
re-entry it gets a "time has passed, here's what changed that you'd know"
bridge note) → `closed` on death/removal.

---

## 3. scribe_memory — memory extraction & expansion

Cheap/fast model. Runs asynchronously after every completed turn (via `jobs`).

**Input:**
1. System prompt: extraction instructions + the category/detail-level taxonomy +
   JSON schema.
2. The finished turn: player input + final narration (+ NPC `innerState`s).
3. Current memory snapshot *for entities mentioned*: object list
   (id/name/aliases/type) + their existing facts (so it updates instead of
   duplicating).

**Output (JSON):**
```ts
const MemoryDelta = z.object({
  newObjects: z.array(z.object({
    tempId: z.string(), type: ObjectType, name: z.string(),
    aliases: z.array(z.string()), summary: z.string(),
  })),
  newFacts: z.array(z.object({
    objectId: z.string(),               // real id or tempId
    category: z.string(), subcategory: z.string().optional(),
    detailLevel: z.enum(['visible','known','secret','hidden']),
    content: z.string(), confidence: z.number(),
    knownBy: z.array(z.string()),       // 'player' | npc object ids present & perceiving
    supersedesFactId: z.string().optional(),
  })),
  salienceUpdates: z.array(z.object({ objectId: z.string(), salience: z.number() })),
  mergeSuggestions: z.array(z.object({ keepId: z.string(), mergeId: z.string(), reason: z.string() })),
});
```

**Post-processing by the orchestrator (not trusted to the LLM):**
- resolve tempIds, alias-match against existing objects before creating new ones
  (exact/normalized match auto-merges; fuzzy match → `mergeSuggestions` UI queue),
- write facts + knowledge links in one transaction,
- clamp: max N new facts per turn (default 20) to bound growth.

**"Expansion":** every M turns (default 10) a maintenance job re-reads an
object's fact list and asks the scribe to consolidate near-duplicates
(supersede) and improve `summary`. This keeps memory clean as it grows.

---

## 4. scribe_story — history compression

Cheap/fast model. Two triggers:

**(a) Rolling scene summary** — after each turn (async): update the current
scene's summary to cover through the latest turn.
- Input: previous scene summary + the new turn's text.
- Output: `{ sceneSummary: string }` (target ≤ 300 tokens), incremental — it
  rewrites the summary, it does not append.

**(b) Scene close / story digest** — on `scene_break`: finalize the closed
scene's summary, then fold it into the story-level digest.
- Input: current story digest + finalized scene summary.
- Output: `{ storyDigest: string }` (target ≤ 800 tokens, config), structured as:
  premise → major arcs/threads still open → recent events → current situation.

**Guarantee:** the storyteller's prompt size is bounded:
`digest + scene summary + K raw turns + retrieved memory`, independent of total
story length. Anything compressed away remains reachable through memory
retrieval (that's the division of labor between the two scribes).

**Failure mode:** if a summary job fails, the previous summary is used with a
staleness marker and the job retries; the story never blocks.

---

## 5. Rule overseer (optional)

Cheap/fast model, enabled per story. Validates the candidate narration **before**
it is finalized (hard rules) — the only agent on the critical path besides the
storyteller.

**Input:**
1. System prompt: judge instructions + the enabled rules (verbatim, numbered).
2. Story/scene digest (for context-dependent rules like "no anachronisms").
3. The player input + candidate narration (+ NPC replies used).

**Output (JSON):**
```ts
const OverseerVerdict = z.object({
  verdict: z.enum(['pass', 'violation']),
  violations: z.array(z.object({
    ruleId: z.string(),
    severity: z.enum(['hard','soft']),
    explanation: z.string(),
    suggestion: z.string(),             // how to fix while keeping intent
  })),
});
```

**Enforcement loop (in orchestrator):**
- `pass` or soft-only → emit narration; soft violations become UI annotations
  (visible in debug, optionally as subtle player-facing notices).
- hard violation → re-invoke the storyteller with the violation feedback appended
  ("Revise your narration: <explanations + suggestions>. Keep the story intent.").
  Max 2 regeneration rounds; if still violating, emit with a warning banner and
  log — never deadlock the game.
- The overseer can also flag **player** input pre-turn (e.g. table rules like
  "no controlling NPCs"); this pre-check is a config option (`rules.checkPlayerInput`)
  and returns a polite refusal prompt to the player instead of running the turn.

**Latency note:** overseer check runs on the *complete* candidate narration, so
with overseer ON the player sees the stream only after validation (or: stream
optimistically and retract on violation — MVP takes the simpler "validate then
show" path; make it a setting later).

---

## Visibility matrix (default)

| Thread | Player sees | Debug UI shows |
|---|---|---|
| Storyteller narration | ✔ final text | + raw output incl. directives, full prompt |
| Storyteller directives | ✖ | ✔ |
| NPC agents | only woven dialogue | full persona, consults, innerState |
| scribe_memory | ✖ (memory browser shows *results*) | full deltas + prompts |
| scribe_story | ✖ | summaries + prompts |
| Overseer | soft-violation notices (optional) | verdicts + prompts |


"v1-3a17ac9d9dafe9d7294558726ba3daaa84b6b01eae51519205b595a832e6ed72"