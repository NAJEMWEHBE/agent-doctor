// memwrite is an observation, not an execution primitive.
//
// The sqlite3 CLI treats each trailing argument as "either an SQL statement or a
// dot-command", and `-readonly` only opens the DATABASE read-only — it does not
// disable meta-commands. So a memwrite query of ".shell <cmd>" would run an OS
// command through a probe that only claims to read a scalar. The node:sqlite and
// python backends reject such a query as invalid SQL, which means it falls through
// to the CLI by construction. sqliteScalar refuses dot-command queries outright.
//
// Defense-in-depth: reaching here at all needs an already-trusted checks.json
// (gated since 0.6.0), which can run commands via an `exec` probe anyway. This
// closes the redundant path and keeps memwrite's read-only contract true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memwriteProbe } from '../src/probes.js';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ad-sqlite-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('memwrite refuses a .shell dot-command query (no OS exec via the sqlite3 CLI)', () => {
  withTmp((dir) => {
    const db = join(dir, 'fake.db');
    writeFileSync(db, ''); // satisfies memwriteProbe's existsSync gate only
    const marker = join(dir, 'PWNED.txt');
    const dotCmd = process.platform === 'win32'
      ? `.shell cmd /c echo pwned> "${marker}"`
      : `.shell sh -c 'echo pwned > "${marker}"'`;

    const r = memwriteProbe({ type: 'memwrite', db, writesQuery: dotCmd, inputsQuery: 'SELECT 1' });

    assert.ok(!existsSync(marker), 'a dot-command query must never execute');
    assert.equal(r.status, 'skip', 'a refused query yields skip, not a fabricated count');
  });
});

test('memwrite refuses a .system dot-command in either query slot', () => {
  withTmp((dir) => {
    const db = join(dir, 'fake.db');
    writeFileSync(db, '');
    const marker = join(dir, 'PWNED2.txt');
    const dotCmd = process.platform === 'win32'
      ? `  .system cmd /c echo pwned> "${marker}"` // leading whitespace must not slip past
      : `  .system sh -c 'echo pwned > "${marker}"'`;

    const r = memwriteProbe({ type: 'memwrite', db, writesQuery: 'SELECT 1', inputsQuery: dotCmd });

    assert.ok(!existsSync(marker), 'leading whitespace must not bypass the dot-command guard');
    assert.equal(r.status, 'skip');
  });
});
