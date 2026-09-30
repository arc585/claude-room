#!/usr/bin/env node
// claude-room relay: small HTTP server so sessions on different machines can share rooms, with
// per-person tokens, roles, room access lists, an approver credential, expiry, notifications and a web UI.
//
//   CLAUDE_ROOM_USERS=users.json node relay.js        # per-person tokens (recommended)
//   CLAUDE_ROOM_TOKEN=<secret> node relay.js          # single shared token (simple)
//
// users.json: { "arnuv": { "token": "...", "approver_token": "...", "role": "admin" },
//               "diby":  { "token": "...", "approver_token": "...", "role": "member", "rooms": ["webapp*"] },
//               "guest": { "token": "...", "role": "viewer" } }
//   role: admin (everything, can delete rooms) | member (read/write) | viewer (read only)
//   rooms: optional access list, "*" or "prefix*" or exact names (default all)
//   token: what a Claude session uses. approver_token: what a HUMAN uses to approve actions and post
//          as a human. Keep it out of any session's environment: a session holding it could approve itself.
// Optional env: PORT, HOST, CLAUDE_ROOMS_DIR, CLAUDE_ROOM_TTL_DAYS (delete idle rooms),
//               CLAUDE_ROOM_NOTIFY_URL (Slack webhook or ntfy topic URL, pinged on approval requests).
// Put it behind HTTPS (Caddy/nginx/cloudflared) before exposing it to the internet.
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { fileStore, cleanOpts, AGENT_KINDS, HUMAN_KINDS } = require("./lib");

const MAX_BODY = 64 * 1024;
const eq = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

function loadUsers(env = process.env) {
  let users = [];
  if (env.CLAUDE_ROOM_USERS) {
    const raw = JSON.parse(fs.readFileSync(env.CLAUDE_ROOM_USERS, "utf8"));
    users = Object.entries(raw).map(([name, u]) => ({ name, token: u.token, approver_token: u.approver_token, role: u.role || "member", rooms: u.rooms || ["*"], anonymous: false }));
  } else if (env.CLAUDE_ROOM_TOKEN) {
    users = [{ name: "shared", token: env.CLAUDE_ROOM_TOKEN, approver_token: env.CLAUDE_ROOM_APPROVER_TOKEN, role: "member", rooms: ["*"], anonymous: true }];
  }
  for (const u of users) {
    if (!u.token || u.token.length < 16) throw new Error(`user '${u.name}': token must be at least 16 chars (openssl rand -hex 24)`);
    if (u.approver_token && (u.approver_token.length < 16 || u.approver_token === u.token)) throw new Error(`user '${u.name}': approver_token must be 16+ chars and differ from token`);
    if (!["admin", "member", "viewer"].includes(u.role)) throw new Error(`user '${u.name}': bad role '${u.role}'`);
  }
  return users;
}

