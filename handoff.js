#!/usr/bin/env node
// claude-room SessionEnd hook: when a Claude Code session ends, post a factual handoff note to the
// room(s) that session was in, unless it already posted its own with room_handoff.
// Reads the hook payload ({cwd, transcript_path, reason, ...}) on stdin. Never fails loudly:
// a hook must not break session shutdown.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { makeStore, redact } = require("./lib");
const { findMine } = require("./proc");

const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Last thing the assistant said in this session (often a wrap-up), from the transcript tail.
function lastAssistantText(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const len = Math.min(size, 400 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      let d;
      try {
        d = JSON.parse(l);
      } catch {
        continue;
      }
      if (d.type !== "assistant") continue;
      const text = (d.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text) return text;
    }
  } catch {}
  return "";
}

function buildNote(member, input) {
  const cwd = input.cwd || member.cwd;
  const parts = [`📋 AUTO HANDOFF from ${member.name} (session ended${input.reason ? `: ${input.reason}` : ""})`];
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!branch) return null; // not a git repo: nothing factual to report
  parts.push(`Branch: ${branch} @ ${run("git", ["rev-parse", "--short", "HEAD"], cwd)}`);
  const commits = run("git", ["log", `--since=${member.joined}`, "--pretty=%h %s", "-n", "10"], cwd);
  if (commits) parts.push(`Commits this session:\n${commits}`);
  const status = run("git", ["status", "--short"], cwd).split("\n").filter(Boolean);
  if (status.length) parts.push(`Uncommitted changes (${status.length}):\n${status.slice(0, 15).join("\n")}${status.length > 15 ? "\n…" : ""}`);
  // A session that only read and talked (no commits, no changes) has no work to hand off; don't add noise.
  if (!commits && !status.length) return null;
  const stat = run("git", ["diff", "--stat", "HEAD"], cwd).split("\n").pop();
  if (stat) parts.push(`Diff: ${stat.trim()}`);
  const last = input.transcript_path ? lastAssistantText(input.transcript_path) : "";
  if (last) parts.push(`Last message from the session:\n${last.length > 900 ? last.slice(0, 900) + "…" : last}`);
  parts.push("(Automatic, from git and the session transcript. Ask the room if you need detail.)");
  return redact(parts.join("\n")).text;
}

(async () => {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {}

  const mine = findMine(input);
  if (!mine.length) return;

  const store = makeStore();
  for (const m of mine) {
    try {
      const existing = await store.list(m.room, 0);
      const briefed = existing.some((x) => x.kind === "handoff" && x.from === m.name && x.ts >= m.joined);
      const note = briefed ? null : buildNote(m, input);
      if (note) await store.append(m.room, m.name, note, "handoff");
    } catch {}
    try {
      fs.unlinkSync(m.file);
    } catch {}
  }
})()
  .catch(() => {})
  .finally(() => process.exit(0));
