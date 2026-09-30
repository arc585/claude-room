// Integration tests: MCP server processes + watcher + SessionEnd hook, in file mode and relay mode.
const { spawn, execFileSync } = require("child_process");
const os = require("os"), path = require("path"), fs = require("fs");
const assert = require("assert");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function client(env, cwd) {
  const p = spawn("node", [path.join(__dirname, "server.js")], { env: { ...process.env, ...env }, cwd });
  let buf = "", n = 0; const pending = {};
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending[m.id]?.(m); } });
  const rpc = (method, params) => new Promise((r) => { const id = ++n; pending[id] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  return {
    rpc,
    call: async (name, args) => (await rpc("tools/call", { name, arguments: args })).result.content[0].text,
    kill: () => p.kill("SIGTERM"),
    closeStdin: () => p.stdin.end(),
    exited: new Promise((r) => p.on("exit", r)),
  };
}

async function scenario(label, env) {
  const a = client(env), b = client(env);
  const tools = (await a.rpc("tools/list", {})).result.tools.map((t) => t.name);
  for (const t of ["room_who", "room_status", "room_handoff", "room_say", "room_wait"]) assert(tools.includes(t), `tool ${t}`);

  await a.call("room_join", { room: "t1", name: "backend", note: "retry logic" });
  const joinB = await b.call("room_join", { room: "t1", name: "dashboard" });
  assert.match(joinB, /backend: online — retry logic/, "join shows participants + notes");

  // presence
  assert.match(await b.call("room_who", {}), /backend: online — retry logic/);
  await a.call("room_status", { note: "now on webhooks" });
  assert.match(await b.call("room_who", {}), /backend: online — now on webhooks/);

  // watcher nudge
  const watcher = spawn("node", [path.join(__dirname, "watch.js"), "t1", "dashboard"], { env: { ...process.env, ...env } });
  let wout = ""; watcher.stdout.on("data", (d) => (wout += d));
  await sleep(1500);
  const waiting = b.call("room_wait", { timeout_seconds: 10 });
  await sleep(1200);
  await a.call("room_say", { message: "line one\nline two" });
  assert.match(await waiting, /backend: line one/);
  await sleep(500);
  assert.match(wout, /\[room t1\] backend: line one ⏎ line two/, "watcher should nudge");
  assert.doesNotMatch(wout, /\] dashboard:/, "watcher skips own msgs");

  // redaction
  const said = await a.call("room_say", { message: "use META_TOKEN=abc123456789xyz and key sk-abcdefghijklmnop1234 ok" });
  assert.match(said, /redacted/);
  const got = await b.call("room_read", {});
  assert.doesNotMatch(got, /abc123456789xyz|sk-abcdefghijklmnop1234/, "secrets must not reach the room");
  assert.match(got, /META_TOKEN=\[redacted\]/);

  // handoff surfaces on join
  await a.call("room_handoff", { summary: "added retry with jitter", files: ["src/retry.js"], how_to_test: "node test", open_questions: "cap value?" });
  const late = client(env);
  const joinLate = await late.call("room_join", { room: "t1", name: "newcomer" });
  assert.match(joinLate, /Latest handoff notes:\n\[#\d+ [\d:]+\] backend: 📋 HANDOFF from backend\nSummary: added retry with jitter\nKey files: src\/retry.js/);
  late.kill();

  // leaving: graceful close marks 'left', announces it, and warns people who talk to an empty room
  a.closeStdin();
  await a.exited;
  assert.match(await b.call("room_who", {}), /backend: left \d+s ago/);
  assert.match(await b.call("room_read", {}), /system: backend left/);
  assert.match(await b.call("room_say", { message: "anyone?" }), /nobody else is online/);
  assert.match(await b.call("room_wait", { timeout_seconds: 1 }), /timed out[\s\S]*nobody else is online/);

  b.kill(); watcher.kill();
  console.log("ok:", label);
}

// A heartbeat that stops (crashed/killed session) reads as offline, not online.
async function staleHeartbeat() {
  const dir = tmp("rooms-");
  const { fileStore } = require("./lib");
  const s = fileStore(dir);
  await s.setPresence("t2", "ghost", { note: "x" });
  const f = path.join(dir, "t2.presence", "ghost.json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.last_seen -= 10 * 60 * 1000;
  fs.writeFileSync(f, JSON.stringify(rec));
  const [p] = await s.listPresence("t2");
  assert.strictEqual(p.state, "offline");
  console.log("ok: stale heartbeat -> offline");
}

// SessionEnd hook: posts an auto handoff for the session's room, once, with secrets redacted.
function hook(env, input) {
  execFileSync("node", [path.join(__dirname, "handoff.js")], { env: { ...process.env, ...env }, input: JSON.stringify(input), timeout: 10000 });
}
async function handoffHook(label, env, skipWhenBriefed) {
  const repo = tmp("repo-");
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.js"), "1");
  const c = client(env, repo);
  await c.call("room_join", { room: "t3", name: "diby-claude" });
  await sleep(1100); // commit must land after the join timestamp (second granularity in git log --since)
  git("add", "-A"); git("commit", "-q", "-m", "Add retry with jitter");
  fs.writeFileSync(path.join(repo, "wip.js"), "2");
  const transcript = path.join(repo, "t.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { content: "go" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: retry lives in src/retry.js. Uses META_TOKEN=supersecretvalue123 locally." }] } }),
  ].join("\n"));
  if (skipWhenBriefed) await c.call("room_handoff", { summary: "my own brief" });

  hook(env, { cwd: repo, transcript_path: transcript, reason: "other" });

  const { fileStore, fmt } = require("./lib");
  const readRoom = async () => (await fileStore(env.CLAUDE_ROOMS_DIR).list("t3", 0)).map(fmt).join("\n");
  const hist = await readRoom();
  if (skipWhenBriefed) {
    assert.doesNotMatch(hist, /AUTO HANDOFF/, "no auto handoff when session already briefed");
  } else {
    assert(hist.includes("AUTO HANDOFF"), `no auto handoff posted. history:\n${hist}`);
    const full = hist.slice(hist.indexOf("AUTO HANDOFF"));
    assert.match(full, /AUTO HANDOFF from diby-claude \(session ended: other\)/);
    assert.match(full, /Branch: main @ [0-9a-f]+/);
    assert.match(full, /Commits this session:\n[0-9a-f]+ Add retry with jitter/);
    assert.match(full, /Uncommitted changes \(\d+\):\n\?\? (t\.jsonl|wip\.js)/);
    assert.match(full, /Last message from the session:\nDone: retry lives in src\/retry\.js/);
    assert.doesNotMatch(hist, /supersecretvalue123/, "secret in transcript must be redacted");
    // the hook consumed the membership; running it again must not double-post
    hook(env, { cwd: repo, transcript_path: transcript });
    const again = await readRoom();
    assert.strictEqual((again.match(/AUTO HANDOFF/g) || []).length, 1, "posted exactly once");
  }
  // unrelated sessions (no membership) are ignored
  hook(env, { cwd: os.tmpdir() });
  c.kill();
  console.log("ok:", label);
}

