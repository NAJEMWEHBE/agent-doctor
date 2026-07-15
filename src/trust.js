// Trust store for cwd/checks.json — direnv-style, hash-pinned.
//
// A cwd/checks.json is UNTRUSTED input: a cloned repo can ship one, and every
// probe type is a capability (exec = run a command, http = exfiltrate an env
// secret via ${ENV:VAR} in the URL, memwrite = write a file, mcp = spawn). The
// session-start hook runs checks non-interactively in the project's cwd, so an
// unguarded cwd/checks.json is zero-click code execution on repo-open.
//
// So a cwd/checks.json is inert until the user runs `agent-doctor trust` in that
// directory, which pins {realpath(dir) -> sha256(checks.json)}. Any later run
// (including the hook) loads it only while the path is trusted AND the file still
// matches the pinned hash; editing the file re-locks it.
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

// Resolved lazily (not at module load) so AGENT_DOCTOR_HOME is honored at call
// time — lets users relocate state and lets tests point at a temp home.
function dataDir() { return process.env.AGENT_DOCTOR_HOME || join(os.homedir(), '.agent-doctor'); }
function trustFile() { return join(dataDir(), 'trust.json'); }

// Canonicalize a directory into a stable trust-store key: resolve symlinks/8.3
// names where possible, and case-fold on Windows so C:\Repo and c:\repo match.
function normDir(dir) {
  let p;
  try { p = realpathSync(dir); } catch { p = resolve(dir); }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function sha256File(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
  catch { return null; }
}

export function loadTrust() {
  try {
    const o = JSON.parse(readFileSync(trustFile(), 'utf8'));
    if (o && typeof o === 'object' && o.trusted && typeof o.trusted === 'object') return o;
  } catch { /* fall through to empty store */ }
  return { version: 1, trusted: {} };
}

function saveTrust(store) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(trustFile(), JSON.stringify(store, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// True only if `dir` was trusted AND its checks.json still matches the pinned hash.
// A missing checks.json is trivially not-trusted (nothing to run).
export function isTrusted(dir, checksPath = join(dir, 'checks.json')) {
  const cur = sha256File(checksPath);
  if (!cur) return false;
  const rec = loadTrust().trusted[normDir(dir)];
  return !!rec && rec.hash === cur;
}

// Pin the current checks.json hash for `dir`. Returns { ok, hash } or { ok:false }.
export function trustDir(dir) {
  const hash = sha256File(join(dir, 'checks.json'));
  if (!hash) return { ok: false, reason: 'no checks.json' };
  const store = loadTrust();
  store.trusted[normDir(dir)] = { hash, at: new Date().toISOString() };
  return { ok: saveTrust(store), hash };
}

export function untrustDir(dir) {
  const store = loadTrust();
  const key = normDir(dir);
  const removed = key in store.trusted;
  if (removed) { delete store.trusted[key]; saveTrust(store); }
  return { removed };
}

// Every trusted path with its live status: ok | stale (file changed) | missing.
export function listTrusted() {
  const store = loadTrust();
  return Object.entries(store.trusted).map(([path, rec]) => {
    const cur = sha256File(join(path, 'checks.json'));
    const status = !cur ? 'missing' : cur === rec.hash ? 'ok' : 'stale';
    return { path, hash: rec.hash, at: rec.at, status };
  });
}

// Shape summary for the `trust` command: how many checks, how many spawn a process.
export function summarizeChecks(path) {
  let checks = [];
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (o && Array.isArray(o.checks)) checks = o.checks;
  } catch { /* leave empty */ }
  const runCmd = checks.filter((c) => c?.probe?.type === 'exec' || c?.probe?.type === 'mcp').length;
  return { total: checks.length, runCmd };
}

export { dataDir, normDir, sha256File };
