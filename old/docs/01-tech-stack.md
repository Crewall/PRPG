# 01 — Technology Stack

The stack is chosen against three hard constraints:

1. **Must run on Android via Termux** (like SillyTavern) — so no Docker, no JVM,
   no heavyweight native dependencies, modest RAM footprint, ARM64 support.
2. **Many parallel AI sessions** — so first-class async I/O and streaming.
3. **Single-developer maintainability** — one language across the whole stack where
   possible, small dependency tree, no framework churn.

## Recommendation summary

| Layer | Choice | Alternative |
|---|---|---|
| Language | **TypeScript** (Node.js ≥ 20 LTS) | Python 3.12 + FastAPI |
| HTTP server | **Fastify** | Express, Hono |
| Realtime | **WebSocket** (`ws` plugin for Fastify) | Server-Sent Events |
| Database | **SQLite** via `better-sqlite3` | `node:sqlite` (Node 22+), JSON files |
| LLM access | **Own thin adapter** over provider SDKs (`@anthropic-ai/sdk`, `openai`) | — |
| Agent framework | **None — own orchestrator** | LangGraph (explicitly not recommended) |
| Frontend | **Svelte + Vite**, built to static files, served by the backend | Plain HTML + htmx; React |
| Schema validation | **Zod** (validates both API bodies and LLM JSON outputs) | — |
| Testing | **Vitest** + recorded LLM fixtures | — |
| Packaging | git clone + `npm ci` + `npm start` (Termux script provided) | — |

## Rationale per decision

### Node.js + TypeScript (backend language)

- **Termux precedent:** SillyTavern itself is Node on Termux; `pkg install nodejs-lts`
  is a one-liner and works reliably on ARM64. This is the most battle-tested
  local-LLM-frontend deployment path on Android.
- **Async by default:** the engine's workload is "hold many streaming HTTPS
  connections to an LLM API concurrently" — Node's event loop handles dozens of
  concurrent agent streams in one process with trivial memory cost. No thread pool
  or worker management needed.
- **One language everywhere:** shared TypeScript types between backend, frontend,
  and the JSON contracts the scribe agents must emit (Zod schemas double as
  runtime validators for LLM output).
- Python + FastAPI is a legitimate alternative (also fine on Termux), but you lose
  type sharing with the web UI and gain nothing the engine needs.

### Fastify (HTTP framework)

Small, fast, first-class TypeScript support, built-in schema validation hooks,
mature WebSocket plugin. Express would also work; Fastify's plugin/encapsulation
model maps nicely onto the module layout in `02-architecture.md`.

### SQLite via `better-sqlite3` (storage)

- Zero-admin single file per install — ideal for a phone.
- Synchronous API is *fine* here: writes are small and the process is I/O-bound on
  the LLM, not on disk.
- Full-text search (**FTS5**) is built in — this powers memory retrieval (see
  `05-memory-system.md`) without any vector database.
- `better-sqlite3` ships prebuilt binaries for common platforms; on Termux it
  compiles from source (`pkg install python clang make` once). **Fallback:** Node 22's
  built-in `node:sqlite` module needs no compilation at all — keep the DB layer
  behind a small interface (`src/db/`) so the driver is swappable.
- Vector embeddings are deliberately **not** in the MVP; FTS + alias/tag matching
  covers retrieval. If embeddings are added later, `sqlite-vec` is the
  Termux-friendly option.

### No agent framework — own orchestrator

The agent topology here is **fixed and known at design time** (storyteller, N NPC
threads, two scribes, one overseer). Frameworks like LangGraph/LangChain earn their
complexity when topology is dynamic or you need their ecosystem; here they would
add a heavy dependency tree (bad on Termux), obscure prompt contents (bad for the
debug/visibility requirement), and fight the custom context-scoping logic that is
the core of this project. The orchestrator in `06-orchestration.md` is ~a few
hundred lines of plain TypeScript and fully inspectable.

### Thin LLM adapter, multi-provider

One interface, several drivers:

```ts
interface LlmDriver {
  /** Streamed chat completion. Yields text deltas; resolves to the full message. */
  chat(req: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult>;
}

interface ChatRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  /** When set, the driver enforces JSON output (tool/response-format per provider). */
  jsonSchema?: object;
  /** Abort long generations (regeneration, user cancel). */
  signal?: AbortSignal;
}
```

Drivers to implement, in order: **Anthropic**, **OpenAI-compatible** (which also
covers OpenRouter, local llama.cpp/ollama servers, DeepSeek, etc. — one driver,
many backends). Per-agent model selection is a config concern (cheap/fast model
for scribes, strongest model for the storyteller).

### Svelte SPA served as static files (frontend)

- Built on the dev machine (`vite build`), committed or released as `client/dist/`;
  **Termux never runs a JS build step**, the backend just serves static files.
- Svelte compiles away its runtime → smallest payload, snappy on mobile browsers.
- The UI is a chat surface + side panels (memory browser, thread inspector,
  settings) — well within plain-Svelte territory, no meta-framework (no SvelteKit
  SSR; the backend is the only server).
- The phone usage pattern: start server in Termux, open `http://127.0.0.1:7777`
  in the phone's browser (or from a desktop on the same LAN).

### Zod (validation)

The scribes and the overseer must return **machine-parseable JSON**. Zod schemas
are the single source of truth: they generate the JSON-schema text embedded in
scribe prompts, validate the LLM's reply, and type the parsed result. Invalid
output triggers one automatic "fix your JSON" retry (see `04-agents.md`).

## Version / dependency baseline

```
node        >= 20 (LTS; 22 preferred for node:sqlite fallback)
fastify     ^5
@fastify/websocket, @fastify/static
better-sqlite3 ^11
zod         ^3
@anthropic-ai/sdk, openai   (drivers)
svelte ^5, vite ^6          (client build only — devDependency)
vitest      (dev)
```

Keep runtime dependencies under ~10 packages. Every added dependency must justify
itself against the Termux constraint.

## Termux deployment sketch

```bash
pkg install nodejs-lts git python clang make   # toolchain for better-sqlite3
git clone <repo> && cd prpg
npm ci --omit=dev
cp config.example.json config.json             # add API key(s) here
npm start                                      # serves http://127.0.0.1:7777
```

Provide `scripts/termux-install.sh` automating the above, and document
`termux-wake-lock` so Android doesn't kill the server mid-session.
