#!/usr/bin/env node
// claude-room: a zero-dependency MCP server (stdio) that lets multiple Claude
// sessions talk to each other through named "rooms".
// Storage: local files (~/.claude-rooms) or a shared relay (CLAUDE_ROOM_URL + CLAUDE_ROOM_TOKEN).

const readline = require("readline");
const { makeStore, fmt } = require("./lib");

const store = makeStore();

// Per-process (= per Claude session) state.
const me = { room: null, name: null, cursor: 0 };

// Unread = messages after cursor, written by someone else.
async function takeUnread() {
  const all = await store.list(me.room, me.cursor);
  if (all.length) me.cursor = all[all.length - 1].id;
  return all.filter((m) => m.from !== me.name);
}

function needJoin() {
  if (!me.room) throw new Error("Not in a room. Call room_join first.");
}

const tools = {
  room_join: {
    description:
      "Join a chat room shared with other Claude sessions. Pick a short name describing your role (e.g. 'backend', 'dashboard'). Returns recent history so you have context.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room id, e.g. '42' or 'saarthi-ads'" },
        name: { type: "string", description: "Your display name in the room" },
      },
      required: ["room", "name"],
    },
    async run({ room, name }) {
      me.room = room;
      me.name = name;
      const all = await store.list(room, 0);
      const joined = await store.append(room, "system", `${name} joined`);
      me.cursor = joined.id;
      const hist = all.slice(-30).map(fmt).join("\n") || "(empty room)";
      return `Joined room '${room}' as '${name}'.\n\nRecent history:\n${hist}`;
    },
  },
  room_say: {
    description:
      "Post a message to the room. Be specific and self-contained: what you did, what you need, file paths, decisions made. Other sessions have no other way to see your context.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    async run({ message }) {
      needJoin();
      const m = await store.append(me.room, me.name, message);
      return `Sent #${m.id}.`;
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
      "Block until another participant posts, or timeout (default 45s, max 120s). Use when you are waiting on the other session's answer.",
    inputSchema: {
      type: "object",
      properties: { timeout_seconds: { type: "number" } },
    },
    async run({ timeout_seconds }) {
      needJoin();
      const deadline = Date.now() + Math.min(Math.max(timeout_seconds || 45, 1), 120) * 1000;
      while (Date.now() < deadline) {
        await store.wait(me.room, me.cursor, Math.min(deadline - Date.now(), 25000));
        const fresh = await takeUnread();
        if (fresh.length) return fresh.map(fmt).join("\n");
      }
      return "(timed out, no new messages)";
    },
  },
  room_history: {
    description: "Show the last N messages in the room (default 50), regardless of read state.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    async run({ limit }) {
      needJoin();
      return (await store.list(me.room, 0)).slice(-(limit || 50)).map(fmt).join("\n") || "(empty room)";
    },
  },
};

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
          serverInfo: { name: "claude-room", version: "0.1.0" },
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

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {}
});
