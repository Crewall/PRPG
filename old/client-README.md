# PRPG Web Client

`client/dist/` holds the **built** web client the backend serves statically
(`@fastify/static`). Per `docs/01-tech-stack.md`, **Termux never runs a JS build
step** — it just serves these files.

## Layer 1 status

For the Layer-1 walking skeleton the client is written as **dependency-free,
zero-build static files** (`index.html`, `style.css`, `app.js`) — vanilla ES
modules, no framework. This is the sanctioned "Plain HTML" alternative listed in
the tech-stack doc, and it means the UI runs on a phone with no toolchain at all.

It implements:
- **Home** — list / create / delete stories (title, genre, premise seed).
- **Play** — streamed transcript over WebSocket, input bar with send/stop,
  per-turn token counters, live WS connection indicator.

## Later layers

`docs/07-api-and-ui.md` nominates **Svelte + Vite** for the richer UI (memory
browser, thread inspector, rules, settings). When those land, a `client/src/`
Svelte project builds into this same `client/dist/` directory; the server code
does not change. The vanilla client here is the migration baseline.
