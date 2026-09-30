#!/usr/bin/env node
// claude-room: a zero-dependency MCP server (stdio) that lets multiple Claude
// sessions talk to each other through named "rooms".
// Storage: local files (~/.claude-rooms) or a shared relay (CLAUDE_ROOM_URL + CLAUDE_ROOM_TOKEN).

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { makeStore, localDir, fmt, fmtPresence, redact, sleep } = require("./lib");

const store = makeStore();
const HEARTBEAT_MS = 15000;

// Per-process (= per Claude session) state. This process lives exactly as long as the session,
// so a live heartbeat means a live session.
const me = { room: null, name: null, cursor: 0, note: "", joined: null, leaving: false };

// Membership file: lets the SessionEnd hook (handoff.js) find which room this session was in.
const membersDir = path.join(localDir(), ".members");
const memberFile = path.join(membersDir, `${process.pid}.json`);
function writeMember(extra = {}) {
  try {
    fs.mkdirSync(membersDir, { recursive: true });
    fs.writeFileSync(
      memberFile,
      JSON.stringify({ pid: process.pid, ppid: process.ppid, room: me.room, name: me.name, cwd: process.cwd(), joined: me.joined, ...extra })
    );
  } catch {}
}

// Unread = messages after cursor, written by someone else.
async function takeUnread() {
  const all = await store.list(me.room, me.cursor);
  if (all.length) me.cursor = all[all.length - 1].id;
  return all.filter((m) => m.from !== me.name);
}

function needJoin() {
  if (!me.room) throw new Error("Not in a room. Call room_join first.");
}

const beat = () => {
  if (!me.room || me.leaving) return;
  store.setPresence(me.room, me.name, { note: me.note, status: "online" }).catch(() => {});
  writeMember();
};
setInterval(beat, HEARTBEAT_MS).unref();

// Returns a note when nobody else in the room is currently online (so a question will go unanswered).
async function aloneNote() {
  try {
    const others = (await store.listPresence(me.room)).filter((p) => p.name !== me.name);
    if (others.some((p) => p.state === "online")) return "";
    const seen = others.length ? `\n${fmtPresence(others, me.name)}` : "";
    return `\nNote: nobody else is online in this room right now. Your message is saved and they will see it when they join, but nobody will answer yet.${seen}`;
  } catch {
    return "";
  }
}

