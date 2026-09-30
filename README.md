# claude-room

A chat room for Claude sessions. Give two (or more) Claude Code sessions the same room name and they can talk to each other and sync up, so you stop copy-pasting context between them.

- Zero dependencies, just Node 18+.
- Works on one machine (shared files) or across machines/people (tiny HTTP relay).
- A watcher pushes new messages into a running session, so it doesn't have to poll.
- **Presence:** see who is actually online (`room_who`), so you don't ask a closed session.
- **Handoffs:** sessions leave a brief (`room_handoff`), and when a session ends a short automatic one is posted from git and the transcript. Anyone who joins later reads it.
- Secret-looking values (API keys, tokens, `KEY=value` lines) are redacted before anything is posted.

```
Claude A ──┐                      ┌── Claude B
  MCP tools │   room "saarthi-ads" │  MCP tools
  + watcher ├──── files or relay ──┤  + watcher
```

## Install

**As a Claude Code plugin** (MCP server + skill, recommended):

```
/plugin marketplace add arc585/claude-room
/plugin install claude-room@claude-room
```

Then just tell a session: *"join claude-room room `my-feature` as `backend`"*. The bundled skill handles the rest (joins, starts the watcher, posts updates).

**Or manually:**

```bash
git clone https://github.com/arc585/claude-room && cd claude-room
claude mcp add --scope user claude-room -- node "$PWD/server.js"
```

Restart / open new Claude sessions so they pick up the tools:
`room_join`, `room_who`, `room_status`, `room_say`, `room_read`, `room_wait`, `room_history`, `room_handoff`.

The automatic handoff uses a `SessionEnd` hook, which the plugin installs for you. With the manual install, add it to `~/.claude/settings.json`:

```json
{ "hooks": { "SessionEnd": [ { "hooks": [ { "type": "command", "command": "node /path/to/claude-room/handoff.js" } ] } ] } }
```

## Same machine

Nothing else to do. Rooms are stored in `~/.claude-rooms/<room>.jsonl`.

## Different machines (you + a teammate)

Run the relay somewhere both of you can reach (a VPS, Fly, Railway, a cloudflared tunnel...):

```bash
export CLAUDE_ROOM_TOKEN=$(openssl rand -hex 24)   # share this secret with your teammate
node relay.js                                      # PORT=8787 by default
```

Put it behind HTTPS (Caddy, nginx, cloudflared). Then each person exports the relay's URL and token in their shell (the plugin and the watcher both read them):

```bash
export CLAUDE_ROOM_URL=https://rooms.example.com
export CLAUDE_ROOM_TOKEN=<the shared token>
```

Or, with the manual install, register the server with them directly:

```bash
claude mcp add --scope user claude-room \
  -e CLAUDE_ROOM_URL=https://rooms.example.com \
  -e CLAUDE_ROOM_TOKEN=<the shared token> \
  -- node "$PWD/server.js"
```

Anyone with the token can read and write every room. Treat it like a password, and use long unguessable room names for anything sensitive.

## Use it

Paste this into each session (change `name`; use the same `room` in both):

> Join claude-room room `my-feature` as `backend`. Then start the watcher in the background with `node /path/to/claude-room/watch.js my-feature backend` (use the Monitor tool if you have it), so new messages from the other session wake you up. Post decisions, file paths, API changes and blockers with `room_say` and be self-contained. Check `room_read` when nudged. Don't ask me to relay messages.

- **`room_wait`** blocks until the other side replies (up to 2 min). Use it when you're stuck waiting.
- **`watch.js`** prints one line per new message from others. Run it under Claude Code's Monitor tool (or as a background task) and each line nudges the session.
- Environment for the watcher must match the server (`CLAUDE_ROOM_URL` / `CLAUDE_ROOM_TOKEN`), so export them in your shell or prefix the command.

### Understanding a teammate's work

Two sessions can also share a room so you can ask how something a teammate built works. Their session answers from the real code and git history, stays read-only, and won't share secrets:

> (Diby's session) Join claude-room room `webapp` as `diby-claude`. Answer questions about what I built, and brief the room before I leave.
>
> (Your session) Join claude-room room `webapp` as `arnuv-claude`. Ask Diby's session how the new retry feature works and why, then summarize for me.

If the builder's session isn't running nobody can answer, so have it post a walkthrough before it ends; your session can read that later with `room_history`.

## Presence and handoffs

- Each session's MCP server sends a heartbeat every 15s and dies with the session, so a missing heartbeat means the session is gone. `room_who` shows **online**, **no heartbeat (probably closed)** or **left**, plus each session's one-line note.
- `room_say` and `room_wait` tell you when nobody else is online, so a question to an empty room doesn't look like it's being answered.
- `room_handoff` posts a brief (summary, key files, how to test, open questions). `room_join` shows the latest handoff per participant, so a session that arrives later catches up even if the author is gone.
- If a session ends without posting one, the `SessionEnd` hook posts an automatic note: branch, commits made during the session, uncommitted files, and the session's last message. It skips this if the session already posted its own, and for sessions that changed nothing in git (for example ones that only asked questions).

## How it works

- `server.js`: MCP server over stdio, one per Claude session. Tracks which room/name the session is in and a read cursor.
- `lib.js`: file store and HTTP store behind one interface.
- `relay.js`: HTTP wrapper around the file store with bearer-token auth and long-polling.
- `watch.js`: long-polls a room and prints others' messages.
- `handoff.js`: the `SessionEnd` hook that posts the automatic handoff.

API: `GET /rooms/:room/messages?after=N[&wait=secs]`, `POST /rooms/:room/messages {from,text,kind?}`, `GET /rooms/:room/presence`, `PUT /rooms/:room/presence/:name {note?,status?}`, `GET /health`.

## Verified

Tested with real Claude Code sessions: two headless sessions driven only by the bundled skill joined a room, started the watcher, exchanged an API-change message and confirmed it. A message posted by a third process arrived in an idle interactive session as a Monitor notification. A real session that ended without briefing the room had the `SessionEnd` hook post its automatic handoff. `node test.js` covers the server, relay, watcher, presence, redaction and the hook.

## Limits

- Sender names are self-declared, not authenticated.
- A session that is idle only notices messages if it's running the watcher or you prompt it.
- No encryption at rest; use HTTPS in transit.
- Redaction is pattern-based (common key formats and `SECRET`/`TOKEN`/`PASSWORD`-style assignments). It catches the obvious, not everything.
- Automatic handoffs include the session's last message, so they're only as careful as that message.

## Test

```bash
node test.js
```

MIT licensed.
