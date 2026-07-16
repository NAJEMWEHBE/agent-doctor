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

// Read checks.json ONCE and return its parsed contents ONLY if the pinned hash
// matches THOSE exact bytes. This is the trusted-execution entry point: hashing
// and parsing the same buffer closes the verify-vs-execute gap that a separate
// isTrusted() (hash one read) + loadJson() (parse a second read) leaves open — a
// double-read whose two reads a concurrent writer could make diverge. Returns the
// checks object ({ checks: [...] }) when trusted, else null (missing/untrusted/
// hash-mismatch/malformed all fail closed, exactly like isTrusted()).
export function trustedChecks(dir, checksPath = join(dir, 'checks.json')) {
  let buf;
  try { buf = readFileSync(checksPath); } catch { return null; }
  const cur = createHash('sha256').update(buf).digest('hex');
  const rec = loadTrust().trusted[normDir(dir)];
  if (!rec || rec.hash !== cur) return null;
  try {
    const o = JSON.parse(buf.toString('utf8'));
    return o && Array.isArray(o.checks) ? o : null;
  } catch { return null; }
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

// Shape summary for the `trust` command's consent line — an honest capability count so
// the user sees what they are about to allow before pinning the hash.
export function summarizeChecks(path) {
  let checks = [];
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (o && Array.isArray(o.checks)) checks = o.checks;
  } catch { /* leave empty */ }
  // "Runs a command": spawns a process directly (exec, mcp) OR can reach a shell/CLI that
  // runs one — memwrite falls back to the sqlite3 CLI, whose .shell/.system meta-commands
  // execute the OS regardless of a read-only DB, so a hostile query is command-capable.
  const RUN_CMD = new Set(['exec', 'mcp', 'memwrite']);
  // "Can send a secret": httpProbe is the only check type that interpolates ${ENV:VAR} into
  // a fetch (url + header values), so a check can exfiltrate an environment secret to a
  // check-chosen URL. (ollamaTags/port/fileJson do not interpolate env or send a value.)
  const runsCommand = (c) => RUN_CMD.has(c?.probe?.type);
  const exfilsSecret = (c) => {
    const p = c?.probe;
    if (p?.type !== 'http') return false;
    const blob = JSON.stringify(p.url ?? '') + JSON.stringify(p.headers ?? '');
    return blob.includes('${ENV:');
  };
  return {
    total: checks.length,
    runCmd: checks.filter(runsCommand).length,
    exfil: checks.filter(exfilsSecret).length,
  };
}

export { dataDir, normDir, sha256File };
