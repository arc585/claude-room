#!/usr/bin/env node
// claude-room CLI: the human's side of a room (read, talk, approve) plus a hook for CI/scripts.
// Uses the same env as the sessions: CLAUDE_ROOM_URL + CLAUDE_ROOM_TOKEN for a relay, else local files.
// Human actions on a relay need CLAUDE_ROOM_APPROVER_TOKEN (never put that in a session's environment).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { makeStore, localDir, fmt, fmtPresence, toMarkdown, sleep } = require("./lib");

const store = makeStore({ token: process.env.CLAUDE_ROOM_APPROVER_TOKEN || undefined });
const user = process.env.CLAUDE_ROOM_USER || os.userInfo().username;

const HELP = `claude-room <command>

  rooms                              list rooms
  tail <room> [-f] [-n 30]           show messages (-f to follow)
  who <room>                         who is online
  say <room> <message>               post as a human (also lets agents continue past the conversation budget)
  pending <room>                     approval requests waiting for a decision
  approve <room> <id> [reason]       approve a session's request
  deny <room> <id> [reason]          deny it
  claims <room>                      file claims
  export <room> [file]               markdown transcript
  post <room> <name> <message> [--kind decision|question|answer]
                                     post as an agent-style participant (CI, cron, scripts)
  ui [--port 8787]                   local web view (rooms, approvals, live messages)
  delete <room>                      delete a room (relay admin only)

Env: CLAUDE_ROOM_URL, CLAUDE_ROOM_TOKEN, CLAUDE_ROOM_APPROVER_TOKEN, CLAUDE_ROOM_USER`;

const flag = (args, name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("-") ? 2 : 1);
  return v && !v.startsWith("-") ? v : true;
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "rooms": {
      const rooms = await store.listRooms();
      console.log(rooms.length ? rooms.map((r) => `${r.room}\t${r.messages} msgs\tlast ${r.last_ts || "-"}`).join("\n") : "(no rooms)");
      break;
    }
    case "tail": {
      const follow = flag(args, "-f");
      const n = Number(flag(args, "-n")) || 30;
      const [room] = args;
      if (!room) throw new Error("usage: tail <room> [-f] [-n 30]");
      const all = await store.list(room, 0);
      console.log(all.slice(-n).map(fmt).join("\n") || "(empty room)");
      let cursor = all.length ? all[all.length - 1].id : 0;
      while (follow) {
        for (const m of await store.wait(room, cursor, 25000)) {
          cursor = m.id;
          console.log(fmt(m));
        }
      }
      break;
    }
    case "who": {
      console.log(fmtPresence(await store.listPresence(args[0]), null));
      break;
    }
    case "say": {
      const [room, ...rest] = args;
      if (!room || !rest.length) throw new Error("usage: say <room> <message>");
      const m = await store.append(room, user, rest.join(" "), { kind: "human" });
      console.log(`Posted #${m.id} as human (${user}).`);
      break;
    }
    case "pending": {
      const all = await store.list(args[0], 0);
      const decided = new Set(all.filter((m) => m.kind === "approval_decision").map((m) => Number(m.reply_to)));
      const pend = all.filter((m) => m.kind === "approval_request" && !decided.has(m.id));
      console.log(pend.length ? pend.map(fmt).join("\n\n") : "(nothing pending)");
      break;
    }
    case "approve":
    case "deny": {
      const [room, id, ...reason] = args;
      if (!room || !id) throw new Error(`usage: ${cmd} <room> <id> [reason]`);
      const decision = cmd === "approve" ? "approved" : "denied";
      await store.append(room, user, reason.join(" ") || decision, { kind: "approval_decision", decision, reply_to: Number(id) });
      console.log(`${decision} request #${id}.`);
      break;
    }
    case "claims": {
      const cl = await store.claimsList(args[0]);
      console.log(cl.length ? cl.map((c) => `${c.path}\t${c.by}\t${c.note || ""}`).join("\n") : "(no claims)");
      break;
    }
    case "export": {
      const [room, file] = args;
      const md = toMarkdown(room, await store.list(room, 0), await store.listPresence(room));
      if (file) {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, md);
        console.log(`Wrote ${file}`);
      } else console.log(md);
      break;
    }
    case "post": {
      const kind = flag(args, "--kind");
      const [room, name, ...rest] = args;
      if (!room || !name || !rest.length) throw new Error("usage: post <room> <name> <message> [--kind decision]");
      const m = await store.append(room, name, rest.join(" "), { kind: typeof kind === "string" ? kind : undefined });
      console.log(`Posted #${m.id}`);
      break;
    }
    case "delete": {
      await store.deleteRoom(args[0]);
      console.log(`Deleted ${args[0]}`);
      break;
    }
    case "ui": {
      const { createRelay } = require("./relay");
      const port = Number(flag(args, "--port")) || 8787;
      const secretFile = path.join(localDir(), ".ui-token");
      let s;
      try {
        s = JSON.parse(fs.readFileSync(secretFile, "utf8"));
      } catch {
        s = { token: crypto.randomBytes(24).toString("hex"), approver: crypto.randomBytes(24).toString("hex") };
        fs.mkdirSync(localDir(), { recursive: true });
        fs.writeFileSync(secretFile, JSON.stringify(s), { mode: 0o600 });
      }
      const { fileStore } = require("./lib");
      const server = createRelay({
        store: fileStore(localDir()),
        users: [{ name: user, token: s.token, approver_token: s.approver, role: "admin", rooms: ["*"], anonymous: false }],
        notifyUrl: process.env.CLAUDE_ROOM_NOTIFY_URL,
      });
      server.listen(port, "127.0.0.1", () => {
        console.log(`claude-room web view (local only): http://127.0.0.1:${port}/ui#token=${s.token}&approver=${s.approver}`);
        console.log("Sessions on this machine can read ~/.claude-rooms, so approvals here are a convention, not a lock. For a real gate use a relay with separate approver tokens.");
      });
      await new Promise(() => {}); // run until killed
      break;
    }
    default:
      console.log(HELP);
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e.message);
  process.exit(1);
});
