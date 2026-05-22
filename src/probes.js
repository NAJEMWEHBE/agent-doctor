// Probe implementations. Each returns { status, detail }.
// status: 'pass' | 'warn' | 'fail' | 'skip'
// Principle: probe BEHAVIOR, not existence. Judge by output, tolerate weird exit codes.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';

const home = os.homedir();
const require = createRequire(import.meta.url);

export function expandPath(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|[\\/])/, home).replace(/\$\{?HOME\}?/g, home);
}

const NOT_FOUND = /not recognized|not found|no such file|cannot find|Microsoft Store|is not a/i;

// shell:true resolves PATH + .cmd/.exe (for `claude`, `bun`, etc.). Single command string
// avoids the DEP0190 (args + shell) warning.
function runShell(command, timeout = 15000) {
  try {
    const r = spawnSync(command, { encoding: 'utf8', timeout, shell: true, windowsHide: true });
    return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
  } catch { return { out: '', code: null }; }
}

// shell:false + args array — for real binaries (python/sqlite3); ENOENT = absent, no quoting issues.
function runExec(cmd, args = [], timeout = 8000) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true });
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

// http: { url, expectStatus?, timeoutMs?, skipIfDown? }
export async function httpProbe(p) {
  const expect = p.expectStatus || 200;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), p.timeoutMs || 4000);
  try {
    const res = await fetch(p.url, { signal: ctrl.signal, headers: p.headers || {} });
    if (res.status === expect) return { status: 'pass', detail: `HTTP ${res.status}` };
    return { status: 'fail', detail: `HTTP ${res.status} (want ${expect})` };
  } catch (e) {
    if (p.skipIfDown) return { status: 'skip', detail: 'service not running' };
    return { status: 'fail', detail: `unreachable: ${(e && e.message) || e}` };
  } finally {
    clearTimeout(t);
  }
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
    const code = `import sqlite3,sys;c=sqlite3.connect('file:%DB%?mode=ro',uri=True);print(c.execute("%Q%").fetchone()[0])`
      .replace('%DB%', db.replace(/\\/g, '/'))
      .replace('%Q%', query.replace(/"/g, '\\"'));
    const r = runExec(py, ['-c', code], 8000);
    if (r.ran) {
      const n = parseInt((r.out.match(/-?\d+/) || [])[0], 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  // 3) sqlite3 CLI
  const r = runExec('sqlite3', [db, query], 8000);
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
