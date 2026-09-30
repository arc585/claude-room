#!/usr/bin/env node
// claude-room PreToolUse hook: blocks Edit/Write on a file that another ONLINE session has claimed
// (room_claim). Fails open: any error, timeout, or a session that isn't in a room means "allow".
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { makeStore, normPath, overlaps, realish } = require("./lib");
const { findMine } = require("./proc");

setTimeout(() => process.exit(0), 2500).unref(); // never hold up the session

const allow = () => process.exit(0);
const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
};

(async () => {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return allow();
  }
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) return allow();

  const mine = findMine(input, { maxAgeMs: 60 * 1000 }).filter((m) => !m.left);
  if (!mine.length) return allow();

  const cwd = input.cwd || process.cwd();
  let root = cwd;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  const abs = realish(path.resolve(cwd, target));
  const rel = path.relative(realish(root), abs);
  const p = normPath(rel.startsWith("..") ? abs : rel);

  const store = makeStore();
  for (const m of mine) {
    const online = new Set((await store.listPresence(m.room)).filter((x) => x.state === "online").map((x) => x.name));
    const hit = (await store.claimsList(m.room)).find((c) => c.by !== m.name && online.has(c.by) && overlaps(c.path, p));
    if (hit)
      return deny(
        `'${p}' is claimed by ${hit.by} in room '${m.room}'${hit.note ? ` (${hit.note})` : ""}. Don't edit it. Ask them in the room (room_say) to release it, or work on something else.`
      );
  }
  allow();
})().catch(allow);
