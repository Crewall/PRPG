# 12 — Models, providers, tiers and caching

**Status: draft spec, not built.** This is milestone M1 of [doc 10](10-minds-engine.md). It applies to all
engines, not only Minds.

---

## 1. Problems today

- **One connection per provider kind.** Settings hold `providers.anthropic` and one `providers.openai_compat`
  with a single base URL. DeepSeek and OpenRouter can't be used at the same time.
- **Per-role model picking.** Eight roles, each with its own model, temperature and max tokens. Switching "the
  strong model" means editing several rows.
- **The Anthropic driver breaks on current Claude models.**
  - It always sends `temperature` (`src/llm/anthropicDriver.ts:58`). Current Claude models reject sampling
    parameters.
  - For JSON it prefills the reply with `{` (`:34`). Current models reject assistant prefill.

  Both return HTTP 400. `config.example.json` binds the storyteller to `claude-sonnet-5`, so that setup fails;
  Haiku 4.5 still accepts both.
- **No caching on Claude**: no cache markers are sent.
- **Cache usage is invisible**: neither driver reads cache fields, and JSON calls log `tokensIn: 0`
  (`src/agents/agent.ts`, `invokeJson`).
- **DeepSeek specifics are unhandled**: thinking mode is on by default and can't be switched off, and JSON mode
  can return whitespace-only content.

## 2. Providers (connections)

A list of named connections. Several of the same kind are allowed.

```ts
Provider = { id, label, kind: 'anthropic' | 'openai_compat', preset, baseUrl, apiKey /* optional for local */ }
```

| Preset | kind | Base URL | Notes |
|---|---|---|---|
| Anthropic | anthropic | `https://api.anthropic.com` | Caching needs markers (§5.1). |
| DeepSeek | openai_compat | `https://api.deepseek.com` | Automatic disk cache; thinking on by default; JSON mode needs the word "json" in the prompt. |
| OpenRouter | openai_compat | `https://openrouter.ai/api/v1` | Free models; caching depends on the upstream provider. Credits check already exists. |
| OpenAI | openai_compat | `https://api.openai.com/v1` | Automatic prefix cache. |
| Local | openai_compat | `http://127.0.0.1:11434/v1` | llama.cpp / Ollama; key optional. |

A preset only fills in defaults; everything stays editable. Per provider:

- **Test** (existing button, now per connection);
- **List models** (`GET {baseUrl}/models` where the provider supports it; otherwise models are typed in).

Keys stay in the settings table, masked in every API response, as today.

## 3. Models

The existing favourites list, now pointing at a provider connection instead of a provider kind:

```ts
Model = { id, label, providerId, model, caps: { sampling: boolean, thinking: 'none'|'toggle'|'always', json: 'schema'|'json_object'|'prompt' } }
```

`caps` are hints the driver uses (which parameters it may send). They are pre-filled from the preset and
editable.

DeepSeek at time of writing lists `deepseek-flash` and `deepseek-v4-pro`. Both have 1M context, and both offer
thinking and non-thinking modes per request. Names change, so use **List models** rather than hardcoding.

## 4. Tiers

A tier is a named model setting. Roles point at tiers; the user mostly changes tiers.

```ts
Tier = { id, label, modelId, maxTokens, temperature?: number /* empty = don't send */,
         thinking?: 'off' | 'on' | 'default', effort?: 'low' | 'medium' | 'high' | 'max' }
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

- **Tiers** card at the top: one row per tier with model picker, max tokens, optional temperature, thinking and
  effort. This is what the user normally changes.
- **Role mapping**: a collapsed section below it.
- Then **Models** and **Providers**.

### 4.2 Overrides and resolution order

1. The character's own tier (`character_sheets.tier_id`, doc 11; advanced mode), for `character` calls only.
2. The story's role → tier override (Story options, advanced mode).
3. The global role → tier mapping.

### 4.3 Defaults for speed

Calls in a round run in up to three sequential stages (doc 10 §5), so latency adds up. Defaults:

- **Medium and Light:** thinking `off` (DeepSeek) or effort `low` (Claude).
- **Heavy:** provider default.

The user can change any of these per tier.

## 5. Driver changes

### 5.1 Anthropic

- **Sampling:** send `temperature` only when the tier sets it **and** the model's `caps.sampling` allows it.
- **JSON without prefill:** use structured outputs (`output_config.format` with a JSON Schema generated from the
  Zod schema). For models without structured outputs: a plain "reply with JSON" instruction plus the existing
  `extractJson` and repair retry. Never prefill.
- **Effort:** send `output_config.effort` when the tier sets it.
- **Caching:** request-level automatic caching (`cache_control: { type: "ephemeral" }`). With append-only threads
  (doc 10 §8) the cached prefix is everything up to the newest message, so the next round reads it from cache.
  Prefixes shorter than the model's minimum (512–4096 tokens depending on the model) silently don't cache, so
  early rounds may not hit.
- **Cache lifetime:** default 5 minutes. A per-installation setting **"1-hour cache"** suits slow play (pauses of
  several minutes between messages); it costs more to write.
- **Usage:** read `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens`
  from the stream.
- **Implementation choice (open question, doc 10 §15):** keep the hand-written fetch driver, or switch to the
  official `@anthropic-ai/sdk`. **Recommendation: switch.** It is pure JavaScript (no native build, so Termux is
  unaffected), handles streaming events, retries and typed errors, and follows API changes. The two 400s in §1
  are exactly that kind of drift. Cost: one dependency.

### 5.2 OpenAI-compatible (including DeepSeek)

- **Sampling:** send `temperature` only when the tier sets it. DeepSeek ignores it in thinking mode (no error).
- **JSON:** `response_format: { type: "json_object" }`, as today. DeepSeek also requires the word "json" in the
  prompt plus an example of the output; every contract in doc 10 §9 has both.
- **Whitespace-only JSON:** DeepSeek may return content that is only spaces when its output isn't valid JSON.
  Treat whitespace-only content as empty and go through the existing retry and repair path.
- **DeepSeek thinking:** when the preset is DeepSeek (or `caps.thinking` = `toggle`), send
  `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` from the tier. Display ignores
  `delta.reasoning_content`; only its length is logged. It is **not** sent back: DeepSeek needs it back only in
  tool-calling conversations, and we don't use tools.
- **Usage** (the final chunk, via the `stream_options.include_usage` already sent):
  - `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (DeepSeek);
  - `prompt_tokens_details.cached_tokens` (OpenAI and many OpenRouter upstreams).

