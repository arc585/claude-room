#!/usr/bin/env node
// claude-room watcher: prints one line per new message from other participants.
// Run it as a background/monitor process in a Claude session so each line nudges the session.
//   node watch.js <room> <your-name>
const { makeStore, sleep } = require("./lib");

const [room, name] = process.argv.slice(2);
if (!room || !name) {
  console.error("usage: node watch.js <room> <your-name>");
  process.exit(1);
}

(async () => {
  const store = makeStore();
  let cursor = 0;
  let warned = false;
  // Start from "now": history is delivered by room_join, not replayed here.
  for (;;) {
    try {
      const all = await store.list(room, 0);
      cursor = all.length ? all[all.length - 1].id : 0;
      break;
    } catch (e) {
      console.log(`[claude-room] cannot reach room: ${e.message}`);
      await sleep(5000);
    }
  }
  console.log(`[claude-room] watching room '${room}' as '${name}'. Messages from others appear below; call room_read to mark them read and reply with room_say.`);
  for (;;) {
    try {
      const msgs = await store.wait(room, cursor, 25000);
      warned = false;
      for (const m of msgs) {
        cursor = m.id;
        if (m.from === name || m.from === "system") continue;
        console.log(`[room ${room}] ${m.from}: ${m.text.replace(/\s*\n\s*/g, " ⏎ ")}`);
      }
    } catch (e) {
      if (!warned) console.log(`[claude-room] watcher error (retrying): ${e.message}`);
      warned = true;
      await sleep(5000);
    }
  }
})();
