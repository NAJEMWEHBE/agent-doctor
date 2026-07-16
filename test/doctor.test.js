import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { loadChecks, runChecks, scoreResults } from '../src/engine.js';
import { execProbe, fileJsonProbe, interpolateEnv, httpProbe, ollamaTagsProbe, mcpDetectProbe } from '../src/probes.js';

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

test('ollamaTagsProbe passes when Ollama reports pulled models', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/tags');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const r = await ollamaTagsProbe({ url: `http://127.0.0.1:${port}/api/tags` });
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /llama3\.2/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ollamaTagsProbe warns when Ollama is up with no models', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const r = await ollamaTagsProbe({ url: `http://127.0.0.1:${port}/api/tags` });
    assert.equal(r.status, 'warn');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('built-in Ollama check is deep, optional when down, and has a fix hint', () => {
  const checks = loadChecks();
  const c = checks.find((check) => check.id === 'runtime:ollama-models');
  assert.ok(c, 'missing Ollama models check');
  assert.equal(c.dimension, 'runtime');
  assert.equal(c.tier, 'deep');
  assert.equal(c.probe.type, 'ollamaTags');
  assert.equal(c.probe.skipIfDown, true);
  assert.match(c.fix, /ollama pull/);
});

// --- #6: mcp:project-servers — detect project MCP config WITHOUT ever handshaking it ---

// Run body() with process.cwd() pointed at a fresh temp dir; always restore + clean up.
function inTempCwd(body) {
  const dir = mkdtempSync(join(os.tmpdir(), 'mcpdetect-'));
  const prev = process.cwd();
  try { process.chdir(dir); return body(dir); }
  finally { process.chdir(prev); rmSync(dir, { recursive: true, force: true }); }
}

test('mcp:project-servers check is registered, fast tier, detect-only probe', () => {
  const c = loadChecks().find((x) => x.id === 'mcp:project-servers');
  assert.ok(c, 'missing mcp:project-servers check');
  assert.equal(c.dimension, 'mcp');
  assert.equal(c.tier, 'fast');
  assert.equal(c.probe.type, 'mcpDetect');
  assert.ok(c.fix && c.fix.length > 0, 'has a fix hint');
});

test('mcpDetectProbe reports servers from project .mcp.json and classifies transport', () => {
  inTempCwd(() => {
    writeFileSync('.mcp.json', JSON.stringify({
      mcpServers: {
        local1: { command: 'node', args: ['server.js'] },
        remote1: { url: 'https://example.com/mcp' },
      },
    }));
    const r = mcpDetectProbe();
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /2 project MCP server\(s\) detected/);
    assert.match(r.detail, /NOT verified/);
    assert.match(r.detail, /local1 \(local\)/);
    assert.match(r.detail, /remote1 \(remote\)/);
  });
});

test('mcpDetectProbe also reads .claude/settings.json mcpServers', () => {
  inTempCwd(() => {
    mkdirSync('.claude');
    writeFileSync(join('.claude', 'settings.json'), JSON.stringify({ mcpServers: { fromsettings: { url: 'https://x/y' } } }));
    const r = mcpDetectProbe();
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /fromsettings \(remote\)/);
  });
});

test('mcpDetectProbe skips when no project MCP config is present', () => {
  inTempCwd(() => {
    const r = mcpDetectProbe();
    assert.equal(r.status, 'skip');
  });
});

// The security contract: detection must NEVER execute the discovered server.
// Plant a server whose command would create a sentinel file if it were ever spawned,
// and stub global.fetch to throw if the probe tried a network handshake. After the
// probe runs, the sentinel must NOT exist and fetch must NOT have been called — proving
// repo-placeable config never reaches spawn/fetch. If a future change routes project
// config into probeLocalMcp/probeRemoteMcp, this test fails.
test('mcpDetectProbe never spawns the discovered command nor fetches the URL', () => {
  inTempCwd((dir) => {
    const sentinel = join(dir, 'PWNED');
    writeFileSync('.mcp.json', JSON.stringify({
      mcpServers: {
        evil: { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'x')`] },
        remote: { url: 'http://127.0.0.1:1/never' },
      },
    }));
    const realFetch = global.fetch;
    let fetched = false;
    global.fetch = () => { fetched = true; throw new Error('mcpDetect must not fetch'); };
    try {
      const r = mcpDetectProbe();
      assert.equal(r.status, 'pass');
      assert.equal(existsSync(sentinel), false, 'command must not have been spawned');
      assert.equal(fetched, false, 'url must not have been fetched');
    } finally {
      global.fetch = realFetch;
    }
  });
});
