#!/usr/bin/env node
// agent-doctor — flutter doctor for your AI coding stack.
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, cwdOverrideInfo } from './engine.js';
import { render, renderJson } from './render.js';
import { trustDir, untrustDir, listTrusted, summarizeChecks } from './trust.js';

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
  process.stdout.write(`Wrote starter ${target}\nEdit it to add your own checks (merged over built-ins by id), then run: agent-doctor trust && agent-doctor\n`);
  return 0;
}

// `agent-doctor trust` — pin this project's checks.json so it (and only it) may run.
// `agent-doctor trust --list` — show every trusted path and whether it is still current.
function trustCmd(argv) {
  if (argv.includes('--list')) {
    const rows = listTrusted();
    if (!rows.length) { process.stdout.write('No trusted checks.json paths.\n'); return 0; }
    for (const r of rows) {
      const flag = r.status === 'ok' ? 'ok' : r.status === 'stale' ? 'STALE (edited — re-trust)' : 'MISSING';
      process.stdout.write(`${r.status === 'ok' ? '✓' : '✗'} ${r.path}  [${flag}]\n`);
    }
    return 0;
  }
  const dir = process.cwd();
  const target = join(dir, 'checks.json');
  if (!existsSync(target)) {
    process.stderr.write(`No checks.json in ${dir} to trust. (Run \`agent-doctor init\` to create one.)\n`);
    return 1;
  }
  const { total, runCmd } = summarizeChecks(target);
  const res = trustDir(dir);
  if (!res.ok) { process.stderr.write(`Could not record trust for ${target}.\n`); return 1; }
  process.stdout.write(
    `Trusted ${target}\n`
    + `  ${total} check(s), ${runCmd} that run a command (exec/mcp)\n`
    + `  sha256 ${res.hash.slice(0, 16)}…  (edits re-lock it)\n`
    + `  These now run on \`agent-doctor\` and on session-start.\n`,
  );
  return 0;
}

function untrustCmd() {
  const dir = process.cwd();
  const { removed } = untrustDir(dir);
  process.stdout.write(removed
    ? `Untrusted ${dir} — its checks.json will no longer run.\n`
    : `${dir} was not trusted; nothing to do.\n`);
  return 0;
}

const HELP = `
🩺 agent-doctor — health checks for your AI coding stack

Usage:
  agent-doctor [options]
  agent-doctor init          Write a starter checks.json in the current directory
  agent-doctor trust         Trust this dir's checks.json so it may run (hash-pinned)
  agent-doctor trust --list  List trusted checks.json paths and their status
  agent-doctor untrust       Revoke trust for this dir's checks.json

Reports a 0–100 health score plus per-dimension PASS/WARN/FAIL with fixes.

A checks.json in the current directory is UNTRUSTED until \`agent-doctor trust\`:
a cloned repo can ship one, and every probe can run a command or read a secret,
so it is ignored (by both the CLI and the session-start hook) until you trust it.

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
  if (sub === 'trust') return trustCmd(argv);
  if (sub === 'untrust') return untrustCmd();
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

  // Interactive runs surface an ignored, untrusted cwd/checks.json (once, on stderr
  // so --json stdout stays clean). The hook path above stays silent by design.
  const cwd = cwdOverrideInfo();
  if (cwd.present && !cwd.trusted) {
    process.stderr.write(
      `Ignoring untrusted ./checks.json (${cwd.count} check(s)). `
      + 'Review it, then run `agent-doctor trust` to enable.\n',
    );
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