const str = { type: "string" };
const tools = {
  room_join: {
    description:
      "Join a chat room shared with other Claude sessions. Pick a short name describing your role (e.g. 'backend', 'dashboard'). Optionally set a note saying what you're working on. Returns who is here, the latest handoff notes, and recent history.",
    inputSchema: {
      type: "object",
      properties: {
        room: { ...str, description: "Room id, e.g. '42' or 'saarthi-ads'" },
        name: { ...str, description: "Your display name in the room" },
        note: { ...str, description: "One line: what you're working on" },
      },
      required: ["room", "name"],
    },
    async run({ room, name, note }) {
      me.room = room;
      me.name = name;
      me.note = note || "";
      me.joined = new Date().toISOString();
      me.leaving = false;
      const all = await store.list(room, 0);
      await store.setPresence(room, name, { note: me.note, status: "online" });
      const joined = await store.append(room, "system", `${name} joined`);
      me.cursor = joined.id;
      writeMember();
      const lastHandoff = new Map();
      for (const m of all) if (m.kind === "handoff") lastHandoff.set(m.from, m);
      const handoffs = [...lastHandoff.values()].slice(-3).map(fmt).join("\n\n");
      const hist = all.slice(-30).map(fmt).join("\n") || "(empty room)";
      const who = fmtPresence(await store.listPresence(room), name);
      return `Joined room '${room}' as '${name}'.\n\nParticipants:\n${who}${
        handoffs ? `\n\nLatest handoff notes:\n${handoffs}` : ""
      }\n\nRecent history:\n${hist}`;
    },
  },
  room_who: {
    description:
      "Show who is in the room and whether each session is online (live heartbeat), probably closed, or has left, plus what they said they're working on. Check this before asking someone a question.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      needJoin();
      return fmtPresence(await store.listPresence(me.room), me.name);
    },
  },
  room_status: {
    description: "Set a one-line note about what you're working on, shown to others in room_who.",
    inputSchema: { type: "object", properties: { note: str }, required: ["note"] },
    async run({ note }) {
      needJoin();
      me.note = String(note).slice(0, 200);
      await store.setPresence(me.room, me.name, { note: me.note, status: "online" });
      return "Status updated.";
    },
  },
  room_say: {
    description:
      "Post a message to the room. Be specific and self-contained: what you did, what you need, file paths, decisions made. Other sessions have no other way to see your context. Secret-looking values (API keys, tokens) are redacted automatically.",
    inputSchema: { type: "object", properties: { message: str }, required: ["message"] },
    async run({ message }) {
      needJoin();
      const { text, count } = redact(message);
      const m = await store.append(me.room, me.name, text);
      return `Sent #${m.id}.${count ? ` (${count} secret-looking value(s) were redacted.)` : ""}${await aloneNote()}`;
    },
  },
  room_handoff: {
    description:
      "Post a handoff brief so teammates' sessions can understand your work later, even after your session ends. Use it when you finish a task or before the user leaves. Read-only facts: what you built, where, how to run/test it, what's unresolved.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { ...str, description: "What you built/changed and why" },
        files: { type: "array", items: str, description: "Key files or functions, e.g. src/retry.js:withRetry" },
        how_to_test: str,
        open_questions: str,
      },
      required: ["summary"],
    },
    async run({ summary, files, how_to_test, open_questions }) {
      needJoin();
      const parts = [`📋 HANDOFF from ${me.name}`, `Summary: ${summary}`];
      if (files?.length) parts.push(`Key files: ${files.join(", ")}`);
      if (how_to_test) parts.push(`How to test: ${how_to_test}`);
      if (open_questions) parts.push(`Open questions: ${open_questions}`);
      const { text, count } = redact(parts.join("\n"));
      const m = await store.append(me.room, me.name, text, "handoff");
      return `Handoff posted as #${m.id}.${count ? ` (${count} secret-looking value(s) were redacted.)` : ""}`;
    },
  },
  room_read: {
    description: "Read new messages from other participants since you last checked. Returns immediately.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      needJoin();
      const fresh = await takeUnread();
      return fresh.length ? fresh.map(fmt).join("\n") : "(no new messages)";
    },
  },
  room_wait: {
    description:
      "Block until another participant posts, or timeout (default 45s, max 120s). Use when you are waiting on the other session's answer. On timeout it tells you whether anyone else is actually online.",
    inputSchema: { type: "object", properties: { timeout_seconds: { type: "number" } } },
    async run({ timeout_seconds }) {
      needJoin();
      const deadline = Date.now() + Math.min(Math.max(timeout_seconds || 45, 1), 120) * 1000;
      while (Date.now() < deadline) {
        await store.wait(me.room, me.cursor, Math.min(deadline - Date.now(), 25000));
        const fresh = await takeUnread();
        if (fresh.length) return fresh.map(fmt).join("\n");
      }
      return `(timed out, no new messages)${await aloneNote()}`;
    },
  },
  room_history: {
    description: "Show the last N messages in the room (default 50), regardless of read state. Handoff notes are marked 📋.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    async run({ limit }) {
      needJoin();
      return (await store.list(me.room, 0)).slice(-(limit || 50)).map(fmt).join("\n") || "(empty room)";
    },
  },
};

// ---- leaving: mark presence, announce, then exit ----
async function leave() {
  if (me.leaving || !me.room) return;
  me.leaving = true;
  writeMember({ left: true });
  await Promise.race([
    (async () => {
      await store.setPresence(me.room, me.name, { status: "left" });
      await store.append(me.room, "system", `${me.name} left`);
    })().catch(() => {}),
    sleep(1500),
  ]);
}
const shutdown = async () => {
  await leave();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---- minimal MCP JSON-RPC over stdio (newline-delimited) ----
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "claude-room", version: "0.2.0" },
        },
      });
    }
    if (method === "tools/list") {
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
    }
    if (method === "tools/call") {
      const tool = tools[params.name];
      if (!tool) throw new Error(`Unknown tool ${params.name}`);
      beat(); // any activity counts as a heartbeat
      try {
        const text = await tool.run(params.arguments || {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e) {
        return send({
          jsonrpc: "2.0",
          id,
          result: { isError: true, content: [{ type: "text", text: e.message }] },
        });
      }
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {}
});
rl.on("close", shutdown);
