#!/usr/bin/env bash
# seed-multinode.sh — write usage events from MULTIPLE nodes/users to the
# team-sync endpoint, then print the cross-node rollup.
#
# Purpose: prove that several nodes (devices) reporting independently are
# persisted on the OCI node and summed into ONE consistent cost + token
# total by the read endpoint (GET /v1/teams/:team/usage).
#
# Auth: server runs LCM_SERVER_AUTH=insecure-noverify on this box, so a bare
# token string decodes straight to the userId (see server/auth.ts). The admin
# (user-1) token is used for membership management; per-event membership is
# enforced server-side. sync_event_id is the sha256 forgery guard the server
# recomputes (server/team-service.ts), so we reproduce it exactly here.
#
# Usage:  ENDPOINT=http://localhost:4017 TEAM=team-demo ./seed-multinode.sh
set -euo pipefail

ENDPOINT="${ENDPOINT:-http://localhost:4017}"
TEAM="${TEAM:-team-demo}"
NOW="$(date +%s)000"   # ms; keeps events inside today/MTD windows

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# sync_event_id = sha256("team|user|node|local") — matches syncEventIdInput().
sid()   { printf '%s|%s|%s|%s' "$TEAM" "$1" "$2" "$3" | sha256sum | cut -d' ' -f1; }
# payload_hash: any stable non-empty string (server uses it for drift detection).
phash() { printf '%s' "$*" | sha256sum | cut -d' ' -f1; }

# Team usage is attributed by what·project·who only — we send the LITERAL
# project name and never a session_id/message_id (the server drops those
# anyway; see server/team-service.ts).
# event <user> <node> <local> <provider> <model> <project> <in> <out> <cost_micro>
event() {
  local user="$1" node="$2" lid="$3" provider="$4" model="$5" project="$6" in="$7" out="$8" cost="$9"
  cat <<JSON
{"kind":"event","event_version":1,"sync_event_id":"$(sid "$user" "$node" "$lid")","team_id":"$TEAM","user_id":"$user","node_id":"$node","local_event_id":"$lid","payload_hash":"$(phash "$user$node$lid$project$cost")","privacy_level":"full","captured_at":$NOW,"synced_at":null,"provider":"$provider","provider_raw_tag":null,"model":"$model","timestamp":$NOW,"project":"$project","project_hash":null,"session_id":null,"message_id":null,"input_tokens":$in,"output_tokens":$out,"cache_read_tokens":0,"cache_creation_5m_tokens":0,"cache_creation_1h_tokens":0,"reasoning_tokens":null,"tool_call_count":null,"latency_ms":null,"cost_micro_usd":"$cost","pricing_snapshot_version":"v1"}
JSON
}

say "Ensure teammate (user-2) is an active member of $TEAM (admin action)"
curl -fsS -X POST "$ENDPOINT/v1/teams/$TEAM/members" \
  -H "Authorization: Bearer user-1" -H 'Content-Type: application/json' \
  -d '{"userId":"user-2","role":"member","displayName":"Teammate"}' && echo

# Multi-node fleet:
#   user-1 / node-2  (a 2nd device for the existing admin) — openai
#   user-2 / node-3  (a teammate's device)                 — anthropic
EVENTS="$(event user-1 node-2 e-n2-1 openai    gpt-4o          billing-api   2000 500 3000000),
$(event user-2 node-3 e-n3-1 anthropic claude-opus-4-1 data-pipeline 1000 400 4000000),
$(event user-2 node-3 e-n3-2 anthropic claude-opus-4-1 data-pipeline  300 100 1000000)"

say "WRITE events from node-2 (user-1) and node-3 (user-2)"
curl -fsS -X POST "$ENDPOINT/v1/teams/$TEAM/events:batchUpsert" \
  -H "Authorization: Bearer user-1" -H 'Content-Type: application/json' \
  -d "{\"events\":[$EVENTS]}" && echo

say "READ cross-node rollup (summed across all nodes)"
curl -fsS "$ENDPOINT/v1/teams/$TEAM/usage" -H "Authorization: Bearer user-1"
echo
