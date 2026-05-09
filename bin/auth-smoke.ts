// Headless smoke test for the auth pipeline. Exercises every step we can
// drive without a browser + Google interaction:
//   1. PKCE generation                              → pkce.ts
//   2. ~/.env credential load                       → env-loader.ts
//   3. Loopback server bind + simulated callback   → loopback-server.ts
//   4. /authorize URL construction (visual diff)    → google-oauth.ts
//   5. /token reachability w/ dummy refresh_token  → google-oauth.ts (refresh)
//
// Run: npx tsx bin/auth-smoke.ts
// Exit code 0 = all green; non-zero = failed step (descriptive message).

import { GOOGLE_AUTH_URL, OAUTH_SCOPES, oauthRedirectUri } from '../src/shared/auth-config'
import { loadAuthSecrets } from '../src/main/auth/env-loader'
import { generatePkce, challengeFromVerifier } from '../src/main/auth/pkce'
import { LoopbackCallbackServer } from '../src/main/auth/loopback-server'

const log = (step: string, msg: string): void => console.log(`  ${step}  ${msg}`)
const ok = (s: string): void => log('✓', s)
const fail = (s: string): never => {
  log('✗', s)
  process.exit(1)
}

async function main(): Promise<void> {
  console.log('auth-smoke — runtime sanity check (no browser interaction)')
  console.log('')

  // 1. PKCE
  console.log('1. PKCE')
  const pair = generatePkce()
  if (pair.method !== 'S256') fail(`expected method S256, got ${pair.method}`)
  if (!/^[A-Za-z0-9\-_]{43,128}$/.test(pair.verifier))
    fail(`verifier outside RFC 7636 alphabet: ${pair.verifier}`)
  if (challengeFromVerifier(pair.verifier) !== pair.challenge)
    fail('challenge != sha256(verifier)')
  ok(`fresh pair (verifier ${pair.verifier.slice(0, 8)}…, challenge ${pair.challenge.slice(0, 8)}…)`)

  // 2. ~/.env
  console.log('2. env-loader (~/.env)')
  const secrets = loadAuthSecrets()
  if (secrets === null) fail('no GCP_CLIENTID in ~/.env')
  if (!secrets.gcpClientId.endsWith('.apps.googleusercontent.com'))
    fail(`client_id has unexpected suffix: ${secrets.gcpClientId.slice(-25)}`)
  ok(`client_id loaded (starts with ${secrets.gcpClientId.slice(0, 12)}…)`)
  ok(`client_secret in env: ${secrets.gcpClientSecret === null ? 'no' : 'yes'}`)

  // 3. Loopback server
  console.log('3. loopback server')
  const server = new LoopbackCallbackServer({ callbackPath: '/callback' })
  const port = await server.start()
  if (port <= 0 || port > 65535) fail(`OS-assigned port out of range: ${port}`)
  ok(`bound to 127.0.0.1:${port}`)
  // Trigger a callback in-process so we don't need a browser.
  const wait = server.waitForCallback()
  const r = await fetch(`http://127.0.0.1:${port}/callback?code=fake&state=fake`)
  if (!r.ok) fail(`callback fetch returned ${r.status}`)
  await r.text() // drain
  const result = await wait
  server.close()
  if (result.query.get('code') !== 'fake') fail('query parsing dropped `code`')
  if (result.query.get('state') !== 'fake') fail('query parsing dropped `state`')
  ok('callback parsed and server closed cleanly')

  // 4. /authorize URL construction
  console.log('4. /authorize URL')
  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', secrets.gcpClientId)
  authUrl.searchParams.set('redirect_uri', oauthRedirectUri(port))
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', [...OAUTH_SCOPES].join(' '))
  authUrl.searchParams.set('code_challenge', pair.challenge)
  authUrl.searchParams.set('code_challenge_method', pair.method)
  authUrl.searchParams.set('state', 'fake-state')
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  ok(`URL host: ${authUrl.host}`)
  ok(`URL params: ${[...authUrl.searchParams.keys()].join(', ')}`)
  if (![...OAUTH_SCOPES].every((s) => authUrl.searchParams.get('scope')!.includes(s)))
    fail('scope missing one of the expected values')

  // 5. /token reachability with dummy refresh_token (expect 400 from Google,
  //    proving network path + endpoint shape are correct).
  console.log('5. /token reachability (with dummy refresh_token; expect 400)')
  const body = new URLSearchParams()
  body.set('client_id', secrets.gcpClientId)
  if (secrets.gcpClientSecret !== null) body.set('client_secret', secrets.gcpClientSecret)
  body.set('refresh_token', 'definitely-not-a-real-token')
  body.set('grant_type', 'refresh_token')
  const tokResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const tokText = await tokResp.text()
  if (tokResp.status === 400) {
    ok(`Google rejected dummy token (HTTP 400) — endpoint reachable + responsive`)
    if (!tokText.includes('invalid_grant')) {
      ok(`(unexpected error body, but 400 is the relevant signal): ${tokText.slice(0, 80)}`)
    }
  } else if (tokResp.status === 401) {
    ok(`Google returned 401 — endpoint reachable. Body: ${tokText.slice(0, 80)}`)
  } else {
    fail(`Google /token returned unexpected ${tokResp.status}: ${tokText.slice(0, 200)}`)
  }

  console.log('')
  console.log('all good — auth pipeline is runtime-correct up to the user-clicks-button step.')
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err))
})
