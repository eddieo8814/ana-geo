#!/usr/bin/env node
// Inbound relay (PRD §8.3) — a separate process, shipped with the app.
// Long-polls the server inbox and pushes each user message toward the ANA
// session: printed to stdout as one JSON line per message and appended to
// data/inbox.log. The mechanical polling lives here, not in the agent.
//
// Run alongside the server:  node relay.js   (PORT env matches server.js)

const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8808);
const LOG = path.join(__dirname, 'data', 'inbox.log');

async function loop() {
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/inbox-wait`);
      const { messages } = await res.json();
      for (const m of messages) {
        const line = JSON.stringify(m);
        console.log(line);
        fs.appendFileSync(LOG, line + '\n');
      }
    } catch {
      await new Promise((r) => setTimeout(r, 2000)); // server not up yet — retry
    }
  }
}

fs.mkdirSync(path.dirname(LOG), { recursive: true });
console.error(`relay: watching http://localhost:${PORT}/api/inbox-wait`);
loop();
