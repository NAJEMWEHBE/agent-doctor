#!/usr/bin/env node
// agent-doctor — flutter doctor for your AI coding stack.
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from './engine.js';
import { render, renderJson } from './render.js';

const CHECKS_TEMPLATE = {
  checks: [
    {
      id: 'keys:openai',
      label: 'OpenAI API key',
      dimension: 'keys',
      tier: 'deep',
      throttleHours: 24,
      probe: {
        type: 'http',
        url: 'https://api.openai.com/v1/models',
        expectStatus: 200,
        headers: { Authorization: 'Bearer REPLACE_WITH_KEY' },
      },
      fix: 'Set/rotate your OpenAI API key',
    },
  ],
};

function initChecks() {
  const target = join(process.cwd(), 'checks.json');
  if (existsSync(target)) {
    process.stdout.write(`checks.json already exists at ${target} — leaving it untouched.\n`);
    return 0;
  }
  try {
    writeFileSync(target, JSON.stringify(CHECKS_TEMPLATE, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: could not write ${target}: ${e?.message || e}\n`);
    return 1;
  }
  process.stdout.write(`Wrote starter ${target}\nEdit it to add your own checks (merged over built-ins by id), then run: agent-doctor\n`);
  return 0;
}

const HELP = `
🩺 agent-doctor — health checks for your AI coding stack

Usage:
  agent-doctor [options]
  agent-doctor init          Write a starter checks.json in the current directory

Reports a 0–100 health score plus per-dimension PASS/WARN/FAIL with fixes.

Options:
  --fast            Fast tier only (no network/spawns). Used by session-start hooks.
  --deep            Full checks incl. version probes + API pings (default).
  --json            Machine-readable output (for CI/automation).
  --quiet           Only show WARN/FAIL rows.
  --force           Ignore throttle cache; re-run all deep probes now.
  --only <id>       Run a single check id (or group).
  --fail-on <lvl>   Exit nonzero if any result >= lvl (warn|fail). For CI.
  -h, --help        Show this help.
  -v, --version     Show version.

Examples:
  npx agent-doctor                 # full report
  agent-doctor --fast --json       # quick machine-readable status
  agent-doctor --fail-on fail      # CI gate
`;

function parseArgs(argv) {
  const o = { tier: 'deep', json: false, quiet: false, force: false, only: null, failOn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fast') o.tier = 'fast';
    else if (a === '--deep') o.tier = 'deep';
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--force') o.force = true;
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--fail-on') o.failOn = argv[++i];
    else if (a === '--hook') { o.hook = true; o.tier = 'fast'; }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
  }
  return o;
}

async function main() {
  // first positional arg selects a subcommand; skip value-consuming flags so
  // e.g. `--only init` / `--fail-on init` are not mistaken for the subcommand.
  const argv = process.argv.slice(2);
  const VALUE_FLAGS = new Set(['--only', '--fail-on']);
  let sub = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i += 1; continue; }
    sub = a;
    break;
  }
  if (sub === 'init') return initChecks();
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (o.version) {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  // --hook: terse, surfaces ONLY when something is wrong (for session-start injection).
  if (o.hook) {
    const results = await runChecks({ tier: 'fast', force: o.force });
    const bad = results.filter((r) => r.status === 'fail' || r.status === 'warn');
    if (bad.length) {
      const fails = bad.filter((r) => r.status === 'fail').length;
      const warns = bad.length - fails;
      process.stdout.write(`🩺 agent-doctor: ${fails} fail / ${warns} warn — run /doctor for details + fixes.\n`);
    }
    return 0;
  }

  const results = await runChecks({ tier: o.tier, force: o.force, only: o.only });
  if (o.json) renderJson(results); else render(results, { quiet: o.quiet });

  if (o.failOn) {
    const rank = { pass: 0, skip: 0, warn: 1, fail: 2 };
    const threshold = rank[o.failOn] ?? 2;
    const worst = Math.max(0, ...results.map((r) => rank[r.status] ?? 0));
    return worst >= threshold ? 1 : 0;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`agent-doctor error: ${e?.stack || e}\n`);
  process.exit(0); // never hard-block the host
});
