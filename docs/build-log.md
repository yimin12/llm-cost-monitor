# Build log

A chronological record of what's been built, what's working, and what's deferred. Newest entry first. Each entry is a snapshot — taken together they're an audit trail of the project's velocity and key decisions.

Companion docs:
- [`plan.md`](../plan.md) — original goal + slice list
- [`docs/architecture.md`](./architecture.md) — decision record D1–D15
- [`docs/cost-validation.md`](./cost-validation.md) — cost-accuracy audit
- [`docs/cli-pulse-feature-spec.md`](./cli-pulse-feature-spec.md) — competitor reverse-engineering
- [`docs/auth-plan.md`](./auth-plan.md) — auth + Postgres plan (active on `feat/auth-gmail`)

---

## 2026-05-07 (later) — Postgres migration on `feat/auth-gmail`

User locked **Option A** (identity-only Sign in with Google) and
**Postgres-in-Docker** for relational persistence. Dev-only; shipped builds
keep SQLite. Single branch for both.

**Slice 0 (Postgres bring-up) done autonomously:**
- `docker-compose.yml` — postgres:17-alpine, `127.0.0.1:5433`, named volume
- `migrations/0001_init.sql` — schema v1 in Postgres BIGINT-everywhere flavor
- `src/main/storage/connect.ts` — pg.Pool with retry-with-backoff + bigint typeparser
- `src/main/storage/migrations.ts` — file-based migration runner
- `src/main/storage/db-utils.ts` — `@name → $N` translator
- `src/main/storage/{event-repository,file-cache}.ts` — async ports
- `src/main/aggregation/aggregator.ts` — async port; every `SUM(BIGINT)` cast `::bigint` to defeat NUMERIC return
- All parsers + providers + IPC awaited
- Tests ported to per-file ephemeral Postgres DBs via `test-helpers.ts`
- `src/main/storage/db.ts` (better-sqlite3 entry) deleted

**End-to-end validated:**
- Postgres 17.9 healthy on `127.0.0.1:5433`
- `storage migrated to v1` on first connect
- 1,063 events ingested across Anthropic ($104) / OpenAI ($64) / Google ($0.02)
- 31 files in mtime cache
- 47/47 vitest cases green

**OAuth quota (CLI Pulse P1) deferred** — user's Claude credentials are in
macOS Keychain, not in `~/.claude/.credentials.json` on this machine.

**Deferred follow-ups on this branch:**
- SQLite-fallback for shipped builds (interface + factory layer)
- `bin/import-from-sqlite.ts` (currently re-derived from JSONL on refresh)
- Slice A1+ — Google Cloud Console OAuth client + identity flow (waiting
  on user to walk through `auth-plan.md` §8)

---

## 2026-05-07 — Current state on `main`

**Repo:** `https://github.com/yimin12/llm-cost-monitor` (private). Commits on `main`:

| SHA | Message |
|---|---|
| `6f5a57a` | Initial commit — slices 1–9 (73 files, 54k LOC) |
| `851d09c` | docs: cost-validation.md audit trail |
| `3e605b2` | feat: CLI Pulse P1+P2 — mtime cache, forecast, privacy banner |
| _(this commit)_ | docs: build-log.md |

**What's running locally:** dev server (`npm run dev`) with mtime-cache active. Tray icon in macOS menubar shows today's USD cost. Dropdown renders today/7d/30d totals, per-provider breakdown, top models/projects, month-end forecast, and the on-device-only privacy banner.

**Numbers as of latest refresh:**
- **848 events** stored in `~/Library/Application Support/llm-cost-monitor/usage.db`
- **30 files** cached in the `files` table (mtime+offset cache active)
- **Lifetime cost** (API-equivalent): $51 Claude / $34 Codex / $0.02 Gemini
- **Real bill** (Anthropic): $100/mo flat (Max 5x), $106.25 with MA tax — pulled from Gmail receipt
- **Tests:** 47/47 vitest cases green
- **Typecheck:** clean

**What's working end-to-end:**
1. Reads `~/.claude/projects/`, `~/.codex/sessions/`, `~/.gemini/tmp/*/chats/`
2. Dedupes (Claude by `message.id`, Codex by line offset, Gemini by message id)
3. Computes cost via 2,250-model LiteLLM pricing snapshot (`246413ab150e`)
4. Stores as integer micro-USD in SQLite
5. Aggregates today/7d/30d/per-provider/top-models/top-projects/forecast
6. Renders to a frameless tray-anchored dropdown
7. Auto-refreshes every 5 min + manual button
8. mtime+offset cache: unchanged files skip entirely, grown files resume from offset
9. Cross-validated against Anthropic + Google official pricing pages

