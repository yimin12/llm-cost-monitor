# memory — llm-cost-monitor

_last updated by Claude on 2026-05-11, branch `worktree-web-api`, commit `87f9df4`_

## Goal

User opened the WebDashboard in a browser and saw different numbers from the tray app. PR #13 fixes this by standing up a loopback HTTP server in main process so the browser-served renderer sees real data instead of `browser-stub.ts` demo fixtures.

## State

- **Branch:** `worktree-web-api` (worktree at `.claude/worktrees/web-api/`)
- **PR #13:** https://github.com/yimin12/llm-cost-monitor/pull/13 — OPEN, MERGEABLE, CLEAN
- **App running:** background bash id `b02s5ih9u`, port 5173 (renderer), 4018 (loopback API)
- **Validated end-to-end:** `curl http://127.0.0.1:4018/v1/aggregates` returns real data with BigInt-as-string tagging. `/v1/yield-score?period=30d` → `enabled: true, commits: 364, repos: 2`
- **172/172 tests pass · typecheck · lint clean** as of `87f9df4`

## Decisions

- **JSON wire format for bigint:** `bigint` → `"<digits>n"` string via `JSON.stringify` replacer. Browser stub uses matching reviver. Renderer consumes real `bigint` regardless of transport (Electron IPC structured-clone or HTTP).
- **CORS = `*`** because the server binds to `127.0.0.1` only — no LAN attack surface. Was originally `http://localhost:5173`; user's Chrome was opening at `http://127.0.0.1:5173` causing silent CORS reject → fallback to fake data → "blank" symptom.
- **Read-only HTTP surface.** Mutations stay on Electron IPC. The loopback server intentionally has no POST/PUT/DELETE.
- **`buildYieldSnapshot` extracted** to `src/main/git/yield-snapshot.ts` so the IPC handler and HTTP handler can't drift (commit `87f9df4`).

## Open questions

- User asked "你有写log吗在每次提交之后" → I admitted no, offered to backfill a `docs/build-log.md` entry covering PRs #10-13 from 2026-05-10/11. They said "context is running out, persist + commit" — **I interpreted this as a yes to backfilling AND wanting me to commit it.** If they meant only persist memory.md, the build-log commit is the wrong action.
- WebDashboard's browser tab still needs a **hard-refresh** for the CORS fix (`12d46c5`) to take effect — old JS bundle may be cached.

## Files in play

- `src/main/web-api/web-api-server.ts` — loopback HTTP server (PR #13, this branch)
- `src/main/git/yield-snapshot.ts` — extracted helper (this branch)
- `src/main/ipc.ts` — IPC handler now calls `buildYieldSnapshot`
- `src/renderer/src/browser-stub.ts` — `getReal()` wraps every read-only method
- `src/main/index.ts` — starts both Electron tray + `startWebApiServer`
- `docs/build-log.md` — last entry 2026-05-08; **2026-05-10/11 backfill needed** covering PRs #10/#11/#12/#13

## Bug fixes shipped this turn (the "blank page" debugging)

1. `7f9814c` — `await providers.describe()` (was Promise → `{}` → crash)
2. `12d46c5` — CORS `*` instead of hardcoded `localhost:5173`
3. `87f9df4` — DRY: extract `buildYieldSnapshot`

## Next action

Backfill `docs/build-log.md` entry for **2026-05-10/11** covering PR #10 (Google OAuth bundling), PR #11 (i18n + footer + Gemini Pro detection + Yield Score + KpiTile + WebDashboard simplification + much more), PR #12 (WebDashboard everything + Overview/Team page split), PR #13 (loopback HTTP server, this PR). Commit + push as part of `worktree-web-api`.
