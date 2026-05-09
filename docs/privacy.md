# Privacy

Mirrors the structure of CLI Pulse Bar's privacy panel (see [`docs/cli-pulse-feature-spec.md`](./cli-pulse-feature-spec.md) §10) so users coming from there find the same trust statement in the same place. Adopted verbatim where applicable.

## What stays on this Mac

```
ON-DEVICE ONLY
  • Session logs                  → ~/.claude, ~/.codex, ~/.gemini scanned in
                                    place via the user's filesystem permissions.
                                    Tokens, model names, timestamps, project
                                    paths — all stay local.
  • Computed cost events          → Postgres (dev) at 127.0.0.1:5433, or SQLite
                                    (shipped builds) under app data. Never
                                    network-exposed.
  • Refresh token (if signed in)  → encrypted via Electron `safeStorage` (macOS
                                    Keychain / Linux libsecret / Windows DPAPI),
                                    stored as `refresh-token.bin` under
                                    app data, mode 0o600.
  • OAuth client secrets          → loaded from `~/.env` at launch by the main
                                    process; never crosses IPC to the renderer;
                                    never logged.
```

## What leaves this Mac

```
SIGN-IN ROUND-TRIP (only when you press "Sign in with Google")
  • OAuth /authorize call         → google.com, with your client_id, the
                                    scopes (openid + email + profile), and
                                    a PKCE code_challenge.
  • OAuth /token exchange         → oauth2.googleapis.com, with the auth code
                                    + PKCE verifier. Returns id_token +
                                    access_token + refresh_token.
  • JWKS fetch                    → www.googleapis.com/oauth2/v3/certs, to
                                    verify the id_token signature.
  • Silent refresh on launch      → oauth2.googleapis.com /token with the
                                    stored refresh_token. Identical content
                                    to a normal /token call.
```

That's it. No usage metrics, no token counts, no model names, no project paths
ever leave this Mac. The Google round-trips above carry only what's needed to
verify your identity.

## Optional: pricing snapshot refresh

`Scripts/refresh-pricing.sh` (run by you, not at runtime) fetches the latest
LiteLLM pricing JSON. The fetch is anonymous (no headers identify you) and the
response is committed to the repo as `resources/pricing.json`. CI runs this
nightly when configured.

## What we do not do (and never will, on this branch)

- No telemetry pings.
- No analytics SDKs (Mixpanel / PostHog / Sentry / Datadog).
- No crash reports phoned home.
- No usage data uploaded to a backend, ours or anyone else's.
- No multi-device sync (cloud sync is documented in CLI Pulse §12 as a
  reference architecture but explicitly out of scope here).

If those scope changes ever happen, they'll land in a clearly-named slice with
this doc updated alongside.

## Sign in / sign out semantics

- **Signing out** wipes both the encrypted refresh token (file deleted) and
  flips the active `auth_user` row's `is_active` to FALSE in Postgres. The
  row is preserved in case you sign in again with the same Google account.
  (Your local cost data is **not** deleted on sign-out — it's yours,
  independent of Google identity.)
- **Revoking the OAuth grant from your Google account** (via myaccount.google.com
  → Security → Third-party apps) makes our refresh token unusable. Next launch,
  the silent restore fails, the bad token is wiped, and the dropdown shows
  "Sign in with Google" again.

## How to verify this in 30 seconds

```bash
# 1. Confirm no network calls beyond the OAuth round-trips during normal use.
#    Run while clicking around the app:
sudo tcpdump -i any -nn host !127.0.0.1 and not host accounts.google.com \
  and not host oauth2.googleapis.com and not host www.googleapis.com

# 2. Confirm the refresh-token file is encrypted (you cannot read it):
file ~/Library/Application\ Support/llm-cost-monitor/refresh-token.bin

# 3. Confirm Postgres binds 127.0.0.1 only:
docker port llm-cost-monitor-postgres
```
