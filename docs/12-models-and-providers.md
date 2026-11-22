# 12 — Models, providers, tiers and caching

**Status: draft spec, not built.** Milestone M1 of [doc 10](10-minds-engine.md) (Claude support is M1b, low
priority). It applies to all engines, not only Minds.

**Focus: DeepSeek (direct) and OpenRouter.** Claude/Anthropic follows later.

---

## 1. Problems today

- **One connection per provider kind.** Settings hold one Anthropic slot and one OpenAI-compatible slot with a
  single base URL, so **DeepSeek and OpenRouter can't be used at the same time**.
- **Per-role model picking.** Eight roles, each with its own model, temperature and max tokens. Switching "the
  strong model" means editing several rows.
- **DeepSeek specifics unhandled.** Thinking mode is on by default and can't be switched off (slow for character
  and helper calls). JSON mode can return whitespace-only content.
- **OpenRouter specifics unhandled.**
  - Reasoning can't be switched off.
  - No sticky session, so cache hits depend on luck.
  - Free-model daily limits are invisible until requests start failing.
- **Cache usage is invisible.** Neither driver reads cache fields, and JSON calls log `tokensIn: 0`
  (`src/agents/agent.ts`, `invokeJson`).
- *(Low priority)* **The Anthropic driver breaks on current Claude models.** It always sends `temperature`
  (`src/llm/anthropicDriver.ts:58`) and prefills `{` for JSON (`:34`); current models reject both with HTTP 400.

## 2. Providers (connections)

A list of named connections. Several of the same kind are allowed.

```ts
Provider = { id, label, kind: 'openai_compat' | 'anthropic', preset, baseUrl, apiKey /* optional for local */ }
```

| Preset | kind | Base URL | Notes |
|---|---|---|---|
| **DeepSeek** | openai_compat | `https://api.deepseek.com` | Automatic disk cache. Thinking on by default (switchable per request). JSON mode needs the word "json" in the prompt. |
| **OpenRouter** | openai_compat | `https://openrouter.ai/api/v1` | Many models, including `:free` ones (daily limits, §6.1). Caching depends on the upstream; sticky sessions (§5.2). |
| OpenAI | openai_compat | `https://api.openai.com/v1` | Automatic prefix cache. |
| Local | openai_compat | `http://127.0.0.1:11434/v1` | llama.cpp / Ollama; key optional. |
| Anthropic | anthropic | `https://api.anthropic.com` | Low priority (M1b). |

A preset only fills in defaults; everything stays editable. Per connection:

- **Test** (existing button, now per connection);
- **List models** (`GET {baseUrl}/models` where supported; otherwise models are typed in);
- for OpenRouter, the existing **credits/limits** check, extended with the free-model daily counter (§6.1).

Keys stay in the settings table, masked in every API response.

## 3. Models

The existing favourites list, now pointing at a connection:

```ts
Model = { id, label, providerId, model,
          caps: { sampling: boolean, reasoning: 'none' | 'toggle' | 'always', json: 'schema' | 'json_object' | 'prompt' } }
```

