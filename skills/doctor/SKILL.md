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

3. For every **FAIL** or **WARN**, restate the one-line `fix`. Then offer the **Remediation** flow below (research a real fix, apply with consent). Never auto-apply.

4. If everything is green, say so in one line.

## Remediation (suggest & fix)

After showing the report, if there are any FAIL or WARN rows, you MAY help fix them — but only when the user opts in.

1. Ask once: "N issue(s) found — want me to research fixes and walk through them?" If the user declines or only wanted a status check, stop here.
2. If yes, take the FAIL/WARN rows one at a time, most severe first (FAIL before WARN). For each:
   - **Research** the specific failure. Seed your search with the check `id`, its `detail`, and the built-in `fix` hint; read the relevant config/log if it is quick. Prefer official docs and primary sources, and use a multi-angle research workflow rather than a single search.
   - **Source integrity:** propose only fixes backed by real, cited sources. If you cannot find a verified fix, say so plainly and move on — never invent one.
   - **Present** the fix: what it changes, why, the source(s), and a one-line risk note.
   - **Ask:** apply / skip / explain-more.
   - **Apply only on approval**, using your normal tools (edit the config, run the command). Never auto-apply. For risky actions (rewriting a config, installing software, deleting anything) restate the exact action and get explicit confirmation first.
   - **Verify:** re-run `agent-doctor --only <id> --force` and report whether it is now GREEN. The `--force` is required — it bypasses the throttle cache, so a just-fixed throttled check (API keys, deep probes) reflects the new state instead of the stale cached result. If it still fails, research once more or stop and say so.
3. Finish with a one-line summary: fixed / skipped / still-broken.

This flow needs a research-capable agent. A bare `agent-doctor` run still prints the static `fix` hint — that is the floor; this is the bonus.

## Notes

- The flagship check is `memory:claude-mem-writing` — it catches the "logging but writing 0 memories" silent failure by comparing observation count vs prompt count in the SQLite DB.
- Absent tools are reported as SKIP, not FAIL — only installed-but-broken things fail.
- For machine-readable output use `agent-doctor --json`. For a CI gate use `agent-doctor --fail-on fail`.
- Users can add their own checks in `~/.agent-doctor/checks.json` or a project `checks.json` (merged by `id`).
