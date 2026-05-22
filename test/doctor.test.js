import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChecks, runChecks, scoreResults } from '../src/engine.js';
import { execProbe, fileJsonProbe } from '../src/probes.js';

test('loadChecks returns built-in checks', () => {
  const checks = loadChecks();
  assert.ok(Array.isArray(checks));
  assert.ok(checks.length >= 5, 'expected several built-in checks');
  assert.ok(checks.every((c) => c.id && c.probe), 'each check has id + probe');
});

test('execProbe passes for node --version (judge by output)', () => {
  const r = execProbe({ cmd: 'node', args: ['--version'], expectOutput: 'v\\d+\\.\\d+' });
  assert.equal(r.status, 'pass');
});

test('execProbe skips a missing optional binary', () => {
  const r = execProbe({ cmd: 'definitely-not-a-real-binary-xyz', args: ['--version'], missing: 'skip' });
  assert.equal(r.status, 'skip');
});

test('fileJsonProbe skips a missing file by default', () => {
  const r = fileJsonProbe({ path: '/no/such/file-xyz.json' });
  assert.equal(r.status, 'skip');
});

test('scoreResults: pass=100, skip excluded, fail/warn lower', () => {
  assert.equal(scoreResults([{ status: 'pass' }, { status: 'pass' }]), 100);
  assert.equal(scoreResults([{ status: 'pass' }, { status: 'skip' }]), 100); // skip excluded
  assert.equal(scoreResults([{ status: 'pass' }, { status: 'fail' }]), 50);
  assert.equal(scoreResults([{ status: 'warn' }]), 50);
  assert.equal(scoreResults([{ status: 'skip' }]), 100); // nothing scorable -> 100
});

test('runChecks fast tier returns results with statuses', async () => {
  const results = await runChecks({ tier: 'fast' });
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(r.status), `valid status: ${r.status}`);
  }
});
