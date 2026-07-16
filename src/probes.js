// Probe implementations. Each returns { status, detail }.
// status: 'pass' | 'warn' | 'fail' | 'skip'
// Principle: probe BEHAVIOR, not existence. Judge by output, tolerate weird exit codes.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';

const home = os.homedir();
const require = createRequire(import.meta.url);

// Spawn every probe from a NON-repo directory. On Windows, cmd.exe (shell:true)
// and CreateProcess resolve a BARE command name against the child's current
// directory BEFORE PATH — so inheriting the scanned repo's cwd lets a cloned repo
// shadow a probed binary (a planted git.bat / node.bat / npx.cmd runs instead of
// the real tool) = code execution on session-start, with no checks.json and no
// trust. home is user-owned, so a cloned repo cannot plant a shadow there.
const SPAWN_CWD = home;

export function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|[\\/])/, home).replace(/\$\{?HOME\}?/g, home);
}

const NOT_FOUND = /not recognized|not found|no such file|cannot find|Microsoft Store|is not a/i;

// shell:true resolves PATH + .cmd/.exe (for `claude`, `bun`, etc.). Single command string
// avoids the DEP0190 (args + shell) warning.
function runShell(command, timeout = 15000) {
  try {
    const r = spawnSync(command, { encoding: 'utf8', timeout, shell: true, windowsHide: true, cwd: SPAWN_CWD });
    return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
  } catch { return { out: '', code: null }; }
}

// shell:false + args array — for real binaries (python/sqlite3); ENOENT = absent, no quoting issues.
function runExec(cmd, args = [], timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, cwd: SPAWN_CWD });
    if (r.error && r.error.code === 'ENOENT') return { ran: false, out: '' };
    return { ran: true, out: `${r.stdout || ''}${r.stderr || ''}` };
  } catch { return { ran: false, out: '' }; }
}

// exec: { cmd, args?, expectOutput? (regex), missing? ('skip'|'fail') }
export function execProbe(p) {
  const command = [p.cmd, ...(p.args || [])].join(' ');
  const { out } = runShell(command, p.timeoutMs);
  const missing = out.trim() === '' || NOT_FOUND.test(out);
  if (missing) {
    return p.missing === 'fail'
      ? { status: 'fail', detail: `${p.cmd} not found` }
      : { status: 'skip', detail: `${p.cmd} not installed` };
  }
  if (p.expectOutput) {
    const m = out.match(new RegExp(p.expectOutput, 'i'));
    if (m) return { status: 'pass', detail: (m[0] || '').trim().slice(0, 60) };
    if (p.optional) return { status: 'skip', detail: `${p.cmd} present but unverified` };
    return { status: 'fail', detail: `unexpected output: ${out.trim().slice(0, 80)}` };
  }
  return { status: 'pass', detail: out.trim().slice(0, 60) };
}

// Replace ${ENV:NAME} with process.env.NAME. Returns { out, missing[] }.
// Lets checks reference secrets (API keys) without ever printing them.
export function interpolateEnv(str) {
  const missing = [];
  const out = String(str ?? '').replace(/\$\{ENV:([A-Za-z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === '') { missing.push(name); return ''; }
    return v;
  });
  return { out, missing };
}

// http: { url, expectStatus?, timeoutMs?, skipIfDown?, headers? }
// url + header values support ${ENV:VAR}; if a referenced env var is unset, the
// check SKIPs (e.g. an API-key ping with no key set) rather than failing.
export async function httpProbe(p) {
  const expect = p.expectStatus || 200;
  const u = interpolateEnv(p.url);
  const missing = [...u.missing];
  const headers = {};
  for (const [k, v] of Object.entries(p.headers || {})) {
    const hv = interpolateEnv(v);
    missing.push(...hv.missing);
    headers[k] = hv.out;
  }
  if (missing.length) {
    return { status: 'skip', detail: `set ${[...new Set(missing)].join(', ')} to enable` };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), p.timeoutMs || 4000);
  try {
    const res = await fetch(u.out, { signal: ctrl.signal, headers });
    if (res.status === expect) return { status: 'pass', detail: `HTTP ${res.status}` };
    return { status: 'fail', detail: `HTTP ${res.status} (want ${expect})` };
  } catch (e) {
    if (p.skipIfDown) return { status: 'skip', detail: 'service not running' };
    return { status: 'fail', detail: `unreachable: ${(e && e.message) || e}` };
  } finally {
    clearTimeout(t);
  }
}

