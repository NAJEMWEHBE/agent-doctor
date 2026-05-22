# Adapters — wire agent-doctor into any AI agent

The core is a portable CLI (`agent-doctor`). Each agent just needs a way to invoke it. The **Claude Code** integration ships as a first-class plugin (this repo root: `/doctor` skill + SessionStart hook). For other agents, use the snippets below.

Prereq: `npm install -g agent-doctor` (or use `npx -y agent-doctor`).

## Codex CLI
Add a project skill/command that runs the doctor. Minimal: a shell alias or a `codex` custom command invoking:
```bash
agent-doctor --deep
```

## Cursor
Add a Cursor rule / command that runs `agent-doctor --deep` in the integrated terminal, or a `.cursor` task. For automated gating in CI:
```bash
agent-doctor --fail-on fail
```

## Gemini CLI
Wire as a Gemini CLI custom command / extension that shells out to:
```bash
agent-doctor --deep
```

## Generic shell / any agent
Just run it:
```bash
npx agent-doctor            # full report
agent-doctor --fast --json  # quick machine-readable status
```

## Git pre-commit hook (any repo)
Block commits when your stack is broken (e.g. memory silently down):
```sh
#!/bin/sh
# .git/hooks/pre-commit  (chmod +x)
agent-doctor --fast --fail-on fail || {
  echo "agent-doctor: stack unhealthy — run 'agent-doctor' for fixes (bypass: --no-verify)"
  exit 1
}
```

## CI (GitHub Actions)
```yaml
- run: npx agent-doctor --deep --fail-on fail
```

Want first-class support for your agent? PRs welcome — adapters are thin.
