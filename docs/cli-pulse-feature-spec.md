# CLI Pulse — Feature Spec (reverse-engineered)

**Source:** CLI Pulse Bar 1.12.0 (build 48), bundle ID `yyh.CLI-Pulse`, Mac App Store distribution.
**Method:** Static inspection of installed bundle + container files on a running install — `Info.plist`, entitlements, sandbox container, Group Container caches, Login Item helper bundle, `Localizable.strings`, `strings(1)` on the Mach-O. No dynamic instrumentation; no network capture. The Mach-O is not FairPlay-encrypted, so string extraction is reliable.
**Date captured:** 2026-05-07.
**Why this doc exists:** to mirror CLI Pulse's behavior in `llm-cost-monitor`. Local-only mode is the default target; cloud-sync features are documented separately so they can be skipped or added later.

> **Legal note.** This spec only describes observable external behavior — file layout, JSON shapes, public-but-undocumented API URLs. Don't lift the original developer's Sentry DSN, Supabase URL, or Supabase anon key from their `Info.plist` — register your own. Don't redistribute their binary or assets. Treat the undocumented Anthropic/Copilot/Warp/etc. endpoints below as fragile — they can change without notice.

---

## 1. One-line summary

A menu-bar app for macOS that aggregates **token usage, quota, and estimated cost across 26 AI coding tools** in one place — combining (a) on-device parsing of CLI session logs, (b) calls to each provider's private "remaining quota" endpoint using credentials already on disk, and (c) optional cloud sync to iPhone / Apple Watch / Android.

---

## 2. Process model

```
┌──────────────────────────────┐         ┌────────────────────────────┐
│ CLI Pulse Bar.app            │         │ CLIPulseHelper.app          │
│ (LSUIElement = true)         │         │ (Login Item, runs at login) │
│                              │         │                             │
│ • Menu-bar UI / Dashboard    │         │ • Background collector loop │
│ • Settings, alerts, billing  │ shared  │ • OAuth token refresh       │
└──────────────┬───────────────┘   ↓     └─────────────┬───────────────┘
               │            App Group:                 │
               │   ~/Library/Group Containers/         │
               │      group.yyh.CLI-Pulse/             │
               │   (claude_snapshot.json, …)           │
               ▼                                       ▼
        Both processes write & read the shared snapshot files.
```

- **Sandboxed** (`com.apple.security.app-sandbox`).
- Entitlements are **minimal**: `network.client`, `files.user-selected.read-write`, `files.bookmarks.app-scope`, `application-groups`. No full disk access, no Apple Events, no temporary-exception entitlements.
- File access to `~/.claude`, `~/.codex`, `~/.gemini`, etc. is granted by the user via an **NSOpenPanel** that scopes to the home folder (or per-tool folder), persisted as a **security-scoped bookmark** in `cli_pulse_provider_configs`.
- The helper is registered via `SMAppService` (Login Items), not `launchd`. It runs in its own sandbox with the same App Group.

**Equivalent in our Electron app:** main process = main app; a separate persistent process for the collector is optional. Rationale for them was: keep the menu-bar app responsive and let the collector keep running if user quits the bar. We can fold both into the main process for the MVP.

---

## 3. Provider matrix (26)

From `cli_pulse_provider_configs` in `~/Library/Containers/yyh.CLI-Pulse/Data/Library/Preferences/yyh.CLI-Pulse.plist`. Each entry has `kind`, `isEnabled`, `sourceMode` (`auto` is the default; modes are auto / oauth / file / cloud), `sortOrder`. Free plan keeps the user's most-used few; the rest become "Limited by free plan".

