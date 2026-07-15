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

// Capability summary for the `trust` consent prompt. Trusting a checks.json
// authorizes EVERY probe in it, and each probe type is a capability: exec/mcp spawn
// a process; http/port/ollamaTags make network requests; fileJson/memwrite read
// local files. Separately, a ${ENV:VAR} anywhere in a probe hands that secret to
// the probe's target — e.g. an http url/header `${ENV:OPENAI_API_KEY}` exfiltrates
// the key on every run. Counting only exec/mcp (as this did) understated the risk a
// user is authorizing; disclose the network, file-read, and secret-exfil surfaces too.
export function summarizeChecks(path) {
  let checks = [];
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    if (o && Array.isArray(o.checks)) checks = o.checks;
  } catch { /* leave empty */ }
  const type = (c) => c?.probe?.type;
  const runCmd = checks.filter((c) => type(c) === 'exec' || type(c) === 'mcp').length;
  const network = checks.filter((c) => ['http', 'port', 'ollamaTags'].includes(type(c))).length;
  const reads = checks.filter((c) => ['fileJson', 'memwrite'].includes(type(c))).length;
  // ${ENV:VAR} in any probe field = a secret this check hands to its target.
  const exfil = checks.filter((c) => /\$\{ENV:/.test(JSON.stringify(c?.probe ?? ''))).length;
  return { total: checks.length, runCmd, network, reads, exfil };
}

export { dataDir, normDir, sha256File };
