# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com), [SemVer](https://semver.org).

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
