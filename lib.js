// Storage backends for claude-room. Both expose the same async interface:
//   list(room, after)                 -> messages with id > after
//   append(room, from, text, kind?)   -> the stored message (kind: "handoff" | undefined)
//   wait(room, after, timeoutMs)      -> messages with id > after, blocking until some exist or timeout
//   setPresence(room, name, {note?, status?}) -> heartbeat / status update
//   listPresence(room)                -> [{name, note, state, age_s}]  state: online | offline | left
const fs = require("fs");
const os = require("os");
const path = require("path");

const safe = (room) => String(room).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ONLINE_WINDOW_S = 45; // heartbeats arrive every ~15s

const presenceState = (rec, ageS) => (rec.status === "left" ? "left" : ageS < ONLINE_WINDOW_S ? "online" : "offline");

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (room) => path.join(dir, `${safe(room)}.jsonl`);
  const presDir = (room) => path.join(dir, `${safe(room)}.presence`);
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
    async append(room, from, text, kind) {
      const all = readAll(room);
      const msg = { id: (all.length ? all[all.length - 1].id : 0) + 1, ts: new Date().toISOString(), from, text };
      if (kind) msg.kind = kind;
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
    // One file per participant: atomic writes, no read-modify-write races.
    async setPresence(room, name, { note, status = "online" } = {}) {
      const d = presDir(room);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, `${safe(name)}.json`);
      let prev = {};
      try {
        prev = JSON.parse(fs.readFileSync(f, "utf8"));
      } catch {}
      const rec = { name, note: note !== undefined ? String(note).slice(0, 200) : prev.note || "", status, last_seen: Date.now() };
      fs.writeFileSync(f, JSON.stringify(rec));
      return rec;
    },
    async listPresence(room) {
      const d = presDir(room);
      let files = [];
      try {
        files = fs.readdirSync(d);
      } catch {}
      return files
        .map((f) => {
          try {
            const rec = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
            const age_s = Math.max(0, Math.round((Date.now() - rec.last_seen) / 1000));
            return { name: rec.name, note: rec.note, state: presenceState(rec, age_s), age_s };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
  };
  return store;
}

function httpStore(baseUrl, token) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = (room, tail = "messages", qs = "") => `${base}/rooms/${encodeURIComponent(room)}/${tail}${qs}`;
  const check = async (res) => {
    if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    list: async (room, after = 0) => check(await fetch(url(room, "messages", `?after=${after}`), { headers })),
    append: async (room, from, text, kind) =>
      check(await fetch(url(room), { method: "POST", headers, body: JSON.stringify({ from, text, kind }) })),
    wait: async (room, after, timeoutMs) => {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      const res = await fetch(url(room, "messages", `?after=${after}&wait=${secs}`), {
        headers,
        signal: AbortSignal.timeout(secs * 1000 + 10000),
      });
      return check(res);
    },
    setPresence: async (room, name, p = {}) =>
      check(await fetch(url(room, `presence/${encodeURIComponent(name)}`), { method: "PUT", headers, body: JSON.stringify(p) })),
    listPresence: async (room) => check(await fetch(url(room, "presence"), { headers })),
  };
}

// Where per-machine state lives (local rooms, session membership used by the SessionEnd hook).
const localDir = () => process.env.CLAUDE_ROOMS_DIR || path.join(os.homedir(), ".claude-rooms");

// CLAUDE_ROOM_URL + CLAUDE_ROOM_TOKEN -> shared relay; otherwise local files.
function makeStore() {
  if (process.env.CLAUDE_ROOM_URL) {
    if (!process.env.CLAUDE_ROOM_TOKEN) throw new Error("CLAUDE_ROOM_URL is set but CLAUDE_ROOM_TOKEN is missing");
    return httpStore(process.env.CLAUDE_ROOM_URL, process.env.CLAUDE_ROOM_TOKEN);
  }
  return fileStore(localDir());
}

const fmt = (m) => `[#${m.id} ${m.ts.slice(11, 19)}] ${m.from}: ${m.text}`;

const fmtAge = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

// Human-readable participant list.
function fmtPresence(list, selfName) {
  if (!list.length) return "(nobody has joined yet)";
  const order = { online: 0, offline: 1, left: 2 };
  return list
    .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name))
    .map((p) => {
      const when = p.state === "online" ? "online" : p.state === "left" ? `left ${fmtAge(p.age_s)} ago` : `no heartbeat for ${fmtAge(p.age_s)} (probably closed)`;
      return `- ${p.name}${p.name === selfName ? " (you)" : ""}: ${when}${p.note ? ` — ${p.note}` : ""}`;
    })
    .join("\n");
}

// Best-effort secret scrubbing before anything is posted to a room. Not a guarantee.
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*)\s*[=:]\s*)(?!\[redacted\])["']?[^\s"']{6,}/gi,
];
function redact(text) {
  let count = 0;
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, g1) => {
      count++;
      return typeof g1 === "string" ? `${g1}[redacted]` : "[redacted]";
    });
  }
  return { text: out, count };
}

module.exports = { fileStore, httpStore, makeStore, localDir, fmt, fmtAge, fmtPresence, redact, sleep, safe };