// ollamaTags: { url?, timeoutMs?, skipIfDown? }
// Checks that Ollama is reachable and has at least one pulled model.
export async function ollamaTagsProbe(p) {
  const url = p.url || 'http://127.0.0.1:11434/api/tags';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), p.timeoutMs || 4000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { status: 'fail', detail: `HTTP ${res.status}` };
    let data;
    try { data = await res.json(); }
    catch { return { status: 'fail', detail: `unexpected non-JSON response from ${url}` }; }
    const models = Array.isArray(data?.models) ? data.models : [];
    if (models.length === 0) {
      return { status: 'warn', detail: 'Ollama is running but no models are pulled' };
    }
    const names = models
      .map((m) => m?.name || m?.model)
      .filter(Boolean)
      .slice(0, 3)
      .join(', ');
    return { status: 'pass', detail: names ? `${models.length} model(s): ${names}` : `${models.length} model(s)` };
  } catch (e) {
    if (p.skipIfDown) return { status: 'skip', detail: 'Ollama not running' };
    return { status: 'fail', detail: `unreachable: ${(e && e.message) || e}` };
  } finally {
    clearTimeout(t);
  }
}

// ── MCP handshake probe ───────────────────────────────────────────────────────
// Probe the PROTOCOL, not the port. Run the real JSON-RPC MCP handshake against
// every configured server and judge by what it actually speaks:
//   initialize -> notifications/initialized -> tools/list
// Remote servers (url): HTTP JSON-RPC POST (Streamable HTTP; parses a JSON body
//   or an SSE `data:` frame). Local servers (command): spawn + speak stdio.
// Per-server verdict:
//   GOOD = handshake ok + >=1 tool   (the MCP twin of "memory actually wrote")
//   WARN = speaks MCP but 0 tools     (silent-failure analogue for MCP)
//   AUTH = 401 / Bearer challenge     (valid endpoint, needs auth)
//   DOWN = unreachable / not MCP / crashed on init / bad JSON-RPC
// Roll-up across all servers: pass = all GOOD, fail = all DOWN/AUTH,
//   warn = anything mixed or any WARN. skip = nothing configured.
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 3000;

// Minimal JSON-RPC request builders for the handshake.
function mcpInitRequest(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-doctor', version: '0' },
    },
  };
}
const MCP_INITIALIZED_NOTIFICATION = { jsonrpc: '2.0', method: 'notifications/initialized' };
function mcpToolsListRequest(id) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

// A streamable-HTTP MCP response can be a plain JSON body OR an SSE stream of
// `event:`/`data:` lines. Extract the first JSON-RPC object either way.
function parseMcpHttpBody(text, contentType = '') {
  const t = (text || '').trim();
  if (!t) return null;
  if (contentType.includes('text/event-stream') || /^event:|^data:/m.test(t)) {
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m && m[1].trim() && m[1].trim() !== '[DONE]') {
        try { return JSON.parse(m[1]); } catch { /* keep scanning */ }
      }
    }
    return null;
  }
  try { return JSON.parse(t); } catch { return null; }
}

