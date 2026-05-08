# hamed-elfayome/Claude-Usage-Tracker — research note

**Repo:** https://github.com/hamed-elfayome/Claude-Usage-Tracker — 2.4k★, MIT.
**Stack:** SwiftUI menubar app, Xcode project (not SPM). Layout under `Claude Usage/` (note the space): `App/`, `MenuBar/`, `Views/`, `Resources/`, `Shared/{Services, Models, Protocols, Storage, Managers, Localization, Extensions, Utilities, ErrorHandling}`.

The most polished menubar app of the bunch — comprehensive feature set (notifications, profiles, multi-account, peak-hours analysis, statusline integration, network logging) at the cost of being big (`ClaudeAPIService.swift` is 47 KB; `StatuslineService.swift` is 40 KB). For us this is the reference for **product surface area**: what features users actually want once the basics work.

## Where usage data comes from

Three sources, distinct roles:

1. **Claude Code session JSONL** (`Shared/Services/ClaudeCodeSyncService.swift`, 30 KB) — same `~/.claude/projects/**/*.jsonl` pattern as masorange/ClaudeBar. Used for "code" usage.
2. **Anthropic Console API** (`Shared/Services/ClaudeAPIService.swift` 47 KB + `+ConsoleAPI.swift` 12 KB + `+Types.swift` 4.7 KB) — authoritative spend numbers. Requires API key in keychain (`KeychainService.swift` 6.7 KB).
3. **Claude Code statusline integration** (`Shared/Services/StatuslineService.swift`, 40 KB) — generates statusline output that Claude Code displays inside the terminal session. Bidirectional integration: app reads usage, then writes a custom status line with cost/tokens/budget. **This is unique to hamed.** Claude Code's `statusline` config calls a script that talks to this app via a local file/socket.

`Shared/Services/AutoStartSessionService.swift` (19 KB) wires up live-session detection — likely the file watcher that maps active Claude Code processes to this app.

## Live-session tracking

`HeartbeatService.swift` (2 KB) + `AutoStartSessionService.swift` (19 KB) cooperate. Heartbeat is small — likely a periodic timer. Auto-start is bigger — it's where live JSONL → "current session" translation happens.

`StatuslineService.swift` is the killer feature: it pipes "current cost, current model, current %context" *into* Claude Code's terminal status line via Claude Code's `statusline` hook script. Users see live cost without alt-tabbing to the menu bar. Worth stealing if we want the "always visible" UX without committing the menubar title space.

## Pricing

Didn't fully read; very likely the same hardcoded model dict + Console-API authoritative override. The `ClaudeAPIService` structs in `+Types.swift` decode Anthropic's billing endpoints, so when an API key exists, hamed prefers vendor-reported spend over local computation.

## Storage

- `Shared/Storage/` directory (didn't drill in but exists)
- `Shared/Services/UsageHistoryService.swift` (14 KB) — likely SQLite or Core Data for history
- `KeychainService.swift` for credentials
- `Shared/Services/ProfileManager.swift` (21 KB) — multi-profile support (work/personal/team)
- `MigrationService.swift` (3 KB) and `KeychainMigrationService.swift` (5 KB) — explicit migrations between versions

## UI pattern

Distinctive elements:
- **`MenuBarIconConfig.swift`** (15 KB) — heavy customization of the menubar icon (color, content, format). Suggests users care about how it looks and want options.
- **`PeakHoursService.swift`** (3.5 KB) — analyzes when user is most productive / most expensive.
- **`StatuslineColorMode.swift`**, **`StatuslineElementColors.swift`** — per-element coloring inside Claude Code's status line.
- **`NotificationManager.swift`** (18 KB) — budget alerts, daily summaries, etc.
- **`NetworkLoggerService.swift`** (5.7 KB) + **`NetworkRequestLog.swift`** — captures Claude API HTTP traffic for debugging. Power-user feature.
- **`UpdateManager.swift`** + **`GitHubService.swift`** (3.5 KB) — checks GitHub releases for self-update.
- **Profiles** with display modes — work vs personal Claude accounts treated as first-class.

## Steal

1. **Statusline integration via Claude Code's `statusline` hook** — write a small script we ship with the app; users wire it into `~/.claude/statusline.sh` (or whatever Claude Code expects). Surfaces `today $cost / context X% / model Y` *inside* the terminal — huge UX win, no menubar real estate needed.
2. **Profiles** as a first-class concept, not just an account filter. Lets users keep a "work" Vertex Claude separate from "personal" subscription Claude in one app.
3. **Heartbeat + AutoStart pattern** for live-session detection.
4. **Notification surface** — budget alerts (80%/100% of monthly cap) at a minimum. Daily summary is a nice-to-have.
5. **Authoritative spend override**: when an Anthropic API key is configured, prefer Console-API numbers over local-computed cost. Keep our token×price math as the offline default.
6. **`UsageHistoryService` as a dedicated SQLite layer** — separation between "raw events" and "history" makes cleanup/retention policies easier.
7. **Sparkle-style update flow via GitHub releases** — works without an MAS / paid Apple Developer account.

## Skip

1. **NetworkLoggerService** — tempting but a privacy/storage liability. Defer to debug builds only or skip.
2. **PeakHoursService** — cute, low value. Stretch goal.
3. **47 KB single-file Swift services.** Hamed's services are too big; keep ours under ~10 KB each.
4. **Multiple migration layers** — premature for an MVP.

## Source file index

| File | Size | Role |
|---|---|---|
| `Shared/Services/ClaudeCodeSyncService.swift` | 30 KB | JSONL parser/sync (analog of masorange's `ClaudeUsageManager`) |
| `Shared/Services/ClaudeAPIService.swift` | 47 KB | Anthropic Console API client |
| `Shared/Services/ClaudeAPIService+ConsoleAPI.swift` | 12 KB | Console-API endpoints |
| `Shared/Services/ClaudeAPIService+Types.swift` | 4.7 KB | Console-API response shapes |
| `Shared/Services/StatuslineService.swift` | 40 KB | **Claude Code statusline integration — the killer feature** |
| `Shared/Services/AutoStartSessionService.swift` | 19 KB | Live-session detection |
| `Shared/Services/HeartbeatService.swift` | 2 KB | Periodic heartbeat |
| `Shared/Services/UsageHistoryService.swift` | 14 KB | History storage (likely SQLite) |
| `Shared/Services/NotificationManager.swift` | 18 KB | Budget alerts + summaries |
| `Shared/Services/ProfileManager.swift` | 21 KB | Multi-profile / multi-account |
| `Shared/Services/KeychainService.swift` | 6.7 KB | Credential storage |
| `Shared/Models/ClaudeUsage.swift` | 3.3 KB | Domain model |
| `Shared/Models/UsageHistory.swift` | 9.7 KB | History model |
| `Shared/Models/MenuBarIconConfig.swift` | 15 KB | Icon customization |
| `Shared/Models/StatuslineColorMode.swift`, `StatuslineElementColors.swift` | small | Statusline theming |
| `Claude Usage/MenuBar/` | dir | Menubar UI |
| `Claude Usage/Views/` | dir | Settings / About / etc. |
