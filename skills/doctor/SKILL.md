---
name: doctor
description: Run a health check on the AI coding stack — verify the agent CLI, MCP servers, memory system, API keys, and runtimes are actually WORKING (not just installed). Use when the user says "/doctor", "health check", "check my setup", "is X working", "diagnose my environment", "why is memory/MCP not working", or after install/config changes.
---

# /doctor — AI coding stack health check

Run `agent-doctor` and present the results clearly.

## What to do

1. Run the deep check (try in this order; first that works wins):
   ```
   agent-doctor --deep
   ```
   If `agent-doctor` is not on PATH:
   ```
   npx -y agent-doctor --deep
   ```
   If neither resolves, run the bundled copy:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/src/cli.js" --deep
   ```

2. Show the user the PASS / WARN / FAIL table verbatim (it's already formatted + colored).

3. For every **FAIL** or **WARN**, restate the one-line `fix` and offer to apply it if it's safe and the user agrees. Do NOT auto-apply fixes without confirmation.

4. If everything is green, say so in one line.

## Notes

- The flagship check is `memory:claude-mem-writing` — it catches the "logging but writing 0 memories" silent failure by comparing observation count vs prompt count in the SQLite DB.
- Absent tools are reported as SKIP, not FAIL — only installed-but-broken things fail.
- For machine-readable output use `agent-doctor --json`. For a CI gate use `agent-doctor --fail-on fail`.
- Users can add their own checks in `~/.agent-doctor/checks.json` or a project `checks.json` (merged by `id`).
