// Storage backends for claude-room. Both expose the same async interface:
//   list(room, after)            -> messages with id > after
//   append(room, from, text)     -> the stored message
//   wait(room, after, timeoutMs) -> messages with id > after, blocking until some exist or timeout
const fs = require("fs");
const os = require("os");
const path = require("path");

const safe = (room) => String(room).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (room) => path.join(dir, `${safe(room)}.jsonl`);
  const readAll = (room) => {
    try {
      return fs.readFileSync(file(room), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const store = {
    async list(room, after = 0) {
      return readAll(room).filter((m) => m.id > after);
    },
    async append(room, from, text) {
      const all = readAll(room);
      const msg = { id: (all.length ? all[all.length - 1].id : 0) + 1, ts: new Date().toISOString(), from, text };
      fs.appendFileSync(file(room), JSON.stringify(msg) + "\n");
      return msg;
    },
    async wait(room, after, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const msgs = await store.list(room, after);
        if (msgs.length || Date.now() >= deadline) return msgs;
        await sleep(1000);
      }
    },
  };
  return store;
}

function httpStore(baseUrl, token) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = (room, qs = "") => `${base}/rooms/${encodeURIComponent(room)}/messages${qs}`;
  const check = async (res) => {
    if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    list: async (room, after = 0) => check(await fetch(url(room, `?after=${after}`), { headers })),
    append: async (room, from, text) =>
      check(await fetch(url(room), { method: "POST", headers, body: JSON.stringify({ from, text }) })),
    wait: async (room, after, timeoutMs) => {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      const res = await fetch(url(room, `?after=${after}&wait=${secs}`), {
        headers,
        signal: AbortSignal.timeout(secs * 1000 + 10000),
      });
      return check(res);
    },
  };
}

// CLAUDE_ROOM_URL + CLAUDE_ROOM_TOKEN -> shared relay; otherwise local files.
function makeStore() {
  if (process.env.CLAUDE_ROOM_URL) {
    if (!process.env.CLAUDE_ROOM_TOKEN) throw new Error("CLAUDE_ROOM_URL is set but CLAUDE_ROOM_TOKEN is missing");
    return httpStore(process.env.CLAUDE_ROOM_URL, process.env.CLAUDE_ROOM_TOKEN);
  }
  return fileStore(process.env.CLAUDE_ROOMS_DIR || path.join(os.homedir(), ".claude-rooms"));
}

const fmt = (m) => `[#${m.id} ${m.ts.slice(11, 19)}] ${m.from}: ${m.text}`;

module.exports = { fileStore, httpStore, makeStore, fmt, sleep };
