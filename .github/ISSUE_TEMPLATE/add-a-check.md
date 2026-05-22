---
name: Add a check
about: Request or contribute a health check for a tool, agent, MCP server, or service
title: "check: <tool> — "
labels: ["good first issue", "add-a-check"]
---

**Tool / service:**

**What "healthy" means** (version command, HTTP endpoint, port, config file, DB count…):

**One-line fix when it's unhealthy:**

**Draft check** (format: [CONTRIBUTING.md](../CONTRIBUTING.md) · [checks.schema.json](../checks.schema.json)):
```json
{
  "id": "",
  "label": "",
  "dimension": "",
  "tier": "deep",
  "probe": { "type": "exec", "cmd": "", "args": ["--version"], "expectOutput": "\\d", "missing": "skip" },
  "fix": ""
}
```