| # | `kind`        | Source path / endpoint                                                                                          | Method        |
|---|---------------|-----------------------------------------------------------------------------------------------------------------|---------------|
| 0 | Codex         | `~/.codex/auth.json` (creds), `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (usage)                            | local file    |
| 1 | Gemini        | `~/.gemini/oauth_creds.json` → Gemini OAuth (token refresh against Google)                                       | OAuth         |
| 2 | Claude        | `~/.claude/.credentials.json` → `https://api.anthropic.com/api/oauth/usage`; `~/.claude/projects/**/*.jsonl`     | OAuth + file  |
| 3 | Cursor        | (not extracted — likely cookies / dashboard scrape)                                                              | cloud         |
| 4 | OpenCode      | local CLI logs                                                                                                  | local file    |
| 5 | Droid         | local CLI logs                                                                                                  | local file    |
| 6 | Antigravity   | local CLI logs                                                                                                  | local file    |
| 7 | Copilot       | `https://api.github.com/copilot_internal/user`                                                                  | private API   |
| 8 | z.ai          | `api.z.ai`                                                                                                       | API key       |
| 9 | MiniMax       | `api.minimax…`                                                                                                   | API key       |
| 10 | Augment      | `app.augmentcode.com`                                                                                            | cloud         |
| 11 | JetBrains AI | (not extracted)                                                                                                  | cloud         |
| 12 | Kimi K2      | (not extracted)                                                                                                  | cloud / file  |
| 13 | Amp          | (not extracted)                                                                                                  | cloud         |
| 14 | Synthetic    | (not extracted)                                                                                                  | cloud         |
| 15 | Warp         | `https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo`                                                        | private API   |
| 16 | Kilo         | `~/.local/share/kilo/auth.json` → `https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState?batch=1` | OAuth         |
| 17 | Ollama       | `http://localhost:11434` (local model server)                                                                    | local API     |
| 18 | OpenRouter   | `openrouter.ai` API                                                                                              | API key       |
| 19 | Alibaba      | `…/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2` | private API |
| 20 | Kimi         | (separate from Kimi K2)                                                                                          | cloud         |
| 21 | Kiro         | `kiro` CLI auth                                                                                                  | local file    |
| 22 | Vertex AI    | `console.cloud.google.com`                                                                                       | cloud         |
| 23 | Perplexity   | API                                                                                                              | API key       |
| 24 | Volcano Engine | (Bytedance / Doubao) `/v1/api/openplatform/coding_plan/remains`                                                | private API   |
| 25 | GLM          | `/v1/coding_plan/remains`                                                                                        | private API   |

Rows marked "(not extracted)" need follow-up — either re-strings against helper Mach-O or runtime mitmproxy. They are not blocking our MVP.

**There are also `claude_session.json` and `gemini_tokens.json` references** — CLI Pulse caches refreshed bearer tokens in the Group Container so the helper doesn't have to re-do OAuth every poll.

---

## 4. The Claude data path (most important)

CLI Pulse uses **two independent sources** for Claude and reconciles them:

### 4.1 OAuth quota source — `https://api.anthropic.com/api/oauth/usage`

- Reads `~/.claude/.credentials.json` (the same file `claude` CLI writes after `/login`) to get the access token.
- Hits the OAuth-protected `usage` endpoint.
- Response is normalized into `claude_snapshot.json` (Group Container):

  ```jsonc
  {
    "source": "oauth",
    "fetched_at": "2026-05-04T22:05:17Z",
    "session_used": 5,                 // 5h rolling window, count out of 100
    "session_reset": "2026-05-05T01:40:00.334063+00:00",
    "weekly_used": 0,                  // weekly tier, count out of 100
    "weekly_reset": "2026-05-11T11:00:00.334084+00:00",
    "sonnet_used": 0,                  // Sonnet-only tier
    "extra_tiers": [
      { "name": "Designs",        "used": 0, "reset": null },
      { "name": "Daily Routines", "used": 0, "reset": null }
    ],
    "extra_usage": {                   // pay-as-you-go credit pool
      "is_enabled": true,
      "currency": "USD",
      "monthly_limit": 10000,          // dollars × 100, i.e. $100.00
      "used_credits": 0
    }
  }
  ```

- Five tiers as observed: **5h Window**, **Weekly**, **Sonnet only**, **Designs**, **Daily Routines**. Each is a 0–100 percentage. The `extra_*` fields are forward-compatible (server can add tiers without an app update).
- Companion file `claude_account.json` is small and only stores `weekly_reset` + `fetched_at`.
- The resolver log (`Data/tmp/clipulse_claude_resolver.log`) shows it polls roughly every 1–3 minutes when active and uses freshness logic: `helper=snapshot: exists, age=109s, liveFresh=true, cacheFresh=true`. Implies two staleness windows — `liveFresh` (< ~2 min, skip network) and `cacheFresh` (< ~30 min, can serve UI from cache while refreshing).

