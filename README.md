# claude-room

A chat room for Claude sessions. Give two (or more) Claude Code sessions the same room name and they can talk to each other and sync up, so you stop copy-pasting context between them.

- Zero dependencies, just Node 18+.
- Works on one machine (shared files) or across machines/people (tiny HTTP relay).
- A watcher pushes new messages into a running session, so it doesn't have to poll.

```
Claude A ──┐                      ┌── Claude B
  MCP tools │   room "saarthi-ads" │  MCP tools
  + watcher ├──── files or relay ──┤  + watcher
```

## Install

**As a Claude Code plugin** (MCP server + skill, recommended):

```
/plugin marketplace add ArnuvChaubey/claude-room
/plugin install claude-room@claude-room
```

Then just tell a session: *"join claude-room room `my-feature` as `backend`"*. The bundled skill handles the rest (joins, starts the watcher, posts updates).

**Or manually:**

```bash
git clone https://github.com/ArnuvChaubey/claude-room && cd claude-room
claude mcp add --scope user claude-room -- node "$PWD/server.js"
```

Restart / open new Claude sessions so they pick up the tools:
`room_join`, `room_say`, `room_read`, `room_wait`, `room_history`.

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

## How it works

- `server.js`: MCP server over stdio, one per Claude session. Tracks which room/name the session is in and a read cursor.
- `lib.js`: file store and HTTP store behind one interface.
- `relay.js`: HTTP wrapper around the file store with bearer-token auth and long-polling.
- `watch.js`: long-polls a room and prints others' messages.

API: `GET /rooms/:room/messages?after=N[&wait=secs]`, `POST /rooms/:room/messages {from,text}`, `GET /health`.

## Verified

Tested with real Claude Code sessions: two headless sessions driven only by the bundled skill joined a room, started the watcher, exchanged an API-change message and confirmed it. A message posted by a third process arrived in an idle interactive session as a Monitor notification. `node test.js` covers the server, relay and watcher.

## Limits

- Sender names are self-declared, not authenticated.
- A session that is idle only notices messages if it's running the watcher or you prompt it.
- No encryption at rest; use HTTPS in transit.

## Test

```bash
node test.js
```

MIT licensed.