// Count tools from a JSON-RPC `tools/list` result, tolerating shape variance.
function countMcpTools(rpc) {
  const tools = rpc && rpc.result && rpc.result.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

// Probe one REMOTE (url-based) MCP server over Streamable HTTP JSON-RPC.
// Returns { verdict, tools, note }.
async function probeRemoteMcp(cfg) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}),
  };
  // Allow ${ENV:VAR} in configured header values (e.g. Authorization) without printing them.
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v.includes('${ENV:')) headers[k] = interpolateEnv(v).out;
  }

  const post = async (body) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), MCP_TIMEOUT_MS);
    try {
      const res = await fetch(cfg.url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
      const ct = res.headers.get('content-type') || '';
      const text = await res.text().catch(() => '');
      const sid = res.headers.get('mcp-session-id');
      return { status: res.status, ct, text, sid };
    } finally { clearTimeout(t); }
  };

  let init;
  try { init = await post(mcpInitRequest(1)); }
  catch (e) { return { verdict: 'DOWN', tools: 0, note: `unreachable: ${(e && e.message) || e}` }; }

  if (init.status === 401 || init.status === 403) {
    return { verdict: 'AUTH', tools: 0, note: `HTTP ${init.status} (auth required)` };
  }
  const initRpc = parseMcpHttpBody(init.text, init.ct);
  if (!initRpc || initRpc.error || !initRpc.result) {
    if (init.status >= 400) return { verdict: 'DOWN', tools: 0, note: `HTTP ${init.status}` };
    return { verdict: 'DOWN', tools: 0, note: 'no valid initialize response (not MCP?)' };
  }
  // Carry the negotiated session id forward, if the server issued one.
  if (init.sid) headers['Mcp-Session-Id'] = init.sid;

  try { await post(MCP_INITIALIZED_NOTIFICATION); } catch { /* notification is best-effort */ }

  let list;
  try { list = await post(mcpToolsListRequest(2)); }
  catch (e) { return { verdict: 'DOWN', tools: 0, note: `tools/list failed: ${(e && e.message) || e}` }; }
  if (list.status === 401 || list.status === 403) {
    return { verdict: 'AUTH', tools: 0, note: `HTTP ${list.status} on tools/list` };
  }
  const listRpc = parseMcpHttpBody(list.text, list.ct);
  if (!listRpc || listRpc.error) {
    return { verdict: 'WARN', tools: 0, note: 'initialized but tools/list errored' };
  }
  const n = countMcpTools(listRpc);
  return n > 0
    ? { verdict: 'GOOD', tools: n, note: `${n} tool(s)` }
    : { verdict: 'WARN', tools: 0, note: 'speaks MCP but 0 tools' };
}

// Quote one shell token so paths/args with spaces survive `shell: true`.
// (We pass a single command string — not an args array — to both keep PATH
// resolution for bare launchers like npx/uvx AND avoid the DEP0190 warning that
// args-with-shell triggers. Tokens with no shell-special chars pass through bare.)
function quoteArg(s) {
  const str = String(s);
  if (str === '') return '""';
  if (/^[A-Za-z0-9_./:\\-]+$/.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

// Probe one LOCAL (command-based) MCP server over stdio JSON-RPC.
// Spawns the configured command, writes newline-delimited JSON-RPC, reads replies.
// Returns { verdict, tools, note }.
function probeLocalMcp(cfg) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buf = '';
    let timer;
    const env = { ...process.env, ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}) };

    const finish = (verdict, tools, note) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child && child.kill(); } catch { /* noop */ }
      resolve({ verdict, tools, note });
    };

    // Build a single quoted command string: keeps PATH resolution for bare
    // launchers (npx/uvx/node/python) while surviving paths/args with spaces.
    const cmdLine = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])]
      .map(quoteArg).join(' ');
    try {
      child = spawn(cmdLine, {
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: true, env, cwd: SPAWN_CWD,
      });
    } catch (e) {
      finish('DOWN', 0, `spawn failed: ${(e && e.message) || e}`);
      return;
    }

    timer = setTimeout(() => finish('DOWN', 0, 'no MCP handshake within timeout'), MCP_TIMEOUT_MS);
    child.on('error', (e) => finish('DOWN', 0, `launch error: ${(e && e.code) || e}`));
    // Swallow async stdin pipe errors (EPIPE). When a server is down/crashed it closes
    // stdin before we write the handshake; the write's EPIPE is emitted asynchronously
    // on the stream, which the try/catch around .write() below CANNOT catch -> it was an
    // unhandled 'error' that crashed the run (a flaky CI failure on the all-down case).
    // The DOWN verdict still comes from 'close'/timeout; we just need to not throw.
    child.stdin.on('error', () => {});
    // If the process dies before we get a tools/list reply, it crashed on init.
    child.on('close', () => finish('DOWN', 0, 'process exited before handshake completed'));

    const send = (obj) => {
      try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* pipe may be gone */ }
    };

    let initialized = false;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      // Process complete newline-delimited JSON-RPC messages.
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // ignore non-JSON log noise
        if (!initialized && msg.id === 1 && msg.result) {
          initialized = true;
          send(MCP_INITIALIZED_NOTIFICATION);
          send(mcpToolsListRequest(2));
        } else if (!initialized && msg.id === 1 && msg.error) {
          finish('DOWN', 0, 'initialize returned an error');
          return;
        } else if (msg.id === 2) {
          if (msg.error) { finish('WARN', 0, 'initialized but tools/list errored'); return; }
          const n = countMcpTools(msg);
          if (n > 0) finish('GOOD', n, `${n} tool(s)`);
          else finish('WARN', 0, 'speaks MCP but 0 tools');
          return;
        }
      }
    });

    // Kick off the handshake.
    send(mcpInitRequest(1));
  });
}

