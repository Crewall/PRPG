# 06 — Orchestration: The Turn Loop

The `TurnPipeline` is the heart of the engine: it takes one player input and
coordinates every agent to produce the next piece of story. One turn at a time
per story (mutex); everything below happens inside that lock except the final
async scribe stage.

## Sequence

```
Player ──input──▶ ws.ts ──▶ TurnPipeline.run(storyId, input)

 0. preflight        validate story state, create Turn(status=streaming)
 1. (opt) rule gate  overseer pre-checks player input          [if rules.checkPlayerInput]
 2. context build    assemble storyteller context
 3. storyteller #1   stream narration + parse directives
 4. npc consults     for each consult_npc directive (parallel): build NPC ctx → invokeJson
 5. storyteller #2   re-invoke with NPC replies → final narration   [only if step 4 ran]
 6. (opt) overseer   verdict on final narration; hard violation → regenerate (≤2×)
 7. emit             advance the hidden in-game clock (advance_time directive, else
                     ~5 min default), persist Turn(complete, meta.clockMin), stream/flush
 8. scene effects    apply scene_break / npc_enter / npc_exit directives
 9. post-turn async  enqueue scribe_memory + scribe_story jobs → workers run them
```

An empty (0-token) storyteller reply is never accepted as a finished turn: the
agent layer retries it up to 2 times and then fails the turn (status `error`)
so the player can resend, instead of silently completing with nothing.

