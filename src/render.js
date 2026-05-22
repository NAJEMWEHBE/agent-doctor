// Render results as a colored table, or JSON.
const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const green = c('32'); const yellow = c('33'); const red = c('31');
const gray = c('90'); const bold = c('1'); const cyan = c('36');

const MARK = {
  pass: { sym: green('✔'), tag: green('PASS') },
  warn: { sym: yellow('!'), tag: yellow('WARN') },
  fail: { sym: red('✖'), tag: red('FAIL') },
  skip: { sym: gray('–'), tag: gray('SKIP') },
};

export function renderJson(results) {
  const slim = results.map((r) => ({
    id: r.id, label: r.label, status: r.status, detail: r.detail,
    tier: r.tier || 'deep', cached: !!r.cached, fix: r.status === 'fail' || r.status === 'warn' ? r.fix : undefined,
  }));
  const summary = counts(results);
  process.stdout.write(JSON.stringify({ summary, checks: slim }, null, 2) + '\n');
}

function counts(results) {
  const s = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) s[r.status] = (s[r.status] || 0) + 1;
  return s;
}

export function render(results, { quiet = false } = {}) {
  const out = [];
  out.push('');
  out.push(`  ${bold('🩺 agent-doctor')} ${gray('— AI coding stack health')}`);
  out.push('');

  const width = Math.max(...results.map((r) => (r.label || r.id).length), 10);
  for (const r of results) {
    if (quiet && (r.status === 'pass' || r.status === 'skip')) continue;
    const m = MARK[r.status] || MARK.skip;
    const label = (r.label || r.id).padEnd(width);
    const cachedTag = r.cached ? gray(' (cached)') : '';
    out.push(`  ${m.sym} ${m.tag}  ${label}  ${gray(r.detail || '')}${cachedTag}`);
    if ((r.status === 'fail' || r.status === 'warn') && r.fix) {
      out.push(`         ${cyan('↳ fix:')} ${r.fix}`);
    }
  }

  const s = counts(results);
  out.push('');
  out.push(
    `  ${green(`${s.pass} pass`)}  ${yellow(`${s.warn} warn`)}  ${red(`${s.fail} fail`)}  ${gray(`${s.skip} skip`)}`,
  );
  if (s.fail === 0 && s.warn === 0) out.push(`  ${green('All systems healthy.')}`);
  else if (s.fail > 0) out.push(`  ${red('Action needed')} — see fixes above.`);
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
