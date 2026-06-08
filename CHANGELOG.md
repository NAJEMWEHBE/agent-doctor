# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

## [Unreleased]

### Changed
- **Real MCP handshake probe** (`mcp` probe) — replaces reachability-only checking with the actual JSON-RPC handshake: `initialize` (protocol `2025-06-18`) → `notifications/initialized` → `tools/list`. Remote servers (`url`) speak Streamable-HTTP JSON-RPC (parses a JSON body or an SSE `data:` frame, carries the negotiated `Mcp-Session-Id`, honors `${ENV:VAR}` in headers); local servers (`command`) are spawned and probed over newline-delimited stdio JSON-RPC. Per-server verdicts: **GOOD** (handshake ok + ≥1 tool), **WARN** ("speaks MCP but 0 tools" — the MCP twin of the memory silent-failure), **AUTH** (401/403 Bearer challenge), **DOWN** (unreachable / not MCP / crashed on init). Roll-up: pass = all GOOD, warn = any WARN or mixed up/down, fail = all DOWN/AUTH. Keeps the 3s timeout and probes servers concurrently. Local spawns now quote command/args so launcher paths with spaces work (also clears the DEP0190 warning).

## [0.5.0] — 2026-05-23

### Added
- **Broader agent-CLI coverage** — +9 checks in the `agents` dimension: Cursor (`cursor-agent`), GitHub Copilot CLI (`copilot`), opencode, Qwen Code (`qwen`), Block Goose (`goose`), Charm Crush (`crush`), Continue (`cn`), Augment Auggie (`auggie`), Sourcegraph Cody (`cody`). Each is a judge-by-output `--version` exec probe; absent tools SKIP (never FAIL). Also backs the previously-advertised Cursor row. Install hints verified against official docs.

## [0.4.0] — 2026-05-22

### Added
- **Research-backed "suggest & fix"** in the `/doctor` skill: on FAIL/WARN, opt in to have the agent deep-research a real, source-cited fix and apply it with per-fix confirmation, then re-verify via `--only <id>`. Never auto-applies; never invents a fix. Agent-layer only (zero-dep CLI unchanged); a bare CLI run still shows the static hint.

## [0.3.0] — 2026-05-22

### Added
- **MCP server reachability check** (`mcp` probe): reads `~/.claude.json` (root + per-project `mcpServers`) and probes each — remote (url) for reachability, local (command) for launcher resolution. pass/warn/fail by how many are up.
- **API-key ping checks** (keys dimension): Anthropic / OpenAI / Gemini / Groq. Uses `${ENV:VAR}` interpolation in url/headers; **skips** (never fails/pings) when the key env var is unset. Throttled 24h. Secrets are never printed.
- `interpolateEnv()` helper for safe env substitution in probes.

### Changed
- `httpProbe` now supports `${ENV:VAR}` in `url` and `headers`, skipping if a referenced var is unset.

## [0.2.0] — 2026-05-22

### Added
- **0–100 health score** and checks grouped by **dimension** (runtime / agents / memory / config / mcp).
- New checks: `git`, claude-mem vector DB (Chroma `:8000`), MCP config (`~/.claude.json`).
- `agent-doctor init` — scaffold a starter `checks.json`.
- `docs/LANDSCAPE.md` — competitive landscape + positioning.

### Changed
- README: runtime-probe positioning — *"they audit your config; agent-doctor checks if your stack is actually alive."*

## [0.1.0] — 2026-05-22

Initial release.

### Added
- Cross-platform Node CLI (`agent-doctor`, zero runtime deps, `npx`-able).
- Probe types: `exec` (judge-by-output, tolerates nonzero exit), `http`, `port`, `fileJson`, `memwrite`.
- **Flagship `memwrite` check** — detects "logging but writing 0 memories" silent failure via SQLite observation-vs-input counts (node:sqlite → python → sqlite3 backends).
- Two tiers: `--fast` (no network) and `--deep` (default), with throttle cache for deep network probes.
- Built-in checks: Node/Bun/Python runtimes, Claude Code / Codex / Gemini / Aider CLIs, claude-mem writing + worker, config JSON validity.
- Output modes: colored table, `--json`, `--quiet`, `--hook`; `--fail-on` CI gate; `--force`, `--only`.
- User-extensible checks via `checks.json` (project or `~/.agent-doctor/`), merged by `id`.
- Claude Code plugin: `/doctor` skill + SessionStart hook + marketplace.json.