> ⚠ This endpoint is undocumented. Anthropic could change/rate-limit it. Treat as best-effort and degrade gracefully (`status.degraded` UI state).

### 4.2 Local file source — `~/.claude/projects/**/*.jsonl`

The same `.jsonl` files our existing parser already reads. CLI Pulse incrementally tails them and keeps a per-file mtime+parsedBytes cache at:

```
~/Library/Containers/yyh.CLI-Pulse/Data/Library/Caches/CLIPulse/cost-usage/claude-v2.json
```

Schema (from a real cache):

```jsonc
{
  "version": 1,
  "lastScanUnixMs": 1778031295203,
  "files": {
    "/Users/.../<uuid>.jsonl": {
      "size": 60027,
      "parsedBytes": 60027,                  // resume offset for tail
      "mtimeUnixMs": 1777928841059,
      "days": {
        "2026-05-04": {
          "claude-sonnet-4-20250514": [12, 22531, 11558, 3462, 102067800, 0],
          "claude-opus-4-1":          [8,  51400, 18631, 6,    427001250, 0],
          "__claude_msg__":           [0,  0,     0,     0,    0,         31]
        }
      }
    }
  },
  "days": { /* aggregated rollup, same per-model arrays */ }
}
```

- The 6-int per-day-per-model array — based on the values seen and Claude's API surface — almost certainly maps to `[messages_or_requests, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, msg_count]`. Validate empirically before trusting absolute numbers; the **last slot is always 0 except in the `__claude_msg__` synthetic key**, where only the last slot is populated, suggesting it counts plain "user message" events that don't have token usage attached.
- Similar Codex schema at `cost-usage/codex-v2.json`:

  ```jsonc
  "lastTotals": { "input": 466606, "cached": 433152, "output": 3678 },
  "days": { "2026-05-04": { "gpt-5.5": [466606, 433152, 3678] } }
  ```

  Codex uses 3-int arrays `[input, cached, output]`. Simpler because Codex sessions have stable total fields per session.

- The cache uses `parsedBytes` as a resume offset — when the file grows, only the tail is parsed. Our existing chokidar-tail design matches this.

### 4.3 Reconciliation

- The OAuth source gives **subscription-quota** truth (5h / weekly / etc.) — this is what gets shown as percentage gauges in the menu bar.
- The local source gives **token-level cost** truth (per-model / per-project / forecasts) — this is what's shown on the Dashboard's "Cost Today / 30 Day Est." cards.
- The two are not added; they answer different questions. Quota = how much of Claude's plan is left. Cost = what a paid-API user would pay for the same usage.

---

## 5. Storage layout (what we should mirror)

| Path                                                                                      | Purpose                                       |
|-------------------------------------------------------------------------------------------|-----------------------------------------------|
| `~/Library/Containers/yyh.CLI-Pulse/Data/Library/Preferences/yyh.CLI-Pulse.plist`          | UserDefaults (settings)                       |
| `~/Library/Containers/yyh.CLI-Pulse/Data/Library/Caches/CLIPulse/cost-usage/<provider>-v2.json` | Per-provider local-file token cache    |
| `~/Library/Containers/yyh.CLI-Pulse/Data/tmp/clipulse_claude_resolver.log`                 | Quota resolver log (one line per poll)        |
| `~/Library/Containers/yyh.CLI-Pulse/Data/tmp/clipulse_collector_errors.log`                | Background collector errors                   |
| `~/Library/Group Containers/group.yyh.CLI-Pulse/claude_snapshot.json`                      | Latest quota snapshot (cross-process)         |
| `~/Library/Group Containers/group.yyh.CLI-Pulse/claude_account.json`                       | Account-level summary                         |
| Keychain (`com.anthropic.claude.nativehost`, etc.)                                         | API keys & cookies — **never written to disk**|