### 5.3 Usage normalization and logging

- `ChatResult.usage` gains `cacheReadTokens` and `cacheWriteTokens`.
- `invokeJson` logs real usage (today it logs 0 input tokens).
- `thread_log` gets `cache_read` and `cache_write` columns.
- Advanced mode shows per call: input / cached / output tokens, and the cache hit ratio per thread. That's how
  we'll know the layout in doc 10 §8 works.

## 6. Caching: what to expect per provider

| Provider | Mechanism | What we send | Lifetime |
|---|---|---|---|
| Anthropic | Prefix cache, needs a marker | Request-level `cache_control` (§5.1) | 5 min default, 1 h option |
| DeepSeek | Automatic disk cache, best-effort. A request hits when its prefix fully matches a stored **cache unit**; units are created at the end of each user input and each model output, at prefixes shared across requests, and at fixed intervals in long inputs. | Nothing | Cleared hours to days after last use |
| OpenAI | Automatic prefix cache above a minimum prompt length | Nothing | Minutes, per their docs |
| OpenRouter | Depends on the upstream provider | Nothing in v1. Later: markers for Anthropic-upstream models. | Upstream's |

**Why the thread shape matters.** DeepSeek's units sit at message boundaries. If volatile data were appended
after the stored log and then dropped (a "tail"), the next request would never reuse the previous one's units.
Fully append-only threads, where each round message is stored exactly as sent (doc 10 §8), make every earlier
request a prefix of the next. Anthropic and OpenAI benefit the same way.

**Expected result.** From the second round on:

- a character call pays full price only for its new round message (a few hundred tokens) plus its output;
- the narrator pays full price only for its round message plus output;
- the rest is read from cache. DeepSeek bills cache-hit input at roughly 1/30–1/50 of cache-miss input at time of
  writing.

A compaction costs one full-price call for that thread.

## 7. Settings migration (lossless)

From today's `runtimeConfig`:

1. `providers.anthropic` → connection "Anthropic". `providers.openai_compat` → one connection, with the OpenRouter
   preset if its base URL is `openrouter.ai`, else "Custom".
2. Favourites → models with `providerId`.
3. Tiers: **Heavy** ← the `storyteller` binding, **Medium** ← the `npc` binding, **Light** ← the `scribe_memory`
   binding (model + temperature + max tokens). Every other role points at the tier with an identical binding; if
   none matches, a tier named after the role is created, so behaviour is unchanged.
4. Per-story overrides (`settings.roles`: profile names) → story-level role → tier overrides. A tier is created if
   no existing tier uses that model.
5. The old fields stay readable for one version.

## 8. Acceptance tests

- Migration: every role resolves to the same model, temperature and max tokens before and after.
- Two OpenAI-compatible connections at once (DeepSeek + OpenRouter): each call goes to the right base URL with
  the right key.
- Anthropic request body: no `temperature` unless set and allowed; JSON via schema; **no assistant prefill**;
  `cache_control` present.
- Usage normalization from recorded streams: DeepSeek hit/miss, OpenAI `cached_tokens`, Anthropic cache read/write.
- A whitespace-only DeepSeek JSON reply is retried, not parsed.
- DeepSeek thinking toggle and `reasoning_effort` are sent only for DeepSeek models.
- Deleting a tier in use is refused; resolution order character → story → global holds.
