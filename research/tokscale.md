# junhoyeo/tokscale — research note

**Repo:** https://github.com/junhoyeo/tokscale — 2.6k★, MIT.
**Stack:** Rust core (`crates/tokscale-core`, `crates/tokscale-cli`) + Bun/TypeScript distribution wrappers (`packages/cli-*` for each platform target, `packages/cli`, `packages/frontend`). It's a CLI/TUI, not a menubar app — but as the only **multi-provider Rust** entry, it has the most thoughtful cross-vendor logic.

## Provider abstraction (the real find)

Not a single trait — tokscale uses **identity normalization** instead. `crates/tokscale-core/src/provider_identity.rs` is the gem:

- `provider_tags(raw)` walks slash- and dot-separated provider strings and yields canonical tags. Examples (from the repo's tests):
  - `vertex` / `vertex_ai` → `anthropic` (because Vertex Anthropic IS Anthropic)
  - `gemini` → `google`
  - `mistral` / `mistralai` → `mistralai`
  - `openai-codex` → `openai`
  - `openrouter/google` → `["openrouter", "google"]`
  - `bedrock/anthropic.claude-sonnet-4` → `["bedrock", "anthropic"]`
- `inferred_provider_from_model("claude-sonnet-4")` → `"anthropic"`. Same for `gpt-5.2` → `"openai"`, `gemini-2.5-pro` → `"google"`, `grok-…` → `"xai"`, `deepseek-v3` → `"deepseek"`, `qwen3-coder` → `"qwen"`, `llama-3` → `"meta"`.
- Includes **negative tests** to avoid false positives: `protocol1-fast` doesn't match `o1`, `metadata-model` doesn't match `meta`. The boundary check (`contains_delimited`) requires non-alphanumeric neighbors.

This is a sharp design lesson: instead of asking each adapter "what provider are you?", normalize the model string. We can ship one Swift function that ports this logic and use it everywhere — model search, pricing lookup, per-provider rollups.

## Where usage data comes from / pricing

The big files (`scanner.rs` 95 KB, `lib.rs` 167 KB, `aggregator.rs` 33 KB, `clients.rs` 21 KB, `message_cache.rs` 38 KB) are too big for a focused read, but the architecture is clear:

- `parser.rs` (8 KB): generic SIMD-JSON line streamer. Skips malformed lines instead of failing the whole file (essential for in-progress streaming JSONL):
  ```rust
  pub fn parse_jsonl_file<T, F>(path: &Path, mut process: F) -> Result<(), ParseError>
      where T: serde::de::DeserializeOwned, F: FnMut(T)
  ```
  We should mirror this — line iteration with per-line `try?` rather than a single `JSONDecoder` over the whole file.
- `paths.rs` (9.5 KB): config dir resolution. Notable points to crib:
  - **`TOKSCALE_CONFIG_DIR` env override** (matches our `CLAUDE_CONFIG_DIR` and CodexBar's `CODEX_HOME`).
  - On macOS, **forces `~/.config/tokscale/`** instead of `dirs::config_dir()` which would give `~/Library/Application Support/`. Reason: docs say `~/.config/`, splitting state across two roots silently breaks user-edited settings. **For our app we should pick one and stick to it; I'd default to `~/Library/Application Support/llm-cost-monitor/` for native macOS feel, but accept a `LLM_COST_MONITOR_DIR` env override.**
  - Empty-string env values are treated as unset (defensive), with a regression test.
  - Documented "legacy path" probes for migration after a directory move (`legacy_dirs_cache_dir`, `legacy_dot_cache_tokscale_dir`) — clean migration story.
- `pricing/` (subdirectory): vendored pricing tables. (Didn't read; assumes LiteLLM-style snapshot.)
- `sessions/` (subdirectory): per-session models.
- `clients.rs`: HTTP clients, presumably for live token-count APIs.
- `message_cache.rs`: serialized "I've seen this message before" cache so re-scans are O(new lines).

## Per-provider adapters

The provider files I'd expect (`auth.rs`, `cursor.rs`, `antigravity.rs` mentioned by `paths.rs` doc-comments) are in submodules of `lib.rs` / `scanner.rs` and weren't read directly. From naming + the identity catalog, tokscale targets at minimum: `anthropic` (Claude/Vertex), `openai` (Codex), `google` (Gemini), `xai` (Grok), `deepseek`, `mistral` / `mistralai`, `meta`, `qwen`, `bedrock`, `openrouter`, `azure_ai`, `together_ai`, `fireworks_ai`, `ai21`, `moonshotai` (Kimi).

## CLI surface

Distributed via Bun → npm (`packages/cli` plus `cli-darwin-arm64`, `cli-darwin-x64`, `cli-linux-…`, `cli-win32-…` per-arch wrappers). README mentions `tokscale today`, weekly summaries, "Wrapped" feature (year-in-review). Has a TUI (the "TUI display cache" mentioned in `paths.rs`).

## Steal

1. **Provider canonicalization** (`provider_identity.rs`). Port to a Swift `ProviderIdentity.canonical(rawProviderTag:)` and `ProviderIdentity.inferred(fromModel:)`. This **alone** simplifies the rest of the pipeline — we never carry around inconsistent provider strings.
2. **`vertex` and `vertex_ai` collapsing to `anthropic`** — masorange's `msg_vrtx` prefix detection becomes "this row's normalized provider is `anthropic` regardless of the raw tag".
3. **Skip-bad-lines streaming JSONL parser** — JSONL files are written incrementally, so partial lines are normal; a parser that fails the whole file on one bad line is broken by design.
4. **Per-line malformed-line tolerance** — same as above.
5. **`*_CONFIG_DIR` env-override convention** with empty-string-as-unset.
6. **Legacy-path probes for migration** — when we change directory layouts post-1.0, follow this pattern.
7. **Pre-arch'd npm wrappers** — if we ever distribute a CLI alongside the menubar app, this is the cleanest packaging story.

## Skip

1. **Rust-for-the-engine** for now. Swift keeps everything in one binary and lets us call macOS APIs directly. We can re-evaluate if scanner perf becomes an issue.
2. **TUI surface** — we're building a menubar app.
3. **"Wrapped" year-in-review** — fun but stretch-goal territory.
4. **Migration helpers from tokscale's own legacy paths** — irrelevant.

## Source file index

| File | Size | Role |
|---|---|---|
| `crates/tokscale-core/src/provider_identity.rs` | 9.5 KB | Provider canonicalization — **port to Swift** |
| `crates/tokscale-core/src/parser.rs` | 8 KB | SIMD-JSON line-by-line JSONL streamer |
| `crates/tokscale-core/src/paths.rs` | 9.5 KB | Config dir + env override + legacy migration |
| `crates/tokscale-core/src/aggregator.rs` | 33 KB | Aggregation (didn't read, too big) |
| `crates/tokscale-core/src/scanner.rs` | 95 KB | The big scanner (didn't read) |
| `crates/tokscale-core/src/lib.rs` | 167 KB | Whole crate (didn't read) |
| `crates/tokscale-core/src/message_cache.rs` | 38 KB | Seen-message cache (didn't read) |
| `crates/tokscale-core/src/pricing/` | dir | Pricing tables (vendored) |
| `crates/tokscale-core/src/sessions/` | dir | Session models |
| `crates/tokscale-cli/` | crate | CLI shell |
| `packages/cli` + `packages/cli-{darwin,linux,win32}-*` | npm | Per-arch wrappers |
| `packages/frontend` | npm | TUI / web frontend |
