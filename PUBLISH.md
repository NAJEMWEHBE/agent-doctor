# Publishing / release checklist

Steps that need an interactive login or the GitHub web UI (one-time).

## 1. CI workflow (needs `workflow` OAuth scope)
The `.github/workflows/ci.yml` file is in the repo working tree but can't be pushed by a token lacking the `workflow` scope.
```bash
gh auth refresh -s workflow -h github.com   # approve in browser
git add .github/workflows/ci.yml
git commit -m "ci: add cross-platform workflow"
git push
```

## 2. Social preview image
GitHub repo → **Settings → General → Social preview → Edit → Upload** `assets/hero.png`.
(No API/CLI exists for this; web UI only.)

## 3. npm publish (enables `npx agent-doctor`)
Use **Node 20 or 22** (newer/odd builds may crash the publish step).
```bash
npm login
npm publish --access public
```
Not required for the Claude Code plugin — that installs straight from GitHub.

## 4. Cut a release
```bash
git tag v0.2.0
git push --tags
gh release create v0.2.0 --generate-notes
```

## Discovery (optional, drives stars)
- Submit to `awesome-claude-code`, `awesome-mcp`, `awesome-ai-tools` lists.
- Share with the silent-failure story (the founding bug) — that's the hook.