function createRelay({ store, users, ttlDays, notifyUrl }) {
  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const authenticate = (req) => {
    const got = (req.headers.authorization || "").replace(/^Bearer /, "");
    for (const u of users) {
      if (eq(got, u.token)) return { user: u.name, role: u.role, rooms: u.rooms, anonymous: u.anonymous, approver: false };
      if (u.approver_token && eq(got, u.approver_token)) return { user: u.name, role: u.role, rooms: u.rooms, anonymous: u.anonymous, approver: true };
    }
    return null;
  };
  const roomAllowed = (a, room) => a.rooms.some((p) => p === "*" || (p.endsWith("*") ? room.startsWith(p.slice(0, -1)) : p === room));
  async function readBody(req, res) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) {
        json(res, 413, { error: "too large" });
        return null;
      }
    }
    return body || "{}";
  }
  function notify(text) {
    if (!notifyUrl) return;
    const slack = /hooks\.slack\.com/.test(notifyUrl);
    fetch(notifyUrl, {
      method: "POST",
      headers: slack ? { "content-type": "application/json" } : { Title: "claude-room", Priority: "high" },
      body: slack ? JSON.stringify({ text }) : text,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  async function sweep() {
    if (!ttlDays) return 0;
    let n = 0;
    for (const r of await store.listRooms()) {
      if (r.last_ts && Date.now() - Date.parse(r.last_ts) > ttlDays * 86400000) {
        await store.deleteRoom(r.room);
        n++;
      }
    }
    return n;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/health") return json(res, 200, { ok: true });
      if (u.pathname === "/ui" || u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(path.join(__dirname, "ui", "index.html")));
      }
      const a = authenticate(req);
      if (!a) return json(res, 401, { error: "unauthorized" });
      const write = req.method !== "GET";
      if (write && a.role === "viewer") return json(res, 403, { error: "read-only user" });

      if (u.pathname === "/whoami") return json(res, 200, { user: a.anonymous ? null : a.user, role: a.role, approver: a.approver });
      if (u.pathname === "/rooms" && req.method === "GET") {
        return json(res, 200, (await store.listRooms()).filter((r) => roomAllowed(a, r.room)));
      }
      const m = u.pathname.match(/^\/rooms\/([^/]+)(?:\/(messages|presence|claims)(?:\/([^/]+))?)?$/);
      if (!m) return json(res, 404, { error: "not found" });
      const room = decodeURIComponent(m[1]);
      if (!roomAllowed(a, room)) return json(res, 403, { error: "no access to this room" });
      const stamp = a.anonymous ? undefined : a.user;

      if (!m[2]) {
        if (req.method === "DELETE") {
          if (a.role !== "admin") return json(res, 403, { error: "admin only" });
          await store.deleteRoom(room);
          return json(res, 200, { ok: true });
        }
        return json(res, 405, { error: "method not allowed" });
      }

      if (m[2] === "presence") {
        if (req.method === "GET" && !m[3]) return json(res, 200, await store.listPresence(room));
        if (req.method === "PUT" && m[3]) {
          const raw = await readBody(req, res);
          if (raw === null) return;
          const p = JSON.parse(raw);
          return json(res, 200, await store.setPresence(room, decodeURIComponent(m[3]).slice(0, 40), { note: p.note, status: p.status === "left" ? "left" : "online", user: stamp }));
        }
        return json(res, 405, { error: "method not allowed" });
      }

      if (m[2] === "claims") {
        if (req.method === "GET") return json(res, 200, await store.claimsList(room));
        if (req.method === "PUT") {
          const raw = await readBody(req, res);
          if (raw === null) return;
          const c = JSON.parse(raw);
          if (typeof c.path !== "string" || !c.path || typeof c.by !== "string") return json(res, 400, { error: "path and by required" });
          return json(res, 200, await store.claimSet(room, { path: c.path.slice(0, 300), by: c.by.slice(0, 40), note: c.note }));
        }
        if (req.method === "DELETE") return json(res, 200, await store.claimDel(room, u.searchParams.get("path") || ""));
        return json(res, 405, { error: "method not allowed" });
      }

      // messages
      if (req.method === "GET") {
        const after = parseInt(u.searchParams.get("after") || "0", 10) || 0;
        const wait = Math.min(parseInt(u.searchParams.get("wait") || "0", 10) || 0, 60);
        return json(res, 200, wait ? await store.wait(room, after, wait * 1000) : await store.list(room, after));
      }
      if (req.method === "POST") {
        const raw = await readBody(req, res);
        if (raw === null) return;
        const b = JSON.parse(raw);
        if (typeof b.from !== "string" || typeof b.text !== "string" || !b.from || !b.text) return json(res, 400, { error: "from and text required" });
        if (b.text.length > 20000) return json(res, 413, { error: "message too long" });
        const opts = cleanOpts(b);
        delete opts.user; // never trust a client-supplied identity
        if (opts.kind && ![...AGENT_KINDS, ...HUMAN_KINDS].includes(opts.kind)) return json(res, 400, { error: `unknown kind '${opts.kind}'` });
        let from = b.from.slice(0, 40);
        if (opts.kind && HUMAN_KINDS.includes(opts.kind)) {
          if (!a.approver) return json(res, 403, { error: `kind '${opts.kind}' requires the approver credential` });
          if (!a.anonymous) from = a.user;
        }
        if (opts.kind === "approval_decision") {
          if (!["approved", "denied"].includes(opts.decision) || !opts.reply_to) return json(res, 400, { error: "decision (approved|denied) and reply_to required" });
          const reqMsg = (await store.list(room, Number(opts.reply_to) - 1)).find((x) => x.id === Number(opts.reply_to));
          if (!reqMsg || reqMsg.kind !== "approval_request") return json(res, 400, { error: "reply_to must be an approval_request" });
          if (reqMsg.user && !a.anonymous && a.user !== reqMsg.user && a.role !== "admin")
            return json(res, 403, { error: `only ${reqMsg.user} (the session's owner) or an admin can decide this` });
        }
        const msg = await store.append(room, from, b.text, { ...opts, user: stamp });
        if (opts.kind === "approval_request") notify(`Approval needed in room '${room}' from ${from}${stamp ? ` (${stamp})` : ""}: ${b.text.slice(0, 300)}`);
        return json(res, 200, msg);
      }
      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
  server.sweep = sweep;
  if (ttlDays) setInterval(() => sweep().catch(() => {}), 3600 * 1000).unref();
  return server;
}

module.exports = { createRelay, loadUsers };

if (require.main === module) {
  let users;
  try {
    users = loadUsers();
    if (!users.length) throw new Error("Set CLAUDE_ROOM_USERS=<users.json> (per-person tokens) or CLAUDE_ROOM_TOKEN=<secret>. Generate secrets with `openssl rand -hex 24`.");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const host = process.env.HOST || "0.0.0.0", port = process.env.PORT || 8787;
  createRelay({
    store: fileStore(process.env.CLAUDE_ROOMS_DIR || path.join(__dirname, "data")),
    users,
    ttlDays: Number(process.env.CLAUDE_ROOM_TTL_DAYS) || 0,
    notifyUrl: process.env.CLAUDE_ROOM_NOTIFY_URL,
  }).listen(port, host, () => console.log(`claude-room relay listening on ${host}:${port} (${users.length} user${users.length === 1 ? "" : "s"}); UI at /ui`));
}
