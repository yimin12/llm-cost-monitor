// What kind of credential / plan a provider is using.
//
// `subscription`  the user signed in with a paid vendor subscription that
//                 grants a named tier (Claude Pro/Max, ChatGPT Plus/Pro/Team,
//                 etc.). `planName` carries the tier label.
// `oauth`         the user signed in with OAuth but the provider has no
//                 paid-tier mapping — typically Gemini CLI's free-tier
//                 Google Account login or Workspace login. Distinct from
//                 `subscription` because there is no "plan" to display, just
//                 the identity. `planName` carries the identity label
//                 ("Google Account", "Workspace Account").
// `apiKey`        the user pays via API (env var or stored key).
// `none`          the provider has no credentials we can detect. Auth source
//                 was looked at and came back empty.
// `unknown`       we couldn't determine — file unreadable, JWT malformed, etc.
//                 `detail` should explain why.
export type AuthMode = 'subscription' | 'oauth' | 'apiKey' | 'none' | 'unknown'

export interface PlanInfo {
  authMode: AuthMode
  // Human label: "Max", "Pro", "Plus", "Team", "Enterprise", "API key", "Google Account".
  planName: string | null
  // Where we read it from: "macOS Keychain", "~/.codex/auth.json",
  // "ANTHROPIC_API_KEY env", etc. Helps the user verify in Settings.
  source: string | null
  // Optional: account email, expiry, parse error message.
  detail: string | null
}

export function unknownPlan(detail: string | null = null): PlanInfo {
  return { authMode: 'unknown', planName: null, source: null, detail }
}

export function noPlan(): PlanInfo {
  return { authMode: 'none', planName: null, source: null, detail: null }
}
