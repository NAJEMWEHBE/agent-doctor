// Tests for the real MCP handshake probe (replaces reachability-only checking).
// Covers: stdio local servers (spawn + JSON-RPC over stdio) and remote HTTP
// JSON-RPC servers, plus the roll-up verdicts GOOD/WARN/AUTH/DOWN.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpProbe } from '../src/probes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_FIXTURE = join(__dirname, 'fixtures', 'mock-mcp-stdio.js');
const PROTOCOL = '2025-06-18';

let tmpDir;
before(() => { tmpDir = mkdtempSync(join(os.tmpdir(), 'agent-doctor-mcp-')); });
after(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ } });

// Write a temp MCP config file and return its path. `servers` is an mcpServers map.
function writeConfig(name, servers) {
  const p = join(tmpDir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ mcpServers: servers }, null, 2));
  return p;
}

// A local (stdio) server config that runs our mock fixture in a given mode.
function stdioServer(mode) {
  return { command: process.execPath, args: [STDIO_FIXTURE, mode] };
}

// ── Minimal HTTP MCP server for remote-probe tests ────────────────────────────
// mode: 'good' (2 tools) | 'empty' (0 tools) | 'auth' (401) | 'html' (not MCP).
function startHttpMcp(mode) {
  const server = http.createServer((req, res) => {
    if (mode === 'auth') {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
      res.end('unauthorized');
      return;
    }
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>not an mcp server</body></html>');
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { msg = {}; }
      const reply = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (msg.method === 'initialize') {
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-http', version: '0' },
          },
        });
      } else if (msg.method === 'tools/list') {
        const tools = mode === 'empty'
          ? []
          : [{ name: 'alpha', description: 'a', inputSchema: { type: 'object' } }];
        reply({ jsonrpc: '2.0', id: msg.id, result: { tools } });
      } else {
        // notifications/initialized -> no id, just ack.
        res.writeHead(202); res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

// ── stdio (local) probe ───────────────────────────────────────────────────────

test('mcp: stdio server with tools -> pass (handshake GOOD)', async () => {
  const cfg = writeConfig('stdio-good', { mock: stdioServer('good') });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'pass', r.detail);
  assert.match(r.detail, /GOOD/);
});

test('mcp: stdio server with 0 tools -> warn (speaks MCP but 0 tools)', async () => {
  const cfg = writeConfig('stdio-empty', { mock: stdioServer('empty') });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'warn', r.detail);
  assert.match(r.detail, /0 tools/);
});

test('mcp: stdio server that crashes on init -> fail (DOWN)', async () => {
  const cfg = writeConfig('stdio-crash', { mock: stdioServer('crash') });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /DOWN/);
});

test('mcp: stdio server emitting non-JSON noise still handshakes GOOD', async () => {
  const cfg = writeConfig('stdio-noise', { mock: stdioServer('noise') });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'pass', r.detail);
});

// ── HTTP (remote) probe ───────────────────────────────────────────────────────

test('mcp: remote HTTP server with tools -> pass (handshake GOOD)', async () => {
  const { server, url } = await startHttpMcp('good');
  try {
    const cfg = writeConfig('http-good', { remote: { url } });
    const r = await mcpProbe({ config: cfg });
    assert.equal(r.status, 'pass', r.detail);
  } finally { server.close(); }
});

test('mcp: remote HTTP server with 0 tools -> warn', async () => {
  const { server, url } = await startHttpMcp('empty');
  try {
    const cfg = writeConfig('http-empty', { remote: { url } });
    const r = await mcpProbe({ config: cfg });
    assert.equal(r.status, 'warn', r.detail);
    assert.match(r.detail, /0 tools/);
  } finally { server.close(); }
});

test('mcp: remote HTTP server returning 401 -> fail (AUTH)', async () => {
  const { server, url } = await startHttpMcp('auth');
  try {
    const cfg = writeConfig('http-auth', { remote: { url } });
    const r = await mcpProbe({ config: cfg });
    assert.equal(r.status, 'fail', r.detail);
    assert.match(r.detail, /AUTH/);
  } finally { server.close(); }
});

test('mcp: remote HTTP server returning HTML (not MCP) -> fail (DOWN)', async () => {
  const { server, url } = await startHttpMcp('html');
  try {
    const cfg = writeConfig('http-html', { remote: { url } });
    const r = await mcpProbe({ config: cfg });
    assert.equal(r.status, 'fail', r.detail);
    assert.match(r.detail, /DOWN/);
  } finally { server.close(); }
});

// ── roll-up across multiple servers + config edge cases ───────────────────────

test('mcp: mixed GOOD + 0-tools across servers -> warn roll-up', async () => {
  const cfg = writeConfig('mixed', {
    good: stdioServer('good'),
    empty: stdioServer('empty'),
  });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'warn', r.detail);
  assert.match(r.detail, /1\/2 GOOD/);
});

test('mcp: all servers down -> fail roll-up', async () => {
  const cfg = writeConfig('all-down', {
    crash1: stdioServer('crash'),
    bad: { command: 'definitely-not-a-real-binary-xyz', args: [] },
  });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'fail', r.detail);
});

test('mcp: server with neither url nor command -> counted DOWN', async () => {
  const cfg = writeConfig('no-launcher', { broken: { foo: 'bar' } });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /no url\/command/);
});

test('mcp: command with shell metacharacters -> DOWN, never spawned', async () => {
  const cfg = writeConfig('injection', {
    evil: { command: 'node$(touch /tmp/pwned)', args: [] },
    evilArgs: { command: 'node', args: ['; rm -rf /'] },
  });
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /unsafe shell metacharacters/);
});

test('mcp: no config file -> skip', async () => {
  const r = await mcpProbe({ config: join(tmpDir, 'does-not-exist.json') });
  assert.equal(r.status, 'skip');
});

test('mcp: config with empty mcpServers -> skip', async () => {
  const cfg = writeConfig('empty-servers', {});
  const r = await mcpProbe({ config: cfg });
  assert.equal(r.status, 'skip');
});

test('mcp: invalid JSON config -> fail', async () => {
  const p = join(tmpDir, 'bad.json');
  writeFileSync(p, '{ not valid json ');
  const r = await mcpProbe({ config: p });
  assert.equal(r.status, 'fail');
});

test('mcp: per-project mcpServers are discovered (not just root)', async () => {
  const p = join(tmpDir, 'project-scoped.json');
  writeFileSync(p, JSON.stringify({
    projects: { '/some/proj': { mcpServers: { mock: stdioServer('good') } } },
  }));
  const r = await mcpProbe({ config: p });
  assert.equal(r.status, 'pass', r.detail);
});
