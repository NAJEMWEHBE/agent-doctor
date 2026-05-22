# Landscape — where agent-doctor sits

Competitive/adjacent research. Stars as of **2026-05-22** (GitHub API). The takeaway: the *AI-agent runtime-health* niche is essentially **unclaimed** — the named competitors are brand-new and tiny, the popular neighbors solve a different problem (MCP debugging, broad skill packs), and **every existing "health" tool does static config audits, not live runtime probes**.

## The field (~20 projects)

### A. AI-agent config health checkers (closest competitors — all static config audits)
| Project | ★ | Lang | What it does | Gap agent-doctor fills |
|---|---|---|---|---|
| [yurukusa/cc-health-check](https://github.com/yurukusa/cc-health-check) | 0 | HTML | Scans `.claude/settings.json` + `CLAUDE.md` for 20 failure patterns, scores 0–100 | Claude-only; **static** (no runtime probe); doesn't detect a *broken-but-installed* tool |
| [tw93/Waza](https://github.com/tw93/Waza) | 4992 | Python | Broad "engineering habit" skills incl. a `/health` six-layer config audit (Claude + Codex) | Audits config quality, not whether the stack *works right now* |
| [hiclaude/health](https://github.com/hiclaude/health) | 5 | — | Claude Code skill: six-layer config audit | Static; Claude-only; skill (not a portable CLI/CI gate) |
| [danielithomas/chealth](https://github.com/danielithomas/chealth) | 1 | Python | Checks `CLAUDE.md` against best practices | Single-file scope; static |
| [laurigates/claude-plugins](https://github.com/laurigates/claude-plugins) | 35 | Python | Dev-workflow plugins (incl. validators) | Not a health doctor per se |

### B. MCP inspectors / doctors (adjacent — server-side, not the user's stack)
| Project | ★ | What | Relation |
|---|---|---|---|
| [modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector) | 9837 | Official visual MCP test/debug UI | Debugs *one server* you're building; not stack health |
| [MCPJam/inspector](https://github.com/MCPJam/inspector) | 1959 | MCP debug/eval platform + CLI `doctor` | Server dev tool |
| [docker/mcp-inspector](https://github.com/docker/mcp-inspector) | 46 | Visual MCP testing | Server dev tool |
| [destilabs/mcp-doctor](https://github.com/destilabs/mcp-doctor) | 14 | 🩺 Diagnoses MCP servers' agent-friendliness/compliance | Closest "doctor" — but for *authoring* a server, not *using* a stack |
| [mcp-use/inspector](https://github.com/mcp-use/inspector) | 13 | Modern remote-MCP inspector | Server dev tool |

### C. Classic env "doctor" prior art (validates the pattern)
`flutter doctor`, `brew doctor`, `npm doctor`, `conda doctor`, `sf doctor` (Salesforce CLI), `react-native doctor` — all framework-bundled, single-ecosystem, check toolchain presence/config. None target the AI-agent stack. They prove the UX expectation: PASS/WARN/FAIL + fix hints.

### D. Repo-health analyzers (different axis)
"Repo Doctor" and `github.com/topics/health-check` tools score *repository* health (READMEs, CI, licenses) — not the developer's *agent environment*.

## Where agent-doctor is differentiated

1. **Live runtime probes, not static config audits.** Everyone else parses `settings.json`/`CLAUDE.md`. agent-doctor asks *"does it actually work right now?"* — does the memory DB's write-count climb, is the worker answering, does `claude -p` return text, does the API key ping 200.
2. **Silent-failure detection (the flagship).** The `memwrite` probe catches "logging but writing 0 memories" — the exact class of bug that's invisible to config auditors. No competitor does this.
3. **Multi-agent by design.** Claude Code · Codex · Cursor · Gemini CLI · Aider · any shell — vs Claude-only competitors.
4. **Portable zero-dep CLI + plugin + CI gate.** `npx agent-doctor`, `--json`, `--fail-on fail`. Competitors are skills (Claude-only) or server dev tools.

**Positioning line:** *"They audit your config. agent-doctor checks if your stack is actually alive."*

## Ideas harvested (feed the brainstorm)
- Deep **MCP checks** for the *user's configured* servers (reachability/tool-list) — borrow mcp-doctor's angle but stack-side.
- A **0–100 score** + 6-dimension grouping (cc-health-check's hook — people love a score).
- `--fix` safe autofixes; `agent-doctor init`; `--watch`; SARIF/`--json` for CI.
- An `awesome-claude-code` / `awesome-mcp` listing for discovery.
