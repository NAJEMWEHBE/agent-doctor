// Engine: load checks, filter by tier, run probes, throttle deep network probes.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import {
  execProbe, httpProbe, portProbe, fileJsonProbe, memwriteProbe, mcpProbe, mcpDetectProbe, ollamaTagsProbe, expandPath,
} from './probes.js';
import { isTrusted, trustedChecks } from './trust.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolved lazily so AGENT_DOCTOR_HOME is honored at call time (state relocation + tests).
function dataDir() { return process.env.AGENT_DOCTOR_HOME || join(os.homedir(), '.agent-doctor'); }

const PROBES = {
  exec: execProbe,
  http: httpProbe,
  port: portProbe,
  fileJson: fileJsonProbe,
  memwrite: memwriteProbe,
  mcp: mcpProbe,
  mcpDetect: mcpDetectProbe,
  ollamaTags: ollamaTagsProbe,
};

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Built-in checks + user overrides, merged by id. The home override
// (~/.agent-doctor/checks.json) is the user's own file and always applies. A
// cwd/checks.json is UNTRUSTED (a cloned repo can ship one, and the session-start
// hook would run it), so it applies only when the project is trusted and its hash
// still matches — see trust.js / `agent-doctor trust`.
export function loadChecks() {
  const builtin = loadJson(join(__dirname, '..', 'checks.default.json')) || { checks: [] };
  const byId = new Map(builtin.checks.map((c) => [c.id, c]));
  // cwd/checks.json is UNTRUSTED: verify the pin and parse from a SINGLE read so the
  // bytes we hash-checked are exactly the bytes we run (no verify-then-reparse gap).
  const cwdTrusted = trustedChecks(process.cwd()); // null unless trusted AND hash matches
  // home override (~/.agent-doctor/checks.json) is the user's own trusted file.
  const homeChecks = loadJson(join(dataDir(), 'checks.json'));
  for (const user of [cwdTrusted, homeChecks]) { // cwd first; home overrides it (order unchanged)
    if (user && Array.isArray(user.checks)) {
      for (const c of user.checks) byId.set(c.id, c);
    }
  }
  return [...byId.values()];
}

// Status of a cwd/checks.json for the CLI's one-line "untrusted, ignored" notice.
export function cwdOverrideInfo() {
  const path = join(process.cwd(), 'checks.json');
  const user = loadJson(path);
  if (!user) return { path, present: false, trusted: false, count: 0 };
  const count = Array.isArray(user.checks) ? user.checks.length : 0;
  return { path, present: true, trusted: isTrusted(process.cwd(), path), count };
}

function readCache() { return loadJson(join(dataDir(), 'cache.json')) || {}; }
function writeCache(c) {
  try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(join(dataDir(), 'cache.json'), JSON.stringify(c, null, 2)); } catch { /* non-fatal */ }
}

async function runProbe(check) {
  const fn = PROBES[check.probe?.type];
  if (!fn) return { status: 'skip', detail: `unknown probe type: ${check.probe?.type}` };
  try {
    return await Promise.resolve(fn(check.probe));
  } catch (e) {
    return { status: 'fail', detail: `probe error: ${(e && e.message) || e}` };
  }
}

/**
 * runChecks({ tier:'fast'|'deep', force, only })
 * fast => only fast checks. deep => fast + deep checks.
 */
export async function runChecks({ tier = 'deep', force = false, only = null } = {}) {
  const checks = loadChecks().filter((c) => {
    if (only && c.id !== only && c.group !== only) return false;
    if (tier === 'fast') return (c.tier || 'deep') === 'fast';
    return true;
  });

  const cache = readCache();
  const now = Date.now();
  const results = [];

  for (const c of checks) {
    const ttl = c.throttleHours ? c.throttleHours * 3600_000 : 0;
    const cached = cache[c.id];
    if (ttl && !force && cached && now - cached.at < ttl) {
      results.push({ ...c, ...cached.result, cached: true });
      continue;
    }
    const r = await runProbe(c);
    if (ttl) cache[c.id] = { at: now, result: r };
    results.push({ ...c, ...r, cached: false });
  }

  writeCache(cache);
  return results;
}

// 0-100 health score. SKIP is excluded (absent tools must not penalize).
// pass=1, warn=0.5, fail=0. No scorable checks => 100.
export function scoreResults(results) {
  const weight = { pass: 1, warn: 0.5, fail: 0 };
  let sum = 0;
  let n = 0;
  for (const r of results) {
    if (!(r.status in weight)) continue; // skip 'skip'
    sum += weight[r.status];
    n += 1;
  }
  return n === 0 ? 100 : Math.round((sum / n) * 100);
}

// Group results by their `dimension` field (default 'other'), preserving order.
export function byDimension(results) {
  const groups = new Map();
  for (const r of results) {
    const dim = r.dimension || 'other';
    if (!groups.has(dim)) groups.set(dim, []);
    groups.get(dim).push(r);
  }
  return groups;
}

export { expandPath, dataDir };
