// Integration tests: MCP server processes + watcher + hooks + relay + CLI.  Run: node test.js
const { spawn, execFileSync } = require("child_process");
const os = require("os"), path = require("path"), fs = require("fs"), http = require("http");
const assert = require("assert");
const { fileStore, fmt } = require("./lib");
const { createRelay } = require("./relay");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const here = (f) => path.join(__dirname, f);

function client(env, cwd) {
  const p = spawn("node", [here("server.js")], { env: { ...process.env, ...env }, cwd });
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
const cli = (env, ...args) => execFileSync("node", [here("cli.js"), ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
// Async variant for tests where the relay runs inside this process (a sync exec would block it).
const cliAsync = (env, ...args) => new Promise((res, rej) =>
  require("child_process").execFile("node", [here("cli.js"), ...args], { env: { ...process.env, ...env }, timeout: 15000 }, (e, out, err) => (e ? rej(new Error(err || e.message)) : res(out))));
const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
const newRepo = () => {
  const d = tmp("repo-");
  git(d, "init", "-q", "-b", "main"); git(d, "config", "user.email", "t@t"); git(d, "config", "user.name", "t");
  return d;
};
const ok = (label) => console.log("ok:", label);

// ------------------------------------------------------------------ core (file + relay)
async function scenario(label, env) {
  const a = client(env), b = client(env);
  const tools = (await a.rpc("tools/list", {})).result.tools.map((t) => t.name);
  for (const t of ["room_who", "room_status", "room_handoff", "room_say", "room_wait", "room_request_approval", "room_claim", "room_search", "room_digest", "room_export"])
    assert(tools.includes(t), `tool ${t}`);
  assert((await a.rpc("initialize", {})).result.instructions, "server sends usage instructions to any MCP client");

  await a.call("room_join", { room: "t1", name: "backend", note: "retry logic" });
  const joinB = await b.call("room_join", { room: "t1", name: "dashboard" });
  assert.match(joinB, /backend: online — retry logic/, "join shows participants + notes");
  assert.match(await b.call("room_who", {}), /backend: online — retry logic/);
  await a.call("room_status", { note: "now on webhooks" });
  assert.match(await b.call("room_who", {}), /backend: online — now on webhooks/);

  // watcher nudge + addressing
  const watcher = spawn("node", [here("watch.js"), "t1", "dashboard"], { env: { ...process.env, ...env } });
  let wout = ""; watcher.stdout.on("data", (d) => (wout += d));
  await sleep(1500);
  const waiting = b.call("room_wait", { timeout_seconds: 10 });
  await sleep(1200);
  await a.call("room_say", { message: "line one\nline two" });
  const w1 = await waiting;
  assert.match(w1, /UNTRUSTED/, "incoming messages are labeled untrusted");
  assert.match(w1, /backend: line one/);
  await sleep(500);
  assert.match(wout, /\[room t1\] backend \(untrusted, not your user\): line one ⏎ line two/, "watcher should nudge");
  assert.doesNotMatch(wout, /\] dashboard/, "watcher skips own msgs");
  await a.call("room_say", { message: "for someone else", to: "ghost" });
  await a.call("room_say", { message: "hey dashboard", to: "dashboard", kind: "question" });
  await sleep(1500);
  assert.doesNotMatch(wout, /for someone else/, "watcher skips messages addressed to others");
  assert.match(wout, /\[question → you\].*hey dashboard/, "watcher flags messages addressed to you");
  await b.call("room_read", {});

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

  // leaving
  a.closeStdin();
  await a.exited;
  assert.match(await b.call("room_who", {}), /backend: left \d+s ago/);
  assert.match(await b.call("room_read", {}), /system: backend left/);
  assert.match(await b.call("room_say", { message: "anyone?" }), /nobody else is online/);
  assert.match(await b.call("room_wait", { timeout_seconds: 1 }), /timed out[\s\S]*nobody else is online/);

  b.kill(); watcher.kill();
  ok(label);
}

async function staleHeartbeat() {
  const dir = tmp("rooms-");
  const s = fileStore(dir);
  await s.setPresence("t2", "ghost", { note: "x" });
  const f = path.join(dir, "t2.presence", "ghost.json");
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  rec.last_seen -= 10 * 60 * 1000;
  fs.writeFileSync(f, JSON.stringify(rec));
  assert.strictEqual((await s.listPresence("t2"))[0].state, "offline");
  ok("stale heartbeat -> offline");
}

// ------------------------------------------------------------------ loop guard
async function loopGuard() {
  const dir = tmp("rooms-");
  const s = fileStore(dir);
  const env = { CLAUDE_ROOMS_DIR: dir, CLAUDE_ROOM_MAX_PER_MIN: "3", CLAUDE_ROOM_MAX_AGENT_TURNS: "6" };
  const a = client(env), b = client({ ...env, CLAUDE_ROOM_MAX_PER_MIN: "50" }); // b isolates the turn budget from the rate limit
  await a.call("room_join", { room: "lg", name: "a" });
  await b.call("room_join", { room: "lg", name: "b" });
  assert.match(await a.call("room_say", { message: "one" }), /Sent #/);
  assert.match(await a.call("room_say", { message: "one" }), /Duplicate/, "duplicates are rejected");
  assert.match(await a.call("room_say", { message: "two" }), /Sent #/);
  assert.match(await a.call("room_say", { message: "three" }), /Sent #/);
  assert.match(await a.call("room_say", { message: "four" }), /Rate limit/, "per-minute cap");
  // agent-turn budget: 6 agent messages since a human spoke
  assert.match(await b.call("room_say", { message: "b1" }), /Sent #/);
  assert.match(await b.call("room_say", { message: "b2" }), /Sent #/);
  assert.match(await b.call("room_say", { message: "b3" }), /Sent #/); // 6th agent message
  assert.match(await b.call("room_say", { message: "b4" }), /Conversation budget reached/, "agent-only budget");
  assert.match(await b.call("room_handoff", { summary: "wrapping up" }), /Handoff posted/, "handoffs are exempt");
  await s.append("lg", "arnuv", "ok carry on", { kind: "human" });
  assert.match(await b.call("room_say", { message: "b4" }), /Sent #/, "a human message resets the budget");
  a.kill(); b.kill();
  ok("loop guard (rate limit, duplicates, agent budget, human reset)");
}

// ------------------------------------------------------------------ approvals (file mode) + CLI
async function approvalsAndCli() {
  const dir = tmp("rooms-");
  const env = { CLAUDE_ROOMS_DIR: dir, CLAUDE_ROOM_USER: "arnuv" };
  const a = client(env);
  await a.call("room_join", { room: "ap", name: "diby-claude" });
  const pending = a.call("room_request_approval", { action: "run the migration on prod", why: "asked in room", wait_seconds: 20 });
  await sleep(1500);
  assert.match(cli(env, "pending", "ap"), /Approval requested: run the migration on prod/);
  const id = /#(\d+)/.exec(cli(env, "pending", "ap"))[1];
  assert.match(await a.call("room_approval_status", { id: Number(id) }), /still pending/);
  cli(env, "approve", "ap", id, "go ahead");
  assert.match(await pending, /APPROVED by arnuv: go ahead/);
  assert.match(cli(env, "pending", "ap"), /nothing pending/);

  const p2 = a.call("room_request_approval", { action: "delete the branch", wait_seconds: 20 });
  await sleep(1500);
  const id2 = /#(\d+)/.exec(cli(env, "pending", "ap"))[1];
  cli(env, "deny", "ap", id2, "not now");
  assert.match(await p2, /DENIED by arnuv: not now/);
  const noAnswer = await a.call("room_request_approval", { action: "x", wait_seconds: 1 });
  assert.match(noAnswer, /No decision yet[\s\S]*Don't proceed/, "no decision means don't proceed");

  cli(env, "say", "ap", "please keep going");
  assert.match(cli(env, "tail", "ap", "-n", "5"), /arnuv \[human\]: please keep going/);
  assert.match(cli(env, "rooms"), /ap\t/);
  assert.match(cli(env, "who", "ap"), /diby-claude: online/);
  cli(env, "post", "ap", "ci-bot", "tests failed on main", "--kind", "decision");
  assert.match(cli(env, "tail", "ap", "-n", "2"), /ci-bot \[decision\]: tests failed on main/);
  const md = cli(env, "export", "ap");
  assert.match(md, /# Room: ap/); assert.match(md, /## Decisions/); assert.match(md, /tests failed on main/);
  a.kill();
  ok("approvals + CLI (approve, deny, pending, say, post, export)");
}

// ------------------------------------------------------------------ structure: addressing, search, digest, export
async function structure() {
  const dir = tmp("rooms-"), proj = tmp("proj-");
  const env = { CLAUDE_ROOMS_DIR: dir };
  const a = client(env, proj), b = client(env);
  await a.call("room_join", { room: "st", name: "a" });
  await b.call("room_join", { room: "st", name: "b" });
  await a.call("room_say", { message: "Where is the queue consumer?", to: "b", kind: "question" });
  await a.call("room_say", { message: "Use Postgres for jobs", kind: "decision" });
  let d = await a.call("room_digest", {});
  assert.match(d, /Open questions:[\s\S]*queue consumer/); assert.match(d, /Decisions:[\s\S]*Postgres/);
  const qid = /#(\d+) [\d:]+\] a \[question/.exec(await b.call("room_history", {}))[1];
  await b.call("room_say", { message: "src/worker.js", to: "a", reply_to: Number(qid), kind: "answer" });
  d = await a.call("room_digest", {});
  assert.doesNotMatch(d, /Open questions:[\s\S]*queue consumer/, "answered questions leave the open list");
  assert.match(await a.call("room_search", { query: "worker" }), /src\/worker.js/);
  assert.match(await a.call("room_search", { query: "nothing-here" }), /no messages match/);
  assert.match(await a.call("room_export", {}), /## Transcript/);
  assert.match(await a.call("room_export", { path: "docs/rooms/st.md" }), /Wrote .* docs\/rooms\/st.md/);
  assert(fs.readFileSync(path.join(proj, "docs/rooms/st.md"), "utf8").includes("Use Postgres for jobs"));
  assert.match(await a.call("room_export", { path: "../escape.md" }), /inside the current project/);
  assert(!fs.existsSync(path.join(proj, "..", "escape.md")), "export cannot write outside the project");
  a.kill(); b.kill();
  ok("structure (to/reply_to/kind, search, digest, export)");
}

// ------------------------------------------------------------------ file claims + guard hook
async function claims() {
  const dir = tmp("rooms-");
  const repo = newRepo();
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "x.js"), "1");
  const env = { CLAUDE_ROOMS_DIR: dir };
  const a = client(env, repo), b = client(env, repo);
  await a.call("room_join", { room: "cl", name: "a" });
  await b.call("room_join", { room: "cl", name: "b" });
  assert.match(await a.call("room_claim", { paths: ["src/"], note: "refactoring" }), /Claimed: src/);
  const c = await b.call("room_claim", { paths: ["src/x.js", "docs/"] });
  assert.match(c, /CONFLICT: src\/x.js overlaps src, held by a/); assert.match(c, /Claimed: docs/);
  assert.match(await b.call("room_claims", {}), /src: a/);
  assert.match(await a.call("room_release", { paths: ["src/"] }), /Released: src/);
  assert.match(await b.call("room_claim", { paths: ["src/x.js"] }), /Claimed: src\/x.js/, "released claims can be taken");
  await a.call("room_claim", { paths: ["lib/"] });
  a.closeStdin(); await a.exited;
  assert.match(await b.call("room_claim", { paths: ["lib/util.js"] }), /Claimed: lib\/util.js/, "claims of departed sessions are ignored");
  b.kill(); await sleep(300);

  // guard hook: one member; the other session's claim is planted directly with a live heartbeat
  const s = fileStore(dir);
  const solo = client(env, repo);
  await solo.call("room_join", { room: "cl2", name: "b" });
  await s.setPresence("cl2", "a", { note: "owner" });
  await s.claimSet("cl2", { path: "src", by: "a", note: "refactoring" });
  const guard = (file) => execFileSync("node", [here("claims-guard.js")], { env: { ...process.env, ...env }, cwd: repo, input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: repo }), encoding: "utf8" });
  const denied = JSON.parse(guard(path.join(repo, "src", "x.js")));
  assert.strictEqual(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /claimed by a in room 'cl2'/);
  assert.strictEqual(guard(path.join(repo, "README.md")), "", "unclaimed files are allowed");
  await s.setPresence("cl2", "a", { status: "left" });
  assert.strictEqual(guard(path.join(repo, "src", "x.js")), "", "claims of sessions that left don't block");
  assert.strictEqual(execFileSync("node", [here("claims-guard.js")], { env: { ...process.env, CLAUDE_ROOMS_DIR: tmp("empty-") }, input: JSON.stringify({ tool_input: { file_path: "/x" }, cwd: repo }), encoding: "utf8" }), "", "no room membership -> allow");
  solo.kill();
  ok("file claims + claims-guard hook");
}

// ------------------------------------------------------------------ SessionEnd hook
function hook(env, input) {
  execFileSync("node", [here("handoff.js")], { env: { ...process.env, ...env }, input: JSON.stringify(input), timeout: 10000 });
}
async function handoffHook(label, env, skipWhenBriefed) {
  const repo = newRepo();
  fs.writeFileSync(path.join(repo, "a.js"), "1");
  const c = client(env, repo);
  await c.call("room_join", { room: "t3", name: "diby-claude" });
  await sleep(1100);
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "Add retry with jitter");
  fs.writeFileSync(path.join(repo, "wip.js"), "2");
  const transcript = path.join(repo, "t.jsonl");
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { content: "go" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: retry lives in src/retry.js. Uses META_TOKEN=supersecretvalue123 locally." }] } }),
  ].join("\n"));
  if (skipWhenBriefed) await c.call("room_handoff", { summary: "my own brief" });
  hook(env, { cwd: repo, transcript_path: transcript, reason: "other" });
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
    hook(env, { cwd: repo, transcript_path: transcript });
    assert.strictEqual(((await readRoom()).match(/AUTO HANDOFF/g) || []).length, 1, "posted exactly once");
  }
  hook(env, { cwd: os.tmpdir() });
  c.kill();
  ok(label);
}
async function readOnlySessionIsQuiet() {
  const env = { CLAUDE_ROOMS_DIR: tmp("rooms-") };
  for (const init of [true, false]) {
    const dir = init ? newRepo() : tmp("ro-");
    if (init) { fs.writeFileSync(path.join(dir, "a"), "1"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "old"); await sleep(1100); }
    const c = client(env, dir);
    await c.call("room_join", { room: "t4", name: `asker-${init}` });
    await c.call("room_say", { message: "how does it work?" });
    hook(env, { cwd: dir });
    assert(!(await fileStore(env.CLAUDE_ROOMS_DIR).list("t4", 0)).some((m) => m.kind === "handoff"), `read-only session (init=${init}) must not post a handoff`);
    c.kill();
  }
  ok("read-only sessions post no auto handoff");
}

// ------------------------------------------------------------------ relay: identity, roles, ACL, approvals, TTL, notify, UI
async function relayIdentity() {
  const T = { arnuv: "arnuv-session-token-000000", arnuvA: "arnuv-approver-token-00000", diby: "diby-session-token-0000000", dibyA: "diby-approver-token-000000", guest: "guest-viewer-token-000000" };
  const users = [
    { name: "arnuv", token: T.arnuv, approver_token: T.arnuvA, role: "admin", rooms: ["*"], anonymous: false },
    { name: "diby", token: T.diby, approver_token: T.dibyA, role: "member", rooms: ["webapp*"], anonymous: false },
    { name: "guest", token: T.guest, role: "viewer", rooms: ["*"], anonymous: false },
  ];
  const dir = tmp("relay-");
  const pings = [];
  const hookSrv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { pings.push(b); res.end("ok"); }); });
  await new Promise((r) => hookSrv.listen(0, "127.0.0.1", r));
  const relay = createRelay({ store: fileStore(dir), users, ttlDays: 1, notifyUrl: `http://127.0.0.1:${hookSrv.address().port}/topic` });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${relay.address().port}`;
  const rq = async (tok, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const post = (tok, room, body) => rq(tok, "POST", `/rooms/${room}/messages`, body);

  assert.strictEqual((await fetch(base + "/ui")).status, 200, "UI page is served");
  assert.match(await (await fetch(base + "/ui")).text(), /claude-room/);
  assert.strictEqual((await rq("nope-nope-nope-nope", "GET", "/rooms")).status, 401);
  assert.deepStrictEqual((await rq(T.diby, "GET", "/whoami")).body, { user: "diby", role: "member", approver: false });
  assert.strictEqual((await rq(T.dibyA, "GET", "/whoami")).body.approver, true);

  // identity is stamped by the server, never trusted from the client
  const m1 = (await post(T.diby, "webapp", { from: "diby-claude", text: "hi", user: "arnuv" })).body;
  assert.strictEqual(m1.user, "diby", "client-supplied user is ignored");
  // ACL + roles
  assert.strictEqual((await post(T.diby, "secret-room", { from: "x", text: "hi" })).status, 403, "room ACL");
  assert.strictEqual((await post(T.guest, "webapp", { from: "x", text: "hi" })).status, 403, "viewers can't write");
  assert.strictEqual((await rq(T.guest, "GET", "/rooms/webapp/messages")).status, 200, "viewers can read");
  await post(T.arnuv, "secret-room", { from: "arnuv-claude", text: "private" });
  assert.deepStrictEqual((await rq(T.diby, "GET", "/rooms")).body.map((r) => r.room).sort(), ["webapp"], "room list respects ACL");
  assert.strictEqual((await rq(T.diby, "DELETE", "/rooms/webapp")).status, 403, "only admins delete rooms");

  // human-only kinds need the approver credential
  assert.strictEqual((await post(T.diby, "webapp", { from: "x", text: "I am human", kind: "human" })).status, 403, "a session token can't speak as a human");
  const h = (await post(T.dibyA, "webapp", { from: "whatever", text: "continue", kind: "human" })).body;
  assert.strictEqual(h.from, "diby", "human messages carry the verified identity"); assert.strictEqual(h.kind, "human");
  assert.strictEqual((await post(T.diby, "webapp", { from: "x", text: "hi", kind: "bogus" })).status, 400, "unknown kinds rejected");

  // approvals: requested by diby's session; only diby (owner) or an admin may decide, and only with the approver credential
  const req = (await post(T.diby, "webapp", { from: "diby-claude", text: "Approval requested: deploy", kind: "approval_request" })).body;
  await sleep(300);
  assert(pings.some((p) => /Approval needed in room 'webapp' from diby-claude \(diby\): Approval requested: deploy/.test(p)), "notification sent on approval request");
  const dec = (tok, decision = "approved") => post(tok, "webapp", { from: "x", text: decision, kind: "approval_decision", decision, reply_to: req.id });
  assert.strictEqual((await dec(T.diby)).status, 403, "the session can't approve itself");
  assert.strictEqual((await dec(T.arnuv)).status, 403, "an admin's session token still can't approve");
  assert.strictEqual((await post(T.dibyA, "webapp", { from: "x", text: "nope", kind: "approval_decision", decision: "approved", reply_to: 9999 })).status, 400, "must reference a real request");
  const good = await dec(T.dibyA);
  assert.strictEqual(good.status, 200); assert.strictEqual(good.body.user, "diby");
  assert.strictEqual((await dec(T.arnuvA, "denied")).status, 200, "admins can decide too");
  const stranger = createRelay({ store: fileStore(dir), users: [...users, { name: "eve", token: "eve-session-token-00000000", approver_token: "eve-approver-token-0000000", role: "member", rooms: ["*"], anonymous: false }] });
  await new Promise((r) => stranger.listen(0, "127.0.0.1", r));
  const sr = await fetch(`http://127.0.0.1:${stranger.address().port}/rooms/webapp/messages`, { method: "POST", headers: { authorization: "Bearer eve-approver-token-0000000", "content-type": "application/json" }, body: JSON.stringify({ from: "x", text: "approved", kind: "approval_decision", decision: "approved", reply_to: req.id }) });
  assert.strictEqual(sr.status, 403, "non-owner members can't approve someone else's session");
  stranger.close();

  // claims + presence carry identity
  assert.strictEqual((await rq(T.diby, "PUT", "/rooms/webapp/presence/diby-claude", { note: "x" })).body.user, "diby");
  assert.strictEqual((await rq(T.diby, "PUT", "/rooms/webapp/claims", { path: "src", by: "diby-claude" })).status, 200);
  assert.strictEqual((await rq(T.guest, "PUT", "/rooms/webapp/claims", { path: "src", by: "g" })).status, 403);

  // TTL: idle rooms are deleted, active ones kept
  await post(T.arnuv, "old-room", { from: "a", text: "x" });
  const f = path.join(dir, "old-room.jsonl");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/"ts":"[^"]+"/, `"ts":"${new Date(Date.now() - 3 * 86400000).toISOString()}"`));
  assert.strictEqual(await relay.sweep(), 1, "one idle room swept");
  assert.strictEqual((await rq(T.arnuv, "GET", "/rooms")).body.some((r) => r.room === "old-room"), false);
  assert.strictEqual((await rq(T.arnuv, "GET", "/rooms")).body.some((r) => r.room === "webapp"), true, "active rooms kept");
  assert.strictEqual((await rq(T.arnuv, "DELETE", "/rooms/secret-room")).status, 200, "admin can delete");
  relay.close(); hookSrv.close();
  ok("relay identity, roles, room ACL, approver credential, owner-only approvals, notifications, TTL");
}

// Sessions talk through a relay that has per-person tokens (the shape you and Diby would use).
async function relayWithUsersEndToEnd() {
  const dir = tmp("relay-");
  const users = [{ name: "arnuv", token: "arnuv-session-token-000000", approver_token: "arnuv-approver-token-00000", role: "member", rooms: ["*"], anonymous: false }];
  const relay = createRelay({ store: fileStore(dir), users });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const env = { CLAUDE_ROOMS_DIR: tmp("local-"), CLAUDE_ROOM_URL: `http://127.0.0.1:${relay.address().port}`, CLAUDE_ROOM_TOKEN: users[0].token };
  const a = client(env);
  await a.call("room_join", { room: "e2e", name: "arnuv-claude" });
  await a.call("room_handoff", { summary: "built X" });
  const b = client(env);
  const j = await b.call("room_join", { room: "e2e", name: "other" });
  assert.match(j, /arnuv-claude \(arnuv\): online/, "presence shows the verified user");
  assert.match(j, /arnuv-claude \(arnuv\): 📋 HANDOFF/, "messages show the verified user");
  await assert.rejects(cliAsync(env, "say", "e2e", "hi"), /approver credential/);
  const p = a.call("room_request_approval", { action: "deploy", wait_seconds: 15 });
  await sleep(1200);
  const withAppr = { ...env, CLAUDE_ROOM_APPROVER_TOKEN: users[0].approver_token };
  const id = /#(\d+)/.exec(await cliAsync(withAppr, "pending", "e2e"))[1];
  await cliAsync(withAppr, "approve", "e2e", id, "ship it");
  assert.match(await p, /APPROVED by arnuv: ship it/);
  a.kill(); b.kill(); relay.close();
  ok("sessions + CLI through a relay with per-person tokens");
}

async function localUi() {
  const dir = tmp("rooms-");
  const port = 19000 + Math.floor(Math.random() * 500);
  const p = spawn("node", [here("cli.js"), "ui", "--port", String(port)], { env: { ...process.env, CLAUDE_ROOMS_DIR: dir } });
  let out = ""; p.stdout.on("data", (d) => (out += d));
  for (let i = 0; i < 30 && !out.includes("#token="); i++) await sleep(200);
  const [, token] = /#token=(\w+)&approver=(\w+)/.exec(out);
  const r = await fetch(`http://127.0.0.1:${port}/rooms`, { headers: { authorization: `Bearer ${token}` } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.statSync(path.join(dir, ".ui-token")).mode & 0o777, 0o600, "UI secrets file is private");
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/rooms`)).status, 401);
  p.kill();
  ok("local web view starts, requires its token, secrets file is 0600");
}

(async () => {
  await scenario("file mode", { CLAUDE_ROOMS_DIR: tmp("rooms-") });
  await staleHeartbeat();
  await loopGuard();
  await approvalsAndCli();
  await structure();
  await claims();
  await handoffHook("auto handoff hook", { CLAUDE_ROOMS_DIR: tmp("rooms-") }, false);
  await readOnlySessionIsQuiet();
  await handoffHook("auto handoff skipped when already briefed", { CLAUDE_ROOMS_DIR: tmp("rooms-") }, true);
  await relayIdentity();
  await relayWithUsersEndToEnd();
  await localUi();

  // the real relay.js process with a single shared token (simple mode)
  const port = 18000 + Math.floor(Math.random() * 1000);
  const relay = spawn("node", [here("relay.js")], { env: { ...process.env, PORT: port, HOST: "127.0.0.1", CLAUDE_ROOM_TOKEN: "test-token-0123456789", CLAUDE_ROOMS_DIR: tmp("relay-") } });
  await sleep(800);
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/rooms/t1/messages`)).status, 401, "relay rejects missing token");
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/rooms/t1/presence`)).status, 401, "relay presence needs token");
  await scenario("relay mode (shared token)", { CLAUDE_ROOMS_DIR: tmp("local-"), CLAUDE_ROOM_URL: `http://127.0.0.1:${port}`, CLAUDE_ROOM_TOKEN: "test-token-0123456789" });
  relay.kill();
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