**For our Electron app**, the analogous tree under `~/Library/Application Support/llm-cost-monitor/` (or XDG dirs on Linux) should keep:
- a `cache/cost-usage/<provider>-v2.json` per provider,
- a `state/<provider>_snapshot.json` for live-quota,
- log files in `logs/`,
- everything else in our existing SQLite (we already have this).

---

## 6. Settings schema (UserDefaults)

Observed keys in `yyh.CLI-Pulse.plist` and what they map to in the UI:

| Key                                              | Type     | UI label                          |
|--------------------------------------------------|----------|-----------------------------------|
| `cli_pulse_demo_mode`                             | Bool     | "Try Demo" — populates fake data  |
| `cli_pulse_hide_personal_info`                    | Bool     | Settings → Advanced → "Hide email addresses in the UI" |
| `cli_pulse_locale_override`                       | String   | Settings → Language               |
| `cli_pulse_onboarding_completed`                  | Bool     | (internal)                         |
| `cli_pulse_previous_alert_ids_v1`                 | [String] | Suppression of seen alerts        |
| `cli_pulse_previous_alert_suppression_keys_v1`    | [String] | Suppression keys                  |
| `cli_pulse_provider_configs`                      | Data (JSON-bytes) | Settings → Manage Providers (per-row: kind, isEnabled, sourceMode, sortOrder) |
| `cli_pulse_provider_secrets_migrated`             | Bool     | (one-time keychain migration)      |
| `cli_pulse_refresh_interval`                      | Int (s)  | Settings → "Refresh Cadence" — default **600** |
| `cli_pulse_webhook_enabled`                       | Bool     | Settings → Integrations → Webhook |

**Threshold settings** (from `Localizable.strings` — keys prefixed `settings.`):
- `quota_alert_thresholds` — list of percent thresholds (warning + critical).
- `warning_threshold_pct` — currently a single int %.
- `cli_pulse_refresh_interval` is enforced helper-side; UI shows "Last refresh".

---

## 7. UI surfaces

### 7.1 Menu-bar dropdown

Five **display modes** (`display.mode`) for the menu bar icon:
- `display.icon` — just the icon
- `display.most_used` — % of the most-used provider
- `display.pace` — burn rate
- `display.percent` — total quota %
- merge mode (`display.merge_menu_bar_icons`) — single icon with dropdown switcher; vs separate icons per provider

Status pill: `status.online` / `status.degraded` / `common.offline`.

Tier-migration banner: when downgrading from Pro to Free — `"Kept your %d most-used providers to fit the free plan. Disabled %d — edit in Settings → Providers."` Useful pattern even for a free-only build, as a "select up to N visible providers" option.

### 7.2 Dashboard tab

Cards observed (`dashboard.*` strings):
- **Usage Today** — token totals, with `cost.tokens_value` formatter
- **Cost Today** — $ total, "Estimated" or "Exact" badge
- **30 Day Est.** — forecast (see §9)
- **Active Sessions** — count of live CLI sessions in last N minutes
- **Subscription Utilization** — the per-tier 0–100 gauges (Claude only for now)
- **Provider Usage** — sortable list with `By Model` toggle
- **Top Projects** — top N by cost/tokens
- **Activity** — recent events / requests
- **Risk Signals** — anomaly hints (spike, model swap, etc.)
- **Alerts** — unresolved alerts widget
- **Devices** — paired devices status
- **Server Online/Offline** — Supabase reachability (omit in local-only)

Export menu: PDF report, Cost report, Providers CSV, Sessions CSV.

### 7.3 Settings

