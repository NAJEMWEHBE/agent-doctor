# Contributing to agent-doctor

Thanks for helping make AI coding stacks healthier 🩺. The easiest and most valuable contribution is **adding a check for a tool you use** — usually ~10 lines of JSON, no JS required.

## Add a check (no code)

Checks are data. Add one to `checks.default.json` (built-in) or ship it in your own `checks.json` (project or `~/.agent-doctor/`, merged over built-ins by `id`). The format is validated by [`checks.schema.json`](checks.schema.json).

```json
{
  "id": "agent-cli:cursor",
  "label": "Cursor CLI",
  "dimension": "agents",
  "tier": "deep",
  "probe": { "type": "exec", "cmd": "cursor-agent", "args": ["--version"], "expectOutput": "\\d", "missing": "skip" },
  "fix": "Install Cursor CLI from https://cursor.com"
}
```

**Probe types:** `exec` (judge by output, tolerates weird exit codes) · `http` (supports `${ENV:VAR}`) · `port` · `fileJson` · `memwrite` (silent-failure detector) · `mcp` (server reachability).

**Principles:**
- **Functional, not existence** — probe behavior, never just "file exists."
- **Absent ≠ broken** — use `"missing": "skip"` so a not-installed tool SKIPs, not FAILs. Only fail what's installed-but-broken.
- **Secrets** — never put a key in a URL; use `headers` with `${ENV:VAR}` (it skips when unset and is never printed).
- Every check gets a one-line `fix`.

## Add a probe type (code)

New probe types live in `src/probes.js` (export an `async`/sync fn returning `{ status, detail }`), registered in the `PROBES` map in `src/engine.js`. Add a test in `test/doctor.test.js`.

## Dev

```bash
npm install        # zero runtime deps; dev only
node src/cli.js --deep
node --test
```

## PRs

- Keep changes focused; one feature/check set per PR.
- `node --test` green; `node src/cli.js --json` valid.
- AI reviewers (CodeRabbit / Gemini) run automatically — address Major/High before merge.

By contributing you agree your work is MIT-licensed.
