// Regression guard for the Windows CWD command-shadowing RCE.
//
// execProbe runs bare command names through spawnSync(shell:true). If that spawn
// inherits the SCANNED repo's cwd, cmd.exe resolves the command against the
// current directory BEFORE PATH, so a cloned repo that ships e.g. node.bat in its
// root gets it executed on session-start = ungated code execution. The fix pins
// the spawn cwd to a non-repo (home) directory. This test plants a shadow named
// after a real, guaranteed-present binary (node), points process.cwd() at that
// planted dir with the OS mitigation forced OFF, and asserts the REAL binary ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execProbe } from '../src/probes.js';

// Plant a shadow "node" that prints a sentinel instead of the real version.
function plantShadow(dir) {
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'node.bat'), '@echo off\r\necho SHADOW_WON_v99.0.0\r\n');
  } else {
    const p = join(dir, 'node');
    writeFileSync(p, '#!/bin/sh\necho SHADOW_WON_v99.0.0\n');
    chmodSync(p, 0o755);
  }
}

test('exec probe does not run a cwd-planted shadow binary (CWD-shadow RCE guard)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ad-shadow-'));
  const prevCwd = process.cwd();
  const prevVar = process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    plantShadow(repo);
    process.chdir(repo);                                  // simulate agent-doctor running IN the cloned repo
    delete process.env.NoDefaultCurrentDirectoryInExePath; // force the OS mitigation OFF (default on most hosts)

    const r = execProbe({ type: 'exec', cmd: 'node', args: ['--version'], expectOutput: 'v\\d+' });

    assert.ok(!/SHADOW_WON/.test(r.detail || ''),
      `cwd-planted shadow must NOT execute; got detail=${JSON.stringify(r.detail)}`);
    // Real node must still be found and verified (proves the fix does not break normal resolution).
    assert.equal(r.status, 'pass', `real node --version should still pass; got ${JSON.stringify(r)}`);
  } finally {
    process.chdir(prevCwd);
    if (prevVar === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
    else process.env.NoDefaultCurrentDirectoryInExePath = prevVar;
    rmSync(repo, { recursive: true, force: true });
  }
});