// mcp: { config? } — read an MCP config file (~/.claude.json by default), find
// configured servers (root + per-project mcpServers), and run the REAL MCP
// handshake against each (remote = HTTP/SSE JSON-RPC, local = stdio JSON-RPC).
// pass = all GOOD, warn = any WARN (0 tools) or mixed up/down,
// fail = all DOWN/AUTH, skip = none configured.
export async function mcpProbe(p) {
  const path = expandPath(p.config || '~/.claude.json');
  if (!existsSync(path)) return { status: 'skip', detail: 'no MCP config found' };
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { status: 'fail', detail: `MCP config unreadable or invalid JSON: ${e?.message || e}` }; }
  if (!data || typeof data !== 'object') return { status: 'skip', detail: 'MCP config is not an object' };

  const all = { ...(data.mcpServers || {}) };
  if (data.projects && typeof data.projects === 'object') {
    for (const proj of Object.values(data.projects)) {
      if (proj && proj.mcpServers) Object.assign(all, proj.mcpServers);
    }
  }
  const names = Object.keys(all);
  if (names.length === 0) return { status: 'skip', detail: 'no MCP servers configured' };

  // Handshake every server concurrently — slow/unreachable ones must not serialize the timeouts.
  const probeOne = async ([name, cfg]) => {
    if (!cfg || typeof cfg !== 'object') return { name, verdict: 'DOWN', note: 'bad config' };
    let r;
    if (cfg.url) r = await probeRemoteMcp(cfg);
    else if (cfg.command) r = await probeLocalMcp(cfg);
    else return { name, verdict: 'DOWN', note: 'no url/command' };
    return { name, ...r };
  };
  const reports = await Promise.all(Object.entries(all).map(probeOne));

  const good = reports.filter((r) => r.verdict === 'GOOD');
  const warn = reports.filter((r) => r.verdict === 'WARN');
  const auth = reports.filter((r) => r.verdict === 'AUTH');
  const down = reports.filter((r) => r.verdict === 'DOWN');

  // Compact "name(note)" list for the failing/odd servers, shown in the report.
  const label = (r) => `${r.name} (${r.verdict}${r.note ? `: ${r.note}` : ''})`;

  if (good.length === names.length) {
    return { status: 'pass', detail: `${names.length} MCP server(s), all handshake GOOD` };
  }
  if (good.length === 0 && warn.length === 0) {
    const bad = [...auth, ...down].map(label).join(', ');
    return { status: 'fail', detail: `no MCP server completed a handshake: ${bad}` };
  }
  const problems = [...warn, ...auth, ...down].map(label).join(', ');
  return {
    status: 'warn',
    detail: `${good.length}/${names.length} GOOD; ${problems}`,
  };
}

