// Minimal mock stdio MCP server for tests.
// Speaks newline-delimited JSON-RPC: initialize -> notifications/initialized -> tools/list.
// Behavior is controlled by argv[2]:
//   "good"  -> initialize ok, tools/list returns 2 tools
//   "empty" -> initialize ok, tools/list returns 0 tools  (WARN: speaks MCP, 0 tools)
//   "crash" -> exit immediately on initialize               (DOWN)
//   "noise" -> print non-JSON log lines, then behave like "good"
const mode = process.argv[2] || 'good';

if (mode === 'crash') {
  // Read one line then die before replying — simulates a server that crashes on init.
  process.stdin.once('data', () => process.exit(1));
  // Safety: also exit if nothing arrives.
  setTimeout(() => process.exit(1), 1500);
}

const PROTOCOL = '2025-06-18';
let buf = '';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

process.stdin.on('data', (d) => {
  if (mode === 'crash') return;
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      if (mode === 'noise') process.stdout.write('starting mock server...\nnot json at all\n');
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-stdio', version: '0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      const tools = mode === 'empty'
        ? []
        : [
          { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
          { name: 'beta', description: 'b', inputSchema: { type: 'object' } },
        ];
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    }
    // notifications/initialized has no id -> ignored.
  }
});
