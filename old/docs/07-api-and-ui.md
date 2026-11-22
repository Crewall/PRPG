# 07 — API Surface & Web UI

## REST API (Fastify, JSON, Zod-validated)

All routes under `/api`. No auth in MVP (localhost binding); a shared-token
middleware slot exists from day one (`Authorization: Bearer <token>` checked if
`config.server.token` is set) for anyone exposing to LAN.

### Stories
| method & path | purpose | body / returns |
|---|---|---|
| `POST /api/stories` | create story | `{ title, seed?, settings? }` → `Story`; `seed` = free-text premise the storyteller opens with |
| `GET /api/stories` | list | `Story[]` |
| `GET /api/stories/:id` | fetch | `Story` + current scene |
| `PATCH /api/stories/:id` | update settings/title | partial `StorySettings` |
| `DELETE /api/stories/:id` | archive/delete | `?hard=true` for full delete |
| `GET /api/stories/:id/turns?from&limit` | history page | `Turn[]` (player-visible fields) |
| `POST /api/stories/:id/export` | export | full JSON dump (turns+memory+summaries) — backup/share |
| `POST /api/stories/import` | import | the same dump |

### Memory
| method & path | purpose |
|---|---|
| `GET /api/stories/:id/memory/objects?type&query&scope` | list objects (scope defaults to `player`; `storyteller` requires debug mode) |
| `GET /api/memory/objects/:oid?scope&categories` | one `ObjectView` |
| `POST /api/stories/:id/memory/objects` | manual create |
| `PATCH /api/memory/objects/:oid` | edit name/aliases/summary/status/salience |
| `POST /api/memory/objects/:oid/facts` | manual fact add |
| `PATCH /api/memory/facts/:fid` | edit content/category/detail level; supersede |
| `POST /api/memory/facts/:fid/knowledge` | grant/revoke knower links, set distortion |
| `POST /api/memory/objects/:oid/merge` | fold a duplicate object into `:oid` (`{ mergeId }`) — lossless entity merge (facts, knowledge links, scene rosters, sessions, aliases) |
| `POST /api/stories/:id/memory/maintenance` | run the memory cleanup now (entity unification, fact consolidation, salience decay) — also runs automatically every 10 turns |
| `GET /api/stories/:id/memory/suggestions` | pending merge/contradiction queue |
| `POST /api/memory/suggestions/:sid` | accept/reject a suggestion (accepting a merge uses the lossless entity merge) |

### Rules & agents
| method & path | purpose |
|---|---|
| `GET/POST/PATCH/DELETE /api/stories/:id/rules` | rule CRUD (text, scope, severity, enabled) |
| `GET /api/stories/:id/agents` | list sessions (role, state, model profile, message count) |
| `PATCH /api/agents/:sessionId` | change model profile; reset session |
| `POST /api/stories/:id/npcs/:oid/promote` | make character a major NPC (create session) |
| `POST /api/stories/:id/npcs/:oid/demote` | back to storyteller-voiced |

### Debug & system
| method & path | purpose |
|---|---|
| `GET /api/stories/:id/threadlog?turnId&role&limit` | audit log page (debug) |
| `GET /api/stories/:id/summaries` | current digest + scene summaries |
| `POST /api/stories/:id/jobs/:jobId/retry` | retry failed scribe job |
| `GET /api/settings` / `PATCH /api/settings` | runtime settings incl. `debug.showThreads` |
| `GET /api/system/health` | provider connectivity check, db size, version |
| `GET /api/system/models` | configured model profiles (for pickers) |

WebSocket endpoint: `GET /ws` — protocol in `06-orchestration.md`.

## Web UI (Svelte SPA)

Design target: phone-first (it will literally run on the phone), dark theme
default, works down to ~360 px wide; desktop gets side-by-side panels.

### Views

**1. Story list (home)** — story cards (title, last played, turn count), new-story
wizard: title → premise seed → genre/tone presets → model profile per role
(defaults from config) → toggles (overseer on/off).

**2. Play view (main screen)**
- Chat transcript: narration bubbles (markdown), player inputs, streaming cursor,
  status line during multi-stage turns ("Marta is thinking…"), soft-rule notices
  as subtle chips.
- Input bar: text + send/cancel; slash-commands for power users
  (`/look <name>` → perception view popup, `/scene` info, `/retry` regenerate last turn).
- Collapsible **scene header**: location name, present NPC avatars/chips —
  tapping an NPC chip opens their player-scope memory card.
- Drawer (mobile) / right panel (desktop) with tabs:
  - **Memory** — browsable object list grouped by type; object page shows
    summary + facts grouped by category (with their in-game time stamps,
    `d2 14:30`), filtered to current scope; edit controls; a "merge another
    object into this" picker for duplicate entities; suggestion inbox
    (merges/contradictions); a "clean up" action that runs memory maintenance
    on demand.
  - **Rules** — rule list with enable toggles, severity, add/edit.
  - **Threads** *(only when `debug.showThreads`)* — live-tailing list of every
    agent call: role badge, tokens, duration; tap → full prompt/response viewer
    with JSON pretty-print and copy button. Filter by role/turn.
  - **Settings** — per-story: model profiles per role, context budgets (story
    digest / scene summary / retrieved memory tokens, K recent turns — under
    Story options → "Context budgets"), overseer toggles, debug visibility,
    export/import. The debug Summaries tab also shows the hidden in-game clock.

**3. Global settings** — providers/API keys status (masked, edit via config file
note), default profiles, log retention, LAN exposure warning.

### Client architecture

```
client/src/
├─ lib/api.ts          # typed REST client (types imported from shared/)
├─ lib/ws.ts           # WS store: connection, event → Svelte stores dispatch
├─ stores/             # story, transcript, memory, threads, settings stores
├─ routes/             # Home, Play, StorySettings, GlobalSettings (hash router — no SSR)
└─ components/         # ChatLog, TurnInput, SceneHeader, MemoryBrowser,
                       #  FactList, ThreadInspector, RuleEditor, ...
```

- `shared/` package (or a types-only import path) holds the Zod schemas/types
  used by both server and client — one source of truth for API contracts.
- Transcript virtualization for long stories (only render visible window).
- Offline resilience: WS auto-reconnect with resume (`turn.final` replay for the
  last turn id the client saw).

## Player visibility rules (recap)

- Default: player sees narration, scene header, player-scope memory, soft notices.
- `debug.showThreads=true` (global or per story): Threads tab appears, memory
  browser gains a scope switcher (player/storyteller/per-NPC), turn bubbles gain
  an "inspect" affordance linking to that turn's thread log entries.