// A session that only read/asked (clean repo, or no repo) has nothing to hand off: no noise.
async function readOnlySessionIsQuiet() {
  const env = { CLAUDE_ROOMS_DIR: tmp("rooms-") };
  for (const [label, init] of [["clean repo", true], ["not a repo", false]]) {
    const dir = tmp("ro-");
    if (init) {
      const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
      g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
      fs.writeFileSync(path.join(dir, "a"), "1"); g("add", "-A"); g("commit", "-q", "-m", "old");
      await sleep(1100); // git --since has 1s precision; the old commit predates the session
    }
    const c = client(env, dir);
    await c.call("room_join", { room: "t4", name: `asker-${init}` });
    await c.call("room_say", { message: "how does it work?" });
    hook(env, { cwd: dir });
    const { fileStore } = require("./lib");
    const msgs = await fileStore(env.CLAUDE_ROOMS_DIR).list("t4", 0);
    assert(!msgs.some((m) => m.kind === "handoff"), `read-only session (${label}) must not post a handoff`);
    c.kill();
  }
  console.log("ok: read-only sessions post no auto handoff");
}

(async () => {
  await scenario("file mode", { CLAUDE_ROOMS_DIR: tmp("rooms-") });
  await staleHeartbeat();
  await handoffHook("auto handoff hook", { CLAUDE_ROOMS_DIR: tmp("rooms-") }, false);
  await readOnlySessionIsQuiet();
  await handoffHook("auto handoff skipped when already briefed", { CLAUDE_ROOMS_DIR: tmp("rooms-") }, true);

  const port = 18000 + Math.floor(Math.random() * 1000);
  const relay = spawn("node", [path.join(__dirname, "relay.js")], {
    env: { ...process.env, PORT: port, HOST: "127.0.0.1", CLAUDE_ROOM_TOKEN: "test-token-0123456789", CLAUDE_ROOMS_DIR: tmp("relay-") },
  });
  await sleep(800);
  const bad = await fetch(`http://127.0.0.1:${port}/rooms/t1/messages`);
  assert.strictEqual(bad.status, 401, "relay rejects missing token");
  const badP = await fetch(`http://127.0.0.1:${port}/rooms/t1/presence`);
  assert.strictEqual(badP.status, 401, "relay presence needs token");
  await scenario("relay mode", { CLAUDE_ROOMS_DIR: tmp("local-"), CLAUDE_ROOM_URL: `http://127.0.0.1:${port}`, CLAUDE_ROOM_TOKEN: "test-token-0123456789" });
  relay.kill();
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
