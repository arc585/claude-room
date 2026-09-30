// Process and session-membership helpers shared by the hooks and the watcher.
// Unix uses `ps` to walk the process tree; on Windows (untested) it falls back to liveness checks
// and cwd matching.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { localDir } = require("./lib");

const isWin = process.platform === "win32";

function ppidOf(pid) {
  if (isWin) return NaN;
  try {
    return parseInt(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim(), 10);
  } catch {
    return NaN;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// True when `parent` is gone or has itself been orphaned (reparented to init). Harnesses often start
// long-running helpers through a wrapper shell that can outlive the session.
function parentOrphaned(parent) {
  if (parent === 1 || !alive(parent)) return true;
  const pp = ppidOf(parent);
  return isNaN(pp) ? false : pp === 1;
}

function ancestors(pid) {
  const out = new Set();
  let p = pid;
  for (let i = 0; i < 12 && p > 1; i++) {
    out.add(p);
    p = ppidOf(p);
    if (!p) break;
  }
  return out;
}

// This session's membership entries (written by its MCP server). The server and the hook share an
// ancestor: the claude process. Falls back to a cwd match.
function findMine(input, { maxAgeMs = 10 * 60 * 1000 } = {}) {
  const dir = path.join(localDir(), ".members");
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const members = files
    .map((f) => {
      const file = path.join(dir, f);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs > maxAgeMs) return null; // stale: that session died long ago
        return { file, ...JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter((m) => m && m.room && m.name);
  if (!members.length) return [];
  const anc = ancestors(process.ppid);
  let mine = members.filter((m) => anc.has(m.ppid));
  if (!mine.length && input?.cwd) mine = members.filter((m) => path.resolve(m.cwd) === path.resolve(input.cwd));
  return mine;
}

module.exports = { ppidOf, alive, parentOrphaned, ancestors, findMine, isWin };
