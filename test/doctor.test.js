import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChecks, runChecks, scoreResults } from '../src/engine.js';
import { execProbe, fileJsonProbe, interpolateEnv, httpProbe } from '../src/probes.js';

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

test('interpolateEnv substitutes set vars and reports missing ones', () => {
  process.env.AD_TEST_X = 'hello';
  const a = interpolateEnv('v=${ENV:AD_TEST_X}');
  assert.equal(a.out, 'v=hello');
  assert.equal(a.missing.length, 0);
  const b = interpolateEnv('k=${ENV:AD_TEST_MISSING_ZZZ}');
  assert.deepEqual(b.missing, ['AD_TEST_MISSING_ZZZ']);
  delete process.env.AD_TEST_X; // restore env to keep tests isolated
});

test('httpProbe skips (does not fail/ping) when a referenced env var is unset', async () => {
  const r = await httpProbe({
    url: 'https://example.invalid/v1/models',
    headers: { Authorization: 'Bearer ${ENV:AD_NO_SUCH_KEY_ZZZ}' },
  });
  assert.equal(r.status, 'skip');
});

test('runChecks fast tier returns results with statuses', async () => {
  const results = await runChecks({ tier: 'fast' });
  assert.ok(results.length >= 1);
  for (const r of results) {
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(r.status), `valid status: ${r.status}`);
  }
});

test('v0.5: agent-cli checks present and shaped to skip-when-absent', () => {
  const checks = loadChecks();
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
  const newIds = [
    'agent-cli:cursor',
    'agent-cli:copilot',
    'agent-cli:opencode',
    'agent-cli:qwen',
    'agent-cli:goose',
    'agent-cli:crush',
    'agent-cli:continue',
    'agent-cli:cline',
    'agent-cli:auggie',
    'agent-cli:cody',
  ];
  for (const id of newIds) {
    const c = byId[id];
    assert.ok(c, `missing check: ${id}`);
    assert.equal(c.dimension, 'agents', `${id} dimension`);
    assert.equal(c.tier, 'deep', `${id} tier`);
    assert.ok(c.fix && c.fix.length > 0, `${id} has a fix hint`);
    assert.equal(c.probe.type, 'exec', `${id} probe type`);
    assert.equal(c.probe.missing, 'skip', `${id} skips when absent`);
    assert.ok(Array.isArray(c.probe.args), `${id} has args`);
    assert.ok(typeof c.probe.cmd === 'string' && c.probe.cmd.length > 0, `${id} has cmd`);
  }
});

test('v0.5: an absent agent-cli binary yields skip (not fail)', () => {
  const checks = loadChecks();
  const cursor = checks.find((c) => c.id === 'agent-cli:cursor');
  const r = execProbe({ ...cursor.probe, cmd: 'definitely-not-a-real-binary-xyz' });
  assert.equal(r.status, 'skip');
});