**What's deferred (next eligible work):**
- **P1 Claude OAuth quota** (5h / weekly tier gauges) — needs macOS Keychain access; user's tokens not in `~/.claude/.credentials.json` on this machine
- **P2 Alerts engine** (quota threshold crossed, daily budget exceeded, collector errors)
- **P2 Webhook out** (Discord / Slack / custom)
- **Slice 10 hooks-API receiver** (Unix-domain socket at `<app data>/hooks.sock` for live Claude session events)
- **Slice 11 chokidar tail** (true sub-second updates instead of 5-min polling)

---

## 2026-05-07 — Adopt CLI Pulse P1+P2

User dropped `cli-pulse-feature-spec.md` (a reverse-engineering of CLI Pulse Bar 1.12.0) and asked to "implement that". I picked the highest-leverage subset that didn't require new permissions:

- **mtime+offset file cache** — wired the existing `files` SQLite table into all 3 parsers. Unchanged files skip parse entirely; grown Claude/Gemini files resume from byte offset. Codex always reparses from byte 0 because cumulative `last_token_usage` defeats offset resume, but still benefits from the unchanged-file skip.
- **Month-end forecast card** — `Aggregator.forecast(now)` does linear MTD/days-elapsed × days-in-month projection with a 1σ × √remaining-days confidence band. Null when < 3 days of data.
- **On-device-only privacy banner** — adapted §10 wording into the dropdown footer.

