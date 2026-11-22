# old/ — obsolete material, kept for history only

**Do not use anything in this folder as a reference.** Not for code, not for design decisions, not as context
for an AI session. The current descriptions live in [`/ARCHITECTURE.md`](../ARCHITECTURE.md) (the system as
built) and [`/docs`](../docs/README.md) (specs).

| File | What it was | Why it's obsolete |
|---|---|---|
| `docs/01-tech-stack.md` … `docs/08-roadmap.md` | The original design and build plan, written before any code (July 2026). | The code drifted: vanilla JS client instead of Svelte, `node:sqlite` instead of `better-sqlite3`, the rule overseer never built, many later features missing. The engine is being redesigned (docs 10–12). |
| `client-README.md` | The client's Layer-1 notes. | Describes a planned Svelte migration that won't happen. |

Code comments still cite these files (e.g. "see 06-orchestration.md", "doc 04"). Those comments point at the
old plan. Where a comment and the code disagree, **the code is right**.
