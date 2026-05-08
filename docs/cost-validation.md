# Cost validation — 2026-05-07

This document records how the cost numbers reported by `llm-cost-monitor` were
validated end-to-end against external sources. It exists so a reader can later
audit the pipeline, reproduce the checks, and judge how much trust to put in
the headline dollar figures.

## TL;DR

| Provider | Per-call math | Prices vs vendor docs | Status |
|---|---|---|---|
| Anthropic (Claude) | ✅ hand-validated to the µUSD | ✅ matches Anthropic's official Models overview | **Fully validated** |
| Google (Gemini) | ✅ hand-validated to the µUSD | ✅ matches Google's official Gemini API pricing page | **Fully validated** |
| OpenAI (Codex) | ✅ hand-validated to the µUSD | 🟡 LiteLLM-sourced; vendor page returned 403 to the auto-fetcher | **Math validated, prices community-sourced** |

## Subscription vs. API — read this first

The user runs on **Claude Max 5x** ($100 + tax / month flat) and (likely) a
ChatGPT plan for Codex. Neither is billed per-token. So the dollar figures
this app reports are not a real bill — they are *"what those tokens would
cost if you'd been on the raw API."* This is the standard convention for
every Claude-usage tracker on GitHub, and it's the right number for answering
"is the subscription worth it?" or "which model is cheaper for this task?"

Today's billing cycle data point (pulled from a real Anthropic receipt
parsed from Gmail):

- Anthropic charges: $100.00 + $6.25 (MA tax) = **$106.25 / month flat**
- Anthropic Max 5x billing cycle: 2026-04-29 → 2026-05-29
- App's "API-equivalent" Claude cost for the same window so far: **$57.89**

Per-token equivalent < flat plan in this billing window so far, but only 9 of
30 days in. Whether the subscription is worth it depends on the user's pace
and rate-limit needs — the app gives the user the data to decide.

## Pricing source

`resources/pricing.json` is a snapshot of [BerriAI/litellm's
`model_prices_and_context_window.json`][litellm-prices], the de-facto
community-maintained reference used by most LLM tools. It carries 2,250
models. The snapshot fingerprint at validation time was `246413ab150e` (first
12 hex chars of the SHA-256 of the file), and the same hash is recorded on
every `UsageEvent` written to SQLite — so cost-prices-at-write-time can
always be traced back to a specific snapshot.

`Scripts/refresh-pricing.sh` pulls a new snapshot on demand. CI will run it
nightly (slice 15).

[litellm-prices]: https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json

## How the cost is computed

For every parsed event:

```
cost_usd = ( input_tokens         × input_per_M
          +  output_tokens        × output_per_M
          +  cache_read_tokens    × cache_read_per_M
          +  cache_5m_tokens      × cache_5m_per_M
          +  cache_1h_tokens      × cache_1h_per_M
          +  reasoning_tokens     × reasoning_per_M ) / 1_000_000
```

Stored as **integer micro-USD** (`bigint`) to avoid floating-point drift over
millions of calls. Display conversion to dollars happens only at the renderer
boundary. Fallback rules per `docs/architecture.md` D5:

- `cache_5m_per_M` falls back to `cache_creation_per_M` when no 5-minute-specific rate exists.
- `cache_1h_per_M` falls back to `cache_creation_per_M` similarly.
- `reasoning_per_M` falls back to `output_per_M` when no reasoning-specific rate exists.
- Unknown model → conservative Sonnet-tier fallback ($3 in / $15 out / $0.30 cache_read / $3.75 cache_create / $6.00 cache_1h). Never silently $0.

Each component is rounded with `Math.round(...)` to the nearest µUSD before
summing, so total error is bounded by the number of token buckets (≤6 µUSD =
≤$0.000006 per event).

## Hand validation — one event per provider

These three events came from `~/Library/Application Support/llm-cost-monitor/usage.db`
on 2026-05-07. To reproduce, run:

```sh
sqlite3 ~/Library/Application\ Support/llm-cost-monitor/usage.db "
SELECT model, input_tokens, output_tokens, cache_read_tokens,
       cache_creation_5m_tokens, cache_creation_1h_tokens,
       reasoning_tokens, computed_cost_micro_usd
FROM events ORDER BY computed_cost_micro_usd DESC LIMIT 5;"
```

Then look up each model in `resources/pricing.json` and compute by hand.

### Claude — `claude-opus-4-7` ✅

**Stored event:** 6 input + 2,780 output + 14,490 cache_read + 255,807 cache_5m + 0 cache_1h tokens. App reported **1,675,569 µUSD** ($1.6756).

LiteLLM prices (after `× 1e6` scaling to "per-M"):

- input: 5.00 · output: 25.00 · cache_read: 0.50 · cache_creation: 6.25 · cache_5m: null (→ falls back to 6.25) · cache_1h: 10.00

| Bucket | Tokens | × Rate per M | = µUSD |
|---|---:|---:|---:|
| input | 6 | × 5 | 30 |
| output | 2,780 | × 25 | 69,500 |
| cache_read | 14,490 | × 0.5 | 7,245 |
| cache_5m (fallback to cache_creation 6.25) | 255,807 | × 6.25 | 1,598,794 |
| cache_1h | 0 | × 10 | 0 |
| **Total** | | | **1,675,569** |

**Match: 1,675,569 µUSD == 1,675,569 µUSD** ✅

### Codex — `gpt-5.5` ✅

**Stored event:** 70,954 input + 330 output + 70,016 cache_read + 38 reasoning tokens. App reported **400,818 µUSD** ($0.4008).

