#!/usr/bin/env node
//
// devbar-statusline — Claude Code statusline command.
//
// Outputs a single line that Claude Code renders as the inline status
// notification at the top of its UI. Two pieces of info:
//
//   1. Today's total LLM spend across all providers (Claude Code,
//      Codex, Gemini, …) — read from devbar's exported JSON. devbar
//      writes this file every refresh tick (default every 5 min); when
//      the desktop app isn't running, the value falls back to "$—".
//
//   2. Remaining context window for the current Claude Code session —
//      computed from the transcript file Claude Code points at. We
//      read the last assistant message's `usage` and divide by the
//      model's max context (200k for opus/sonnet, 1M for the [1m]
//      variants).
//
// Stdin: Claude Code passes a JSON object describing the active session.
//   {
//     "model": { "id": "...", "display_name": "..." },
//     "transcript_path": "/Users/.../sessions/<id>.jsonl",
//     "session_id": "...", "cwd": "...", ...
//   }
//
// Stdout: a single ASCII/UTF-8 line. Claude Code truncates if too wide.
//
// We deliberately keep this file plain Node (no TypeScript compile step,
// no devbar imports). Statusline runs once per UI tick and `npx tsx`
// startup would add ~250 ms to every poll — not acceptable.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Match Electron's app.getPath('userData') for the `llm-cost-monitor`
// package name on each platform. This is where the desktop app writes
// `statusline.json`.
function userDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/llm-cost-monitor')
  }
  if (process.platform === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME
    return xdg
      ? path.join(xdg, 'llm-cost-monitor')
      : path.join(os.homedir(), '.config/llm-cost-monitor')
  }
  // Windows — Electron's userData lands under AppData/Roaming.
  return path.join(os.homedir(), 'AppData/Roaming/llm-cost-monitor')
}

function readStdinSync() {
  try {
    // fd 0 = stdin. readFileSync on a pipe blocks until EOF.
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Returns { todayUsd, generatedAt } or null if the export file is missing
// or stale (the desktop app might be off). We don't filter on staleness
// here — let the value display as-is and the user can spot a freeze.
function loadTodayCost() {
  try {
    const p = path.join(userDataDir(), 'statusline.json')
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = safeJsonParse(raw)
    if (parsed === null) return null
    if (typeof parsed.todayUsd !== 'number') return null
    return { todayUsd: parsed.todayUsd, generatedAt: parsed.generatedAt }
  } catch {
    return null
  }
}

// Walk the JSONL transcript from the bottom up to find the last
// assistant message with a `usage` block. That object's input_tokens +
// cache_creation_input_tokens + cache_read_input_tokens approximates the
// current context window occupancy.
function loadContextUsage(transcriptPath) {
  let raw
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    const obj = safeJsonParse(line)
    if (obj === null) continue
    const role = obj.type ?? obj.role ?? obj.message?.role
    const usage = obj.message?.usage ?? obj.usage
    if (role === 'assistant' && usage && typeof usage === 'object') {
      return usage
    }
  }
  return null
}

// Best-effort context-window classification.
//
// The model id Claude Code reports doesn't distinguish the 1M variant
// from the 200k variant — both come through as `claude-opus-4-7` (or
// equivalent for sonnet). The `[1m]` suffix only appears in some
// surfaces (e.g. the model selector), not in the statusline JSON.
//
// So we lean on a runtime tell: if the observed context usage is
// already above 200k, the user is definitively on the 1M variant
// (otherwise the request would have been rejected). For everything
// below that threshold, we conservatively assume 200k.
//
// This means the percentage rolls smoothly from 100→0 across whichever
// window is actually in play, with no need to plumb the tier through.
function modelMaxContext(modelId, observedUsed) {
  if (observedUsed > 200_000) return 1_000_000
  if (typeof modelId === 'string' && (/\[1m\]/i.test(modelId) || /-1m\b/i.test(modelId))) {
    return 1_000_000
  }
  return 200_000
}

function formatCost(usd) {
  if (usd === null || usd === undefined) return '$—'
  if (usd >= 100) return `$${usd.toFixed(0)}`
  return `$${usd.toFixed(2)}`
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

// Strip the "Claude " prefix from the display name — it's redundant in
// a Claude-only statusline and eats horizontal space. Keep the rest
// verbatim so version bumps surface ("Opus 4.7" → "Opus 4.8" etc).
// Falls back to the raw model id when display_name is missing.
function shortModelLabel(model) {
  const display = typeof model?.display_name === 'string' ? model.display_name : null
  const id = typeof model?.id === 'string' ? model.id : null
  if (display !== null && display.length > 0) {
    return display.replace(/^Claude\s+/i, '').trim()
  }
  if (id !== null && id.length > 0) {
    // Best-effort: claude-opus-4-7 → "opus 4-7". Hyphens stay; we don't
    // pretend to know which segment is the version vs the family.
    return id.replace(/^claude-/i, '').replace(/\[1m\]$/i, '').trim()
  }
  return null
}

function main() {
  const stdin = readStdinSync()
  const session = safeJsonParse(stdin) ?? {}

  const costInfo = loadTodayCost()
  const cost = costInfo === null ? null : costInfo.todayUsd

  let pctRemaining = 100
  if (typeof session.transcript_path === 'string' && session.transcript_path.length > 0) {
    const usage = loadContextUsage(session.transcript_path)
    if (usage !== null) {
      const used =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      const max = modelMaxContext(session.model?.id, used)
      pctRemaining = used > 0 ? clamp(((max - used) / max) * 100, 0, 100) : 100
    }
  }

  // Output. Single-line, no trailing newline (Claude Code adds one).
  // Model first so the answer to "which model am I talking to" is the
  // first thing the eye catches; cost + context follow.
  const modelLabel = shortModelLabel(session.model)
  const parts = []
  if (modelLabel !== null) parts.push(`🤖 ${modelLabel}`)
  parts.push(`💰 ${formatCost(cost)} today`)
  parts.push(`🧠 ${pctRemaining.toFixed(0)}% ctx`)
  process.stdout.write(parts.join(' · '))
}

main()
