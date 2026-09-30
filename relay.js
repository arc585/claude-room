#!/usr/bin/env node
// claude-room relay: tiny HTTP server so sessions on different machines can share rooms.
//   CLAUDE_ROOM_TOKEN=<secret> [PORT=8787] [HOST=0.0.0.0] [CLAUDE_ROOMS_DIR=./data] node relay.js
// Put it behind HTTPS (Caddy/nginx/cloudflared) before exposing it to the internet.
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { fileStore } = require("./lib");

const TOKEN = process.env.CLAUDE_ROOM_TOKEN;
if (!TOKEN || TOKEN.length < 16) {
  console.error("Set CLAUDE_ROOM_TOKEN to a secret of at least 16 chars (e.g. `openssl rand -hex 24`).");
  process.exit(1);
}
const store = fileStore(process.env.CLAUDE_ROOMS_DIR || path.join(__dirname, "data"));
const MAX_BODY = 64 * 1024;

const authed = (req) => {
  const got = Buffer.from((req.headers.authorization || "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// Returns the body string, or null after replying 413.
async function readBody(req, res) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) {
      json(res, 413, { error: "too large" });
      return null;
    }
  }
  return body;
}

http
  .createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/health") return json(res, 200, { ok: true });
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const pm = u.pathname.match(/^\/rooms\/([^/]+)\/presence(?:\/([^/]+))?$/);
      if (pm) {
        const room = decodeURIComponent(pm[1]);
        if (req.method === "GET" && !pm[2]) return json(res, 200, await store.listPresence(room));
        if (req.method === "PUT" && pm[2]) {
          const raw = await readBody(req, res);
          if (raw === null) return;
          const p = JSON.parse(raw || "{}");
          return json(res, 200, await store.setPresence(room, decodeURIComponent(pm[2]).slice(0, 40), { note: p.note, status: p.status === "left" ? "left" : "online" }));
        }
        return json(res, 405, { error: "method not allowed" });
      }
      const m = u.pathname.match(/^\/rooms\/([^/]+)\/messages$/);
      if (!m) return json(res, 404, { error: "not found" });
      const room = decodeURIComponent(m[1]);

      if (req.method === "GET") {
        const after = parseInt(u.searchParams.get("after") || "0", 10) || 0;
        const wait = Math.min(parseInt(u.searchParams.get("wait") || "0", 10) || 0, 60);
        return json(res, 200, wait ? await store.wait(room, after, wait * 1000) : await store.list(room, after));
      }
      if (req.method === "POST") {
        const raw = await readBody(req, res);
        if (raw === null) return;
        const { from, text, kind } = JSON.parse(raw);
        if (typeof from !== "string" || typeof text !== "string" || !from || !text)
          return json(res, 400, { error: "from and text required" });
        return json(res, 200, await store.append(room, from.slice(0, 40), text, kind === "handoff" ? "handoff" : undefined));
      }
      json(res, 405, { error: "method not allowed" });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  })
  .listen(process.env.PORT || 8787, process.env.HOST || "0.0.0.0", () =>
    console.log(`claude-room relay listening on ${process.env.HOST || "0.0.0.0"}:${process.env.PORT || 8787}`)
  );