`caps` tell the driver what it may send. They are pre-filled from the preset (and, for OpenRouter, from the model
list's metadata where available) and editable.

- **DeepSeek** at time of writing: `deepseek-flash` and `deepseek-v4-pro`. Both have 1M context; both offer
  thinking and non-thinking modes per request.
- **OpenRouter:** some models are reasoning-mandatory (switching reasoning off is rejected), so they get
  `reasoning: 'always'`.

Model names change; use **List models** rather than hardcoding.

## 4. Tiers

A tier is a named model setting. Roles point at tiers; the user mostly changes tiers.

```ts
Tier = { id, label, modelId, maxTokens, temperature?: number /* empty = don't send */,
         reasoning?: 'off' | 'on' | 'default', effort?: 'low' | 'medium' | 'high' | 'max' }
```

- **Defaults:** Heavy, Medium, Light, created on first run or by the migration (§7).
- **Custom tiers:** the user can add tiers ("Heavy 2", "Fast chat") and rename any. Deleting a tier still
  referenced by a role or a character is blocked until it is reassigned.

### 4.1 Roles → tiers

| Role | Engine | Default tier |
|---|---|---|
| `narrator` | Minds | Heavy |
| `character` | Minds | Medium |
| `referee` | Minds | Light |
| `distributor` | Minds | Light |
| `compactor` | Minds | Light |
| `seeder` | Minds | Medium |
| `player_intake` (interviewer) | all | Medium |
| `randomizer` | all | Light |
| `storyteller` | classic / NPC Story Mode | Heavy |
| `npc` | classic / NPC Story Mode | Medium |
| `scribe_story`, `scribe_memory`, `context_planner`, `adjudicator`, `overseer` | classic / NPC Story Mode | Light |

**Settings page layout:**

- **Tiers** card at the top: one row per tier with model picker, max tokens, optional temperature, reasoning and
  effort. This is what the user normally changes.
- **Role mapping**: a collapsed section below it.
- Then **Models** and **Providers**.

### 4.2 Overrides and resolution order

1. The character's own tier (`character_sheets.tier_id`, doc 11; advanced mode), for `character` calls only.
2. The story's role → tier override (Story options, advanced mode).
3. The global role → tier mapping.

### 4.3 Suggested starting setup (shown as a one-click preset in Settings)

| Tier | Suggestion | Reasoning |
|---|---|---|
| Heavy (narrator) | DeepSeek `deepseek-v4-pro`, or a strong paid model on OpenRouter | provider default |
| Medium (characters, seeder) | DeepSeek `deepseek-flash` | **off** |
| Light (referee, helpers) | DeepSeek `deepseek-flash`, or an OpenRouter `:free` model if within its daily limit | **off** |

Reasoning is off for Medium and Light because a round runs up to three sequential stages (doc 10 §5), so slow
calls add up. Characters' replies are short declarations that don't need long thinking.

## 5. Driver changes

### 5.1 Anthropic (M1b, low priority)

Decision: **move the Anthropic driver to the official `@anthropic-ai/sdk`.** It is pure JavaScript (no native
build, fine on Termux), handles streaming, retries and typed errors, and follows API changes; the two 400s in §1
are exactly that kind of drift. When done:

- no `temperature` unless the tier sets it and the model allows it;
- JSON through structured outputs (`output_config.format`), never prefill;
- `output_config.effort` from the tier;
- request-level `cache_control` (5-minute default, optional 1-hour setting);
- usage read from `cache_read_input_tokens` / `cache_creation_input_tokens`.

### 5.2 OpenAI-compatible: shared rules

- **Sampling:** send `temperature` only when the tier sets it and `caps.sampling` allows it.
- **Whitespace-only content** (DeepSeek JSON mode does this when its output isn't valid JSON) counts as empty and
  goes through the existing retry/repair path.
- **Reasoning text** is never displayed and never sent back; only its length and token count are logged.
- **Usage** is read from the final chunk and normalized (§5.5).

### 5.3 DeepSeek (direct)

- **JSON:** `response_format: { type: "json_object" }`. The prompt must contain the word "json" and an example of
  the output; every contract in doc 10 §9 has both.
- **Thinking:** `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` from the tier. In thinking
  mode DeepSeek ignores `temperature` without error. Reasoning streams as `delta.reasoning_content`; it would only
  need sending back in tool-calling conversations, and we don't use tools.
- **Usage:** `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `completion_tokens`.

### 5.4 OpenRouter

- **JSON:**
  - when the model's endpoints support structured outputs (`caps.json = 'schema'`), send
    `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }` with the schema
    generated from the Zod contract, and `provider: { require_parameters: true }` so only supporting endpoints
    are used;
  - otherwise `json_object` (support varies by upstream);
  - otherwise a prompt-only instruction plus `extractJson` and the repair retry.

  `strict` is a hint on some upstreams, so the Zod validation stays authoritative.
- **Reasoning:** `reasoning: { enabled: false }` when the tier says off, `reasoning: { effort }` when on. For
  reasoning-mandatory models (`caps.reasoning = 'always'`) nothing is sent to disable it. Reasoning streams as
  `delta.reasoning_details`; display ignores it.
- **Sticky sessions (cache hits):** send `session_id` = the thread's session id (≤ 256 characters) on every call.
  OpenRouter then keeps that thread on the same upstream provider, so its cache keeps hitting. Stickiness expires
  after 60 minutes of inactivity. Don't send `provider.order` (it disables sticky routing) unless the user pins a
  provider for a model on purpose.
- **Usage** is returned by default (the old `usage.include` / `stream_options` switches are no-ops there):
  - `prompt_tokens_details.cached_tokens` and `prompt_tokens_details.cache_write_tokens`;
  - `completion_tokens_details.reasoning_tokens`;
  - `cost` (credits), stored per call.
- **Rate limits:** HTTP 429 with `X-RateLimit-*` headers and sometimes `Retry-After`, handled by the existing
  backoff. Upstream 429s carry `metadata.provider_code`. A mid-stream error arrives as an SSE event with
  `finish_reason: "error"`, which must fail the call cleanly.

### 5.5 Usage normalization and logging

- `ChatResult.usage` gains `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` and `cost` (when the provider
  reports it).
- `invokeJson` logs real usage (today it logs 0 input tokens).
- `thread_log` gets `cache_read`, `cache_write`, `reasoning_tokens` and `cost` columns, plus the connection id
  (for request counting).
- Advanced mode shows, per call, input / cached / output tokens and cost. Per thread it shows the cache hit
  ratio, which is how we'll know the layout in doc 10 §8 works.

## 6. Caching: what to expect per provider

| Provider | Mechanism | What we send | Lifetime |
|---|---|---|---|
| DeepSeek (direct) | Automatic disk cache, best-effort. A request hits when its prefix fully matches a stored **cache unit**; units are created at the end of each user input and each model output, at prefixes shared across requests, and at fixed intervals in long inputs. | Nothing | Cleared hours to days after last use |
| OpenRouter → DeepSeek, OpenAI, Gemini 2.5+, Grok, others | Automatic upstream caching; OpenRouter routes a session to the same upstream (sticky) | `session_id` per thread | Upstream's; stickiness 60 min idle |
| OpenRouter → Anthropic, Qwen | Explicit `cache_control` markers | v1: nothing; later with M1b | 5 min / 1 h |
| Anthropic (direct, M1b) | Prefix cache with a marker | Request-level `cache_control` | 5 min / 1 h |

**Why the thread shape matters.** DeepSeek's cache units sit at message boundaries. If volatile data were
appended after the stored log and then dropped (a "tail"), the next request would never reuse the previous one's
units. Fully append-only threads, where each round message is stored exactly as sent (doc 10 §8), make every
earlier request a prefix of the next. OpenRouter's default sticky key is a hash of the first system and first
user message; both are stable in our threads, and `session_id` makes it explicit from the first call.

**Expected result.** From the second round on:

- a character call pays full price only for its new round message (a few hundred tokens) plus its output;
- the narrator pays full price only for its round message plus output.

Cache-hit input costs a small fraction of normal input:

- DeepSeek direct, at time of writing: about 1/30–1/50 of cache-miss input;
- OpenRouter's DeepSeek route: 0.1×, with cache writes at the normal price.

A compaction costs one full-price call for that thread.

### 6.1 Request budget (free models)

OpenRouter `:free` models allow **20 requests per minute**. Per day: **50** if fewer than 10 credits were ever
purchased, **1000** with at least 10. A Minds round makes about 5 calls (doc 10 §5), so 50 a day is only about
10 rounds.

- **Counting:** requests per connection per day, from `thread_log`. For OpenRouter, `GET /api/v1/key` →
  `free_model_daily_requests` (`used`, `limit`, `remaining`) is the authority when available.
- **Display:** a small "requests today: 37 / 50" next to each OpenRouter tier in Settings, and in the status bar
  when a tier using a `:free` model is over 80%.
- **Behaviour at the limit:** the call fails with a clear message ("OpenRouter free limit reached for today:
  switch the Light tier to DeepSeek or add credits"), never a silent retry loop. Automatic fallback to another
  tier is a TODO.

## 7. Settings migration (lossless)

From today's `runtimeConfig`:

1. `providers.openai_compat` → one connection, with the OpenRouter preset if its base URL is `openrouter.ai`, the
   DeepSeek preset if `api.deepseek.com`, else "Custom". `providers.anthropic` → connection "Anthropic".
2. Favourites → models with `providerId`.
3. Tiers: **Heavy** ← the `storyteller` binding, **Medium** ← the `npc` binding, **Light** ← the `scribe_memory`
   binding (model + temperature + max tokens). Every other role points at the tier with an identical binding; if
   none matches, a tier named after the role is created, so behaviour is unchanged.
4. Per-story overrides (`settings.roles`: profile names) → story-level role → tier overrides. A tier is created if
   no existing tier uses that model.
5. The old fields stay readable for one version.
6. `config.example.json` switches to a DeepSeek + OpenRouter example.

## 8. Acceptance tests (M1)

- Migration: every role resolves to the same model, temperature and max tokens before and after.
- DeepSeek and OpenRouter connections at once: each call goes to the right base URL with the right key.
- DeepSeek: thinking off is sent as `thinking: {type: "disabled"}`; usage hit/miss is normalized; a
  whitespace-only JSON reply is retried, not parsed.
- OpenRouter:
  - `session_id` is the same on every call of one thread and different across threads;
  - `reasoning: {enabled: false}` is sent only when the tier says off and the model allows it;
  - `json_schema` + `require_parameters` is used for schema-capable models;
  - usage `cached_tokens` and `cost` are recorded;
  - a mid-stream `finish_reason: "error"` fails the call cleanly.
- Free-model counter: the request count increments per call and the limit message appears at the limit.
- Deleting a tier in use is refused; resolution order character → story → global holds.
- M1b (later): the Anthropic request has no `temperature` unless set, no assistant prefill, and has `cache_control`.