Tabs/sections (from string prefixes):
- **General** — language, refresh cadence, display mode, hide emails
- **Manage Providers** — list of `kind`s with toggle + source mode + sort order; "Configure data source, credentials, and display for each provider."
- **CLI Tool Access** (`folder_access.*`) — grant home or per-folder read access; "Grant All at Once" picks home; per-tool "Granted / Not installed / Force Rescan" rows. "Rebuild from scratch if totals look wrong" → user-triggered cache nuke.
- **Alerts** — quota alert thresholds, warning %, snooze, severities (warning/critical)
- **Integrations** — webhook URL (Discord/Slack/custom), event filter (providers/severities/types), Test Webhook
- **Account** — sign-in providers (Apple/Google/GitHub/email-code), linked accounts, delete account (typed `DELETE` confirm)
- **Subscription** — Free / Pro / Team badges; yearly save 17%; Pro features: extended history, unlimited devices, shared alerts & rules
- **Advanced**
  - "Launch at login" (toggles SMAppService helper)
  - "Background sync" — *Pro / cloud feature*; "Syncs usage data to cloud for iOS/Watch/Android"
  - "Track git activity (Yield Score)" — opt-in; **only commit hash + HMAC(project_path) + timestamp + merge-flag** uploaded; messages/diffs/files/author never leave device
  - "Remote Control" — opt-in; "Approve Claude tool calls from your iPhone or Mac · default off" (Phase 1)
- **About** — version, "Report an Issue", GitHub link

### 7.4 Onboarding

Multi-step wizard (`onboarding_wizard.*`, `onboarding.*`):
1. Welcome / "What CLI Pulse does"
2. **Set Up Background Helper** — register Login Item, sign in (Apple / Google / GitHub / email-code / password). Email-code is the fallback that doesn't require a third-party.
3. **Grant CLI Tool Access** — single panel that asks for home folder so all CLI cred files become accessible at once
4. **Check Sync Status** — confirm Supabase reachability (skip in local-only build)
5. **Use Local Mode** — alternative path: "Show usage from this Mac only. Sign in later to sync across devices."

Local Mode is a first-class feature — exactly what we want. The `Local Mode is ready` body string is template gold:

> *"Use Claude Code, Codex, Ollama, or another AI tool on this Mac and your usage appears here automatically. Sign in any time from Settings to sync this data to iPhone."*

---

## 8. Alerts engine

Strings imply a rule-based engine. Observed primitives:
- **Severity:** `warning`, `critical`.
- **Lifecycle:** Open → Ack(nowledge) → Snooze (`%d minutes`) → Resolve. `Resolve All` action exists. Suppression of repeating alerts via `cli_pulse_previous_alert_ids_v1`.
- **Filtering** (Integrations): by providers, severities, alert types — same filter shape governs which alerts trigger webhooks.
- **Quota thresholds:** percent-based; warning + critical.
- **Webhook payload destinations:** Discord, Slack, "custom endpoint". Backend route on Supabase: `/functions/v1/send-webhook` — meaning the cloud relays webhooks (so user URLs are not stored on each Mac). For local-only build, send directly from the app.

**Alert types we should support at minimum (MVP):**
1. `quota.threshold_crossed` — `<provider>` crossed `<%>` of `<tier>` window
2. `quota.window_reset` — informational, when 5h/weekly resets
3. `cost.daily_budget_exceeded` — local $ budget setting
4. `provider.collector_error` — degraded source for > N minutes
5. `cli_helper.disconnected` — helper not running

---

## 9. Forecast / cost projection

`forecast.*` strings:
- **Spent So Far** (current month-to-date)
- **Month-End Estimate**
- **Confidence Range**
- "Need more data for forecast" — gating threshold (need ≥ N days of data).

The simplest implementation matching the UI: linear projection from MTD ÷ days-elapsed × days-in-month, with a Wilson-style or stddev-based ± band. Doesn't need to be sophisticated.

---

## 10. Privacy model (very explicit in the strings — adopt verbatim)

```
ON-DEVICE ONLY
  • Provider API keys & cookies   → macOS Keychain, never uploaded
  • Session logs                  → scanned on-device via folder bookmarks

UPLOADED (only if user signs in & enables sync)
  • Login email                   → auth backend
  • Usage metrics                 → token counts, cost, model names
  • Git tracking (Yield Score)    → commit hash + HMAC(project_path) + timestamp + is_merge
                                    NEVER: messages, diffs, paths, author
```

For our local-only MVP, only the first block applies. We should still surface this trust statement on the Settings → Advanced → Privacy panel, because users coming from CLI Pulse will look for it.

---

## 11. Subscription tiers (skip for MVP, document for context)

