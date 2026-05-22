## What

<!-- The check(s)/change in one or two lines. -->

## Why

<!-- What broken-but-installed state does this catch? -->

## Checklist
- [ ] `node --test` is green
- [ ] `node src/cli.js --json` is valid
- [ ] new checks use `"missing": "skip"` for absent tools and include a one-line `fix`
- [ ] no secrets in URLs (use `headers` + `${ENV:VAR}`)