LiteLLM prices: input: 5.00 · output: 30.00 · cache_read: 0.50 · reasoning: null (→ falls back to output 30.00).

| Bucket | Tokens | × Rate per M | = µUSD |
|---|---:|---:|---:|
| input | 70,954 | × 5 | 354,770 |
| output | 330 | × 30 | 9,900 |
| cache_read | 70,016 | × 0.5 | 35,008 |
| reasoning (fallback to output 30) | 38 | × 30 | 1,140 |
| **Total** | | | **400,818** |

**Match: 400,818 µUSD == 400,818 µUSD** ✅

### Gemini — `gemini-3-flash-preview` ✅

**Stored event:** 11,731 input + 362 output + 3,788 cache_read + 137 reasoning tokens. App reported **7,552 µUSD** ($0.0076).

LiteLLM prices: input: 0.50 · output: 3.00 · cache_read: 0.05 · reasoning: null (→ falls back to output 3.00).

| Bucket | Tokens | × Rate per M | = µUSD |
|---|---:|---:|---:|
| input | 11,731 | × 0.5 | 5,866 |
| output | 362 | × 3 | 1,086 |
| cache_read | 3,788 | × 0.05 | 189 |
| reasoning (fallback to output 3) | 137 | × 3 | 411 |
| **Total** | | | **7,552** |

**Match: 7,552 µUSD == 7,552 µUSD** ✅

## External price cross-check

### Anthropic — `claude-opus-4-7`

Source: [Anthropic Models overview](https://docs.claude.com/en/docs/about-claude/models/overview),
fetched 2026-05-07.

| Model | Anthropic official | LiteLLM (this app) | Match |
|---|---|---|---|
| Opus 4.7 | $5 in / $25 out | $5 in / $25 out | ✅ |
| Sonnet 4.6 | $3 in / $15 out | $3 in / $15 out | ✅ |
| Haiku 4.5 | $1 in / $5 out | $1 in / $5 out | ✅ |

The Anthropic overview page lists only input/output rates; cache rates link
to a separate pricing page that requires authentication. LiteLLM's cache
numbers for Opus 4.7 ($0.50 read / $6.25 creation / $10.00 1-hour) match the
documented Anthropic pattern (cache_read = input × 0.1, cache_creation =
input × 1.25, 1h-cache = input × 2) for the Opus tier.

### Google — `gemini-3-flash-preview`

Source: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing),
fetched 2026-05-07.

| Bucket | Google official | LiteLLM (this app) | Match |
|---|---|---|---|
| Input | $0.50 / 1M | $0.50 / 1M | ✅ |
| Output (incl. thinking) | $3.00 / 1M | $3.00 / 1M | ✅ |
| Context cache (read) | $0.05 / 1M | $0.05 / 1M | ✅ |

Google's pricing is "output includes thinking tokens" — meaning thinking
tokens are billed at the output rate. Our parser maps Gemini's `tokens.thoughts`
field to `reasoningTokens`, which `PricingTable.cost()` rates at
`reasoningPerM ?? outputPerM`. Since LiteLLM has no separate reasoning rate
for this model, the fallback to `outputPerM` matches Google's "thinking
billed as output" rule exactly.

### OpenAI — `gpt-5.5`

OpenAI's pricing pages (`https://openai.com/api/pricing`,
`https://platform.openai.com/docs/pricing`, `https://openai.com/pricing`) all
returned **HTTP 403** to the auto-fetcher. The numbers used by the app come
from LiteLLM:

- input: $5 / 1M · output: $30 / 1M · cache_read: $0.50 / 1M

These are the canonical GPT-5 series prices as of LiteLLM's last sync. To
verify by hand, open https://platform.openai.com/docs/pricing in a browser
and confirm `gpt-5.5` lists those rates. If they ever drift, run
`make refresh-pricing` to pull a fresh snapshot.

## Caveats and known gaps

1. **Subscription users get a flat bill, not a per-call bill.** For Claude
   Max / ChatGPT Plus subscriptions, the API-equivalent figure this app
   reports has no relationship to what's actually charged. Treat it as
   guidance, not invoice reconciliation.

2. **Gemini free-tier usage may be reported as nonzero.** If the user is on
   the free tier (no GCP billing project linked), Google does not actually
   charge for the calls. The app's $0.02 figure is "what it would have cost
   on the paid tier."

3. **LiteLLM lag.** New model releases sometimes appear in LiteLLM days or
   weeks after launch. If the user uses a brand-new model name, the lookup
   chain falls through to the Sonnet-tier fallback ($3/$15) — conservative
   and visible (cost is not silently zero), but not necessarily accurate.
   `make refresh-pricing` updates the snapshot.

4. **OpenAI prices are not auto-validated.** The 403 was deterministic across
   multiple OpenAI URLs from the auto-fetcher; the user should occasionally
   spot-check `platform.openai.com/docs/pricing` against `pricing.json`.

5. **Math precision is bounded but not perfect.** Each token bucket is
   rounded to the nearest µUSD. Total per-event error is at most 6 µUSD
   ($0.000006) — irrelevant in practice.

## How to re-run this validation in the future

1. Pull three high-cost events from the DB (one per provider) — see the
   `sqlite3` snippet under "Hand validation" above.
2. For each event, look up the model in `resources/pricing.json` and the
   rates each token bucket should use.
3. Compute by hand in micro-USD. If the SQL `computed_cost_micro_usd`
   doesn't match within ±6, file a bug.
4. Cross-check `pricing.json` rates against the vendor's official pricing
   page. If they drift, run `make refresh-pricing`.