- **Free** — limited number of providers (the "Kept your N most-used providers" migration string), local + on-device only by default.
- **Pro** (`subscription.pro_description = "Advanced monitoring with extended history"`) — extended history, unlimited devices, shared alerts & rules, mobile companions, remote tool approvals, webhooks (likely gated).
- **Team** (`team.make_member`) — shared alerts across team members.
- Yearly billing: "Save 17%". StoreKit (`SKTransactionUpdatesLastChecked` in defaults). Receipt validation via Supabase Edge Function `/functions/v1/validate-receipt`.

**Recommendation:** for `llm-cost-monitor`, skip tiering. Make all features available locally; add a donate link instead of a paywall. (Their Pro features mostly require their cloud anyway.)

---

## 12. Cloud features (skip unless we're building sync — separate roadmap)

If you ever add cloud sync, the Supabase shape they use is:

| Endpoint                                          | Purpose                                     |
|---------------------------------------------------|---------------------------------------------|
| `/auth/v1/token?grant_type=password`              | Email + password sign-in                    |
| `/auth/v1/token?grant_type=id_token`              | Apple / Google / GitHub OAuth               |
| `/auth/v1/token?grant_type=pkce`                  | OAuth PKCE                                   |
| `/auth/v1/token?grant_type=refresh_token`         | Refresh                                      |
| `/auth/v1/user/identities/`                       | Linked-accounts management                   |
| `/rest/v1/profiles?id=eq.<uid>`                   | Profile row                                  |
| `/rest/v1/devices?user_id=eq.<uid>`               | Paired devices                               |
| `/rest/v1/sessions?user_id=eq.<uid>`              | Synced session metadata                      |
| `/rest/v1/user_settings?user_id=eq.<uid>`         | Per-user settings (alerts, thresholds)       |
| `/rest/v1/alerts?user_id=eq.<uid>`                | Active alerts                                |
| `/rest/v1/provider_quotas`                        | Latest per-provider quota rows               |
| `/rest/v1/yield_score_daily?user_id=eq.<uid>`     | Daily git-yield rollup                       |
| `/rest/v1/pairing_codes`                          | Cross-device pairing flow                    |
| `/rest/v1/rpc/get_daily_usage`                    | Aggregated read                              |
| `/rest/v1/rpc/upsert_daily_usage`                 | Write (idempotent merge)                     |
| `/rest/v1/rpc/delete_user_account`                | Account deletion                             |
| `/functions/v1/send-webhook`                      | Cloud-side webhook relay                     |
| `/functions/v1/validate-receipt`                  | App Store receipt validation                 |

This implies daily-grain rollups in cloud (not raw events — privacy + cost). Mirror that grain if you ever sync.

---

## 13. Things we get right out of the box vs. what's new

What `llm-cost-monitor` already covers (per `plan.md`):
- ✅ Local parsing of `~/.claude/projects/*.jsonl` + `~/.codex/sessions/**.jsonl` + Gemini
- ✅ SQLite event store
- ✅ Per-model and per-project breakdown
- ✅ 5-min periodic refresh
- ✅ Local-only by design

**Net-new features to take from CLI Pulse**, in suggested order:

| Priority | Feature                                              | Effort | Notes                                            |
|---------:|------------------------------------------------------|--------|--------------------------------------------------|
| P1 | **Claude OAuth quota source** (`/api/oauth/usage`)        | M      | Read `~/.claude/.credentials.json`, refresh, hit endpoint. Cache 60 s. Adds tier gauges. |
| P1 | **Per-provider mtime+offset cache** (`<provider>-v2.json`) | S      | We already tail; just persist the resume offset to survive restarts.                     |
| P1 | **Folder-grant + scoped bookmark UX**                     | M      | macOS-only; on Linux just ask for read perm. Give "Grant All at Once" via `$HOME` picker. |
| P1 | **Display modes for menu bar** (icon/percent/pace/most-used) | S   | Already partially in our menu UI.                |
| P2 | **Quota thresholds + alert engine** (warning/critical)    | M      | Local-only first; webhook later.                 |
| P2 | **Forecast card** (MTD spend → month-end ± range)         | S      | Trivial linear with stddev band.                 |
| P2 | **Webhook out** (Discord/Slack/custom)                    | S      | Direct POST; allow user to test.                 |
| P2 | **Local Mode onboarding**                                 | S      | Adapt their copy.                                |
| P3 | **Codex / Gemini parity for OAuth-side quotas**           | M      | Codex doesn't expose a "remaining" endpoint publicly — skip; Gemini has one. |
| P3 | **Provider expansion: Copilot, Warp, Kilo, Ollama**      | M each | Each is one private endpoint + mapping.          |
| P3 | **Yield Score / git activity**                            | L      | Nice-to-have; design from scratch with their privacy posture (HMAC project paths). |
| P4 | **Cloud sync**                                            | XL     | Out of scope unless we change goals.             |
| P4 | **Mobile companions**                                     | XL     | Out of scope.                                    |