**OAuth quota (the spec's most distinctive feature) deferred** — credentials are in macOS Keychain on this machine, not in `~/.claude/.credentials.json`. Plumbing (types, IPC, UI section) is straightforward to add when Keychain access is granted.

5 new vitest cases (3 FileCache, 2 forecast). 47/47 green.

Commit: `3e605b2`.

---

## 2026-05-07 — GitHub repo + cost validation

Two requests in one session:

1. **Push to GitHub.** Created `yimin12/llm-cost-monitor` (private — irreversible-public-action guardrail kicked in until user explicitly confirmed). `git init`, staged everything except `node_modules/` and `.claude/` (added to `.gitignore`), pushed to `main`. Initial commit `6f5a57a`.

2. **Validate cost accuracy.** Hand-validated one high-cost event per provider against `resources/pricing.json`:
   - **Claude** `claude-opus-4-7`: 6 input + 2,780 output + 14,490 cache_read + 255,807 cache_5m → **1,675,569 µUSD**. Hand math: 30 + 69,500 + 7,245 + 1,598,794 + 0 = **1,675,569 µUSD**. ✅
   - **Codex** `gpt-5.5`: 70,954 input + 330 output + 70,016 cache_read + 38 reasoning → **400,818 µUSD**. Hand math: 354,770 + 9,900 + 35,008 + 1,140 = **400,818 µUSD**. ✅
   - **Gemini** `gemini-3-flash-preview`: 11,731 input + 362 output + 3,788 cache_read + 137 reasoning → **7,552 µUSD**. Hand math: 5,866 + 1,086 + 189 + 411 = **7,552 µUSD**. ✅

Cross-checked LiteLLM rates against vendor docs:
- ✅ Anthropic Models overview: Opus 4.7 = $5/$25 per M tokens (matches LiteLLM)
- ✅ Google Gemini API pricing: Flash Preview = $0.50/$3.00/$0.05 (matches LiteLLM)
- 🟡 OpenAI pricing pages all returned HTTP 403 to the auto-fetcher; user can spot-check `platform.openai.com/docs/pricing` manually

Pulled the Anthropic billing receipt from Gmail to reconcile the headline $51 Claude figure: user is on **Claude Max 5x — $100 + $6.25 MA tax = $106.25/mo flat**, billing cycle Apr 29 → May 29. The app's $51 is the would-have-cost-on-API, not a real bill (which is what every Claude usage tracker reports because subscription ≠ per-token billing).

Wrote `docs/cost-validation.md` (229 lines) as a permanent audit trail. Commit `851d09c`.

---

## 2026-05-06 — Slices 6-9 + Gemini bonus (overnight build)

User went to sleep and asked: "use night shift to continue the work UNTIL I can see the cost for claude, codex and gemini." Auto mode active.

**Strategy:** spawned two parallel research agents to map the unknown Codex + Gemini formats while I scaffolded the Claude parser:
- Codex: `event_msg.payload.type == 'token_count'` rows, `last_token_usage` per call, model from preceding `turn_context`
- Gemini: `~/.gemini/tmp/<project>/chats/session-*.jsonl`, simpler `tokens: {input,output,cached,thoughts,tool}` per message
- Claude: standard masorange JSONL shape (already documented)

**Built (in one go):**
- `src/main/parsers/jsonl.ts` — generic stream-parse with bad-line skipping + offset tracking
- `src/main/parsers/claude-code.ts`, `codex.ts`, `gemini.ts` — three provider-specific parsers
- `src/main/parsers/project-name.ts` — slug simplifier
- `src/main/providers/{anthropic,openai,google}/index.ts` — three `AIProvider` impls with promise-coalescing refresh
- `src/main/providers/registry.ts` — orchestrator
- `src/main/aggregation/aggregator.ts` — SQL `GROUP BY` over `events` for today/7d/30d/per-provider/top-models/top-projects
- `src/shared/aggregates.ts` — output type for IPC
- `src/renderer/src/App.tsx` + `styles.css` — dropdown UI rendering real cost cards, per-provider rows, top-N tables, refresh button
- 5-min periodic refresh wired in main process

**Friction points:**
- npm `eslint-plugin-react-hooks@4.x` doesn't support eslint v9 → bumped to v5
- better-sqlite3 ABI flip dance (Node for tests vs Electron for runtime) — added `predev`/`rebuild:electron`/`rebuild:node` scripts
- Mid-build, `npm rebuild better-sqlite3` left the binary in a broken state once → uninstall+reinstall fixed it

**Result:** by morning, `npm run dev` showed the user's actual costs (~$85.47 lifetime, $39.74 today which was almost entirely the build session). 700 events stored, all three providers reporting. Snapshot fingerprint matched the SwiftUI version (`246413ab150e`) — cross-implementation determinism confirmed.

42/42 vitest cases green at this point.

---

## 2026-05-05 — Slices 1-5 (scaffold → SQLite)

Project pivoted from SwiftUI to Electron earlier in the session (user wanted Linux support; Swift doesn't ship there). `legacy-swift/` archived as a port reference.

Built across one session:
1. **Slice 1**: Electron scaffold via `electron-pro` subagent. Tray + frameless dropdown + ping/pong IPC.
2. **Slice 2**: TypeScript port of `ProviderIdentity` from the Swift version, with Vitest regression suite covering the negative cases (`protocol1-fast` !match `o1`, `metadata-model` !match `meta`, `metamorphic-v1` !match `meta`).
3. **Slice 3**: Canonical TS shapes for `UsageEvent`, `UsageSnapshot`, `UsageQuota`, `QuotaStatus`, `QuotaType`, `AIProvider`, `UsageProbe`, `ProbeError`. `bigint` micro-USD for cost, epoch-ms for timestamps.
4. **Slice 4**: `PricingTable` loader + lookup chain (exact → provider-prefixed → prefix sweep → keyword fallback → Sonnet fallback). Cost math returns `bigint`. Bundled `resources/pricing.json` (1.4 MB, 2,250 models). Renderer shows snapshot version + model count.
5. **Slice 5**: `better-sqlite3` v1 schema + migrations runner. `EventRepository` with prepared statements for upsert/select/range/sum/count. WAL journaling. `defaultSafeIntegers(true)` for bigint round-trip.

31 vitest cases green at this point. Snapshot fingerprint validated end-to-end at `246413ab150e`.

---

## 2026-05-04 — Phase 1 (research) + Phase 2 (architecture pivot)

User asked for a Claude-Code usage tracker. Studied 5 candidate repos via GitHub MCP (CodexBar 11.7k★, ClaudeBar 1.1k★, masorange ClaudeUsageTracker 112★, hamed Claude-Usage-Tracker 2.4k★, tokscale 2.6k★) plus LiteLLM as the pricing source. Wrote 5 per-repo notes + `research/SYNTHESIS.md`.

Decision (later revised same day): build new instead of fork — none of the candidates run on Linux. Originally SwiftUI; pivoted to Electron + TS when user said Linux was a hard requirement. `docs/architecture.md` D1–D15 written; legacy SwiftUI scaffold archived under `legacy-swift/`.

---
