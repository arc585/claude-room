// Integration test: two MCP server processes + watcher, in file mode and relay mode.
const { spawn } = require("child_process");
const os = require("os"), path = require("path"), fs = require("fs");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(env) {
  const p = spawn("node", [path.join(__dirname, "server.js")], { env: { ...process.env, ...env } });
  let buf = "", n = 0; const pending = {};
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending[m.id]?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; pending[id] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  return { call: async (name, args) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text, kill: () => p.kill() };
}

async function scenario(label, env) {
  const a = client(env), b = client(env);
  await a.call("room_join", { room: "t1", name: "backend" });
  const joinB = await b.call("room_join", { room: "t1", name: "dashboard" });
  assert.match(joinB, /backend joined/);

  const watcher = spawn("node", [path.join(__dirname, "watch.js"), "t1", "dashboard"], { env: { ...process.env, ...env } });
  let wout = ""; watcher.stdout.on("data", (d) => (wout += d));
  await sleep(1500);

  const waiting = b.call("room_wait", { timeout_seconds: 10 });
  await sleep(1200);
  await a.call("room_say", { message: "line one\nline two" });
  assert.match(await waiting, /backend: line one/);
  await sleep(500);
  assert.match(wout, /\[room t1\] backend: line one ⏎ line two/, "watcher should nudge");
  assert.doesNotMatch(wout, /joined/, "watcher skips system msgs");
  assert.match(await a.call("room_read", {}), /dashboard joined/);
  assert.strictEqual(await a.call("room_read", {}), "(no new messages)");
  await b.call("room_say", { message: "ack" });
  assert.match(await a.call("room_read", {}), /dashboard: ack/);
  assert.doesNotMatch(wout, /dashboard: ack/, "watcher skips own msgs");
  a.kill(); b.kill(); watcher.kill();
  console.log("ok:", label);
}

(async () => {
  await scenario("file mode", { CLAUDE_ROOMS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "rooms-")) });

  const port = 18000 + Math.floor(Math.random() * 1000);
  const relay = spawn("node", [path.join(__dirname, "relay.js")], {
    env: { ...process.env, PORT: port, HOST: "127.0.0.1", CLAUDE_ROOM_TOKEN: "test-token-0123456789", CLAUDE_ROOMS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "relay-")) },
  });
  await sleep(800);
  const bad = await fetch(`http://127.0.0.1:${port}/rooms/t1/messages`);
  assert.strictEqual(bad.status, 401, "relay rejects missing token");
  await scenario("relay mode", { CLAUDE_ROOM_URL: `http://127.0.0.1:${port}`, CLAUDE_ROOM_TOKEN: "test-token-0123456789" });
  relay.kill();
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
