// Node transport adapter. Everything runtime-specific lives here: http, ws,
// the clock, and finding the LAN address. Room and Game stay portable.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Room } from '../src/net/room.js';
import { decode, encode } from '../src/net/protocol.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 5180;
const TICK_HZ = 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ROUTES = { '/': 'arena.html', '/play': 'play.html', '/solo': 'index.html' };

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = ROUTES[url.pathname] || url.pathname.slice(1);
  const path = join(ROOT, normalize(rel));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

// ------------------------------------------------------------------- sockets

const sockets = new Map();
let nextId = 1;

const room = new Room({
  meta: {},
  send: (id, msg) => {
    const ws = sockets.get(id);
    if (ws && ws.readyState === ws.OPEN) ws.send(encode(msg));
  },
  broadcast: (msg) => {
    const payload = encode(msg);
    for (const ws of sockets.values()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  },
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws) => {
  const id = nextId++;
  sockets.set(id, ws);
  room.join(id);
  ws.on('message', (raw) => room.message(id, decode(raw.toString())));
  ws.on('close', () => { sockets.delete(id); room.leave(id); });
  ws.on('error', () => { sockets.delete(id); room.leave(id); });
});

// --------------------------------------------------------------------- clock

let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25;
  room.tick(dt);
}, 1000 / TICK_HZ);

// ---------------------------------------------------------------------- boot

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

http.listen(PORT, () => {
  const ip = lanAddress();
  room.meta.joinUrl = `${ip}:${PORT}/play`;
  process.stdout.write(
    `\n  POLYPONG server running\n` +
    `  ---------------------------------------------\n` +
    `  Arena  (projector) :  http://${ip}:${PORT}/\n` +
    `  Join   (students)  :  http://${ip}:${PORT}/play\n` +
    `  ---------------------------------------------\n\n`
  );
});