Latency profile: common case (no consults, overseer off) = **one** streamed LLM
call. Worst case = storyteller + parallel NPC batch + storyteller + overseer +
regenerations, each stage visible in the UI as a status line ("Marta is
thinking…") so slow turns feel alive rather than hung.

## Pipeline code skeleton

```ts
class TurnPipeline {
  async run(storyId: string, playerInput: string, out: TurnEmitter): Promise<Turn> {
    return this.locks.withStory(storyId, async () => {
      const story = this.stories.getStory(storyId);
      const turn  = this.stories.appendTurn({ storyId, playerInput, status: 'streaming' });

      if (story.settings.rules.checkPlayerInput) {
        const gate = await this.overseer.checkInput(story, playerInput);
        if (gate.verdict === 'violation' && gate.hard) {
          return this.reject(turn, gate, out);       // polite refusal, turn status=rejected
        }
      }

      let ctx = await this.contexts.forStoryteller(story, turn);
      let draft = await this.storyteller.narrate(ctx, out.deltaIfNoOverseer);
      let { narration, directives } = parseDirectives(draft);

      const consults = directives.filter(d => d.type === 'consult_npc');
      if (consults.length) {
        out.status('consulting NPCs…');
        const replies = await Promise.all(consults.map(c => this.consultNpc(story, turn, c)));
        ctx = this.contexts.withNpcReplies(ctx, draft, replies);
        draft = await this.storyteller.narrate(ctx, out.deltaIfNoOverseer);
        ({ narration, directives } = parseDirectives(draft));
      }

      if (story.settings.rules.enabled) {
        narration = await this.overseerLoop(story, turn, ctx, narration, out); // ≤2 regens
      }

      this.stories.updateTurn(turn.id, { narration, status: 'complete' });
      out.final(narration);

      this.applySceneDirectives(story, turn, directives);   // scene_break / enter / exit
      this.jobs.enqueue('scribe_story',  { turnId: turn.id });
      this.jobs.enqueue('scribe_memory', { turnId: turn.id });
      return turn;
    });
  }
}
```

## Context builders (the isolation boundary)

`contextBuilder.ts` is the only place agent contexts are assembled. Each builder
declares its inputs explicitly:

### `forStoryteller(story, turn)`
| # | block | source | budget |
|---|---|---|---|
| 1 | system prompt | `prompts/storyteller.md` + story settings (tone, genre) + hard rules | — |
| 2 | in-game clock | `stories.clock_min` ("It is Day 2, 14:30…", hidden from the player) | — |
| 3 | story digest | `story_summaries(scope=story)` | ≤1200 tk (config) |
| 4 | scene summary | `story_summaries(scope=scene, current)` | ≤500 tk (config) |
| 5 | scene state | location view (`perception`+`known`), present-NPC one-liners | ≤400 tk |
| 6 | retrieved memory | `searchFacts({kind:'storyteller'}, playerInput)` | ≤1500 tk (config) |
| 7 | recent turns | last K=6 turns verbatim (player+narration) | ~2000 tk |
| 8 | player input | raw | — |

### `forNpc(story, turn, consult)`
| # | block | source |
|---|---|---|
| 1 | persona system prompt (pinned in session) | template + `getObjectView(npc, {kind:'npc'})` with distortions + ignorance note |
| 2 | NPC-scoped recap | scene summary filtered to what the NPC perceived + presence-gap notes |
| 3 | the situation | `consult.situation` + player words/actions as perceivable |
| 4 | reply schema | `NpcReply` JSON schema |

### `forScribeMemory(turn)` / `forScribeStory(turn)` / `forOverseer(...)`
As specified in `04-agents.md` — mechanical assemblies from stores.

**Token budgeting:** `util/tokens.ts` provides `estimateTokens(s)` (chars/4
heuristic, later provider tokenizer); every block above is truncated
salience-first to its budget, and the builder asserts the total fits the model
profile's context size with headroom for output.

## NPC consult detail

```ts
async consultNpc(story, turn, c: ConsultDirective): Promise<NpcConsultResult> {
  const npcObj  = this.memory.resolveByName(story.id, c.npcName);   // alias-aware
  if (!npcObj) return { error: 'unknown-npc', name: c.npcName };    // storyteller improvises
  const session = this.agents.ensureSession(story.id, 'npc', npcObj.id);
  if (session.state === 'dormant') this.bridgeDormantNpc(session);  // "time passed…" note
  const ctx     = await this.contexts.forNpc(story, turn, c);
  const reply   = await new NpcAgent(session).invokeJson(ctx, NpcReply);
  this.applyReveals(reply, turn);   // revealsFactIds → knowledge_links(player)
  return { npc: npcObj, reply };
}
```

- Consults run in **parallel** (`Promise.all`) — independent sessions, no shared state.
- A failed consult (timeout/invalid JSON after repair) degrades gracefully: the
  storyteller is told "«Marta» is unavailable; voice her briefly yourself,
  consistent with: <her visible facts>". The turn never fails because an NPC did.

## Overseer loop detail

```ts
async overseerLoop(story, turn, ctx, narration, out): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const v = await this.overseer.review(story, turn, narration);
    turn.meta.verdicts.push(v);
    const hard = v.violations.filter(x => x.severity === 'hard');
    if (v.verdict === 'pass' || hard.length === 0 || attempt >= 2) {
      if (hard.length && attempt >= 2) out.warn('rule-violation-unresolved', hard);
      out.softNotices(v.violations.filter(x => x.severity === 'soft'));
      return narration;
    }
    out.status('revising to satisfy rules…');
    narration = await this.storyteller.revise(ctx, narration, hard);
  }
}
```

With the overseer enabled, streaming to the player is deferred until `pass`
(MVP). A later setting can stream optimistically and visually retract.

## Scene lifecycle

- `scene_break` directive → close current scene (`scribe_story` finalize job),
  open new scene with `carryNpcs` active, others → `dormant`.
- **Digest checkpoints:** the story digest normally folds on scene close; when a
  scene runs long, the scene-summary job also enqueues a mid-scene digest fold
  whenever the digest lags ≥8 turns behind play (`DIGEST_CHECKPOINT_EVERY`), so
  the whole-story summary never goes stale inside an unbroken scene.
- `npc_enter` → resolve name → ensure/activate session, add to
  `scenes.active_npc_ids`; unknown name → scribe_memory will typically create the
  object on this turn's pass, and activation is retried next turn.
- `npc_exit` → session → `dormant`, remove from active list.
- The player can also force scene/NPC changes from the UI (same code path,
  `source='user'`).

## Job workers (post-turn)

A single in-process worker loop drains `jobs` (concurrency 2, FIFO per story,
`scribe_story` before `scribe_memory` for the same turn is *not* required — they
are independent). Retries ×3 with backoff, then `failed` + UI badge. On process
start, `pending/running` jobs are re-queued — crash-safe.

## WebSocket protocol (client ⇄ orchestrator)

```
client → server
  { t:'turn.submit', storyId, input }
  { t:'turn.cancel', storyId }                    // AbortSignal into pipeline

server → client
  { t:'turn.accepted',  turnId }
  { t:'turn.status',    turnId, text }            // "consulting NPCs…"
  { t:'turn.delta',     turnId, text }            // streamed narration
  { t:'turn.final',     turnId, narration, notices[] }
  { t:'turn.rejected',  turnId, reason }          // input gate
  { t:'memory.updated', storyId, objectIds[] }
  { t:'summary.updated',storyId, scope }
  { t:'job.failed',     jobId, type }
  { t:'thread.activity',entry }                   // debug mode only: live thread_log tail
```