// port: { host?, port, timeoutMs? }
export function portProbe(p) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (status, detail) => { sock.destroy(); resolve({ status, detail }); };
    sock.setTimeout(p.timeoutMs || 2000);
    sock.once('connect', () => done('pass', `${p.host || '127.0.0.1'}:${p.port} open`));
    sock.once('timeout', () => done(p.skipIfDown ? 'skip' : 'fail', 'timeout'));
    sock.once('error', () => done(p.skipIfDown ? 'skip' : 'fail', 'closed'));
    sock.connect(p.port, p.host || '127.0.0.1');
  });
}

// fileJson: { path, requireKeys?, missing? ('skip'|'fail') }
export function fileJsonProbe(p) {
  const path = expandPath(p.path);
  if (!existsSync(path)) {
    return p.missing === 'fail'
      ? { status: 'fail', detail: `missing: ${p.path}` }
      : { status: 'skip', detail: `not present: ${p.path}` };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { status: 'fail', detail: `invalid JSON: ${(e && e.message) || e}` };
  }
  for (const k of p.requireKeys || []) {
    if (data[k] === undefined || data[k] === '') {
      return { status: 'warn', detail: `key '${k}' empty/missing` };
    }
  }
  return { status: 'pass', detail: 'valid JSON' };
}

// Read a single integer from a SQLite DB via whatever backend is available.
function sqliteScalar(db, query) {
  // 1) node:sqlite (node 22.5+)
  try {
    // eslint-disable-next-line
    const mod = require('node:sqlite');
    const d = new mod.DatabaseSync(db, { readOnly: true });
    const row = d.prepare(query).get();
    d.close();
    if (row) return Number(Object.values(row)[0]);
  } catch { /* fall through */ }
  // 2) python3 / python
  for (const py of ['python3', 'python', 'py']) {
    // Pass db + query as argv (sys.argv) instead of substituting them into the
    // program source, so a path or query containing quotes/backslashes can neither
    // break the generated Python nor inject code. (Carried from #12.)
    const code = "import sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print(c.execute(sys.argv[2]).fetchone()[0])";
    const r = runExec(py, ['-c', code, db.replace(/\\/g, '/'), query], 8000);
    if (r.ran) {
      const n = parseInt((r.out.match(/-?\d+/) || [])[0], 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  // 3) sqlite3 CLI
  // -readonly: the CLI opens the DB read-write by default; memwrite only ever reads a scalar,
  // so deny this fallback any write/ATTACH side-effect from a (trusted-but-hostile) query.
  const r = runExec('sqlite3', ['-readonly', db, query], 8000);
  if (r.ran) {
    const n = parseInt((r.out.match(/-?\d+/) || [])[0], 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

// memwrite (flagship): detect "logging but not writing".
// { db, writesQuery, inputsQuery, minInputs? }
export function memwriteProbe(p) {
  const db = expandPath(p.db);
  if (!existsSync(db)) return { status: 'skip', detail: 'memory DB not present' };
  const writes = sqliteScalar(db, p.writesQuery);
  const inputs = sqliteScalar(db, p.inputsQuery);
  if (writes === null || inputs === null) {
    return { status: 'skip', detail: 'no sqlite backend (need node22 / python / sqlite3)' };
  }
  const minInputs = p.minInputs ?? 5;
  if (inputs >= minInputs && writes === 0) {
    return { status: 'fail', detail: `SILENT FAILURE: ${inputs} inputs logged, ${writes} memories written` };
  }
  if (inputs >= minInputs && writes < inputs * 0.15) {
    return { status: 'warn', detail: `low write ratio: ${writes} written / ${inputs} inputs` };
  }
  return { status: 'pass', detail: `${writes} memories / ${inputs} inputs` };
}