---

## 14. Open questions / verification still needed

1. **Exact 6-tuple semantics in `claude-v2.json`** — need to feed a known JSONL through CLI Pulse's parser and ours, and diff. My `[messages, in, out, cache_create, cache_read, msg_count]` mapping is an inference, not a quote.
2. **Authentication shape for `/api/oauth/usage`** — confirm whether it's Bearer-only or also requires the device-id header that `claude` CLI sends. Easiest to test via `mitmproxy` while CLI Pulse refreshes.
3. **OAuth refresh flow for Claude** — is the helper using the same refresh endpoint as the CLI, or its own? `claude_session.json` exists but contents not inspected here.
4. **Source mode `cloud` vs `oauth` vs `file` vs `auto`** — only `auto` observed in our preferences; the other modes are inferred from the resolver log's `sourceMode=auto` field. Try toggling each in CLI Pulse to see what the values become.
5. **Codex "rollout" file format vs SDK's `usage` field** — `lastTotals.input/cached/output` mapping is from the cache structure; verify it matches the actual `usage` JSON line in a fresh session log.
6. **Helper's exact poll cadence** — observed range 60–300 s; whether it's `cli_pulse_refresh_interval` or hard-coded is unverified.

---

## 15. Reproduction steps (for someone validating this doc)

```bash
# 1. Locate
mdfind "kMDItemCFBundleIdentifier == 'yyh.CLI-Pulse'"

# 2. Bundle
plutil -p "/Applications/CLI Pulse.app/Contents/Info.plist"
codesign -d --entitlements - "/Applications/CLI Pulse.app"

# 3. Settings
plutil -p ~/Library/Containers/yyh.CLI-Pulse/Data/Library/Preferences/yyh.CLI-Pulse.plist

# 4. Live snapshot
cat ~/Library/Group\ Containers/group.yyh.CLI-Pulse/claude_snapshot.json
cat ~/Library/Group\ Containers/group.yyh.CLI-Pulse/claude_account.json

# 5. Local token cache
cat ~/Library/Containers/yyh.CLI-Pulse/Data/Library/Caches/CLIPulse/cost-usage/claude-v2.json
cat ~/Library/Containers/yyh.CLI-Pulse/Data/Library/Caches/CLIPulse/cost-usage/codex-v2.json

# 6. Resolver log (one line per quota poll)
tail -100 ~/Library/Containers/yyh.CLI-Pulse/Data/tmp/clipulse_claude_resolver.log

# 7. Localized strings (UI label dictionary)
plutil -convert json -o - \
  "/Applications/CLI Pulse.app/Contents/Library/LoginItems/CLIPulseHelper.app/Contents/Resources/CLIPulseCore_CLIPulseCore.bundle/Contents/Resources/en.lproj/Localizable.strings"

# 8. Endpoints baked into the binary
strings -a "/Applications/CLI Pulse.app/Contents/MacOS/CLI Pulse Bar" \
  | grep -E "https?://|/v1/|/auth/v1/" | sort -u
```

For dynamic verification (Claude OAuth endpoint shape, header set, response schema):
- `mitmproxy` with the system trust store + `mitmproxy-ca-cert` installed in macOS Keychain.
- Quit CLI Pulse, set `https_proxy=http://127.0.0.1:8080`, relaunch — ATS will allow it because `NSAllowsLocalNetworking` is true in the Info.plist. (Sandbox network entitlement is `network.client`, which is fine with a system proxy.)
