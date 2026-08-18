// Node transport adapter. Everything runtime-specific lives here: http, ws,
// the clock, and finding the LAN address. Room and Game stay portable.
import { createServer } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Room } from '../src/net/room.js';
import { decode, encode } from '../src/net/protocol.js';
import { parseQuestionCsv, questionsToCsv } from '../src/quiz.js';
import { SAMPLE_SETS } from './sample-sets.js';

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

const ROUTES = {
  '/': 'arena.html',
  '/play': 'play.html',
  '/admin': 'admin.html',
  '/solo': 'index.html',
};

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

// --------------------------------------------------------------- persistence
// The only place question sets touch a disk. Room never imports fs; it is
// handed a `persistSets` callback and stays portable to a Durable Object,
// where this same callback would be a storage.put instead.

const SETS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'question-sets.json');

function seedSets() {
  return SAMPLE_SETS.map((s, i) => {
    const { questions } = parseQuestionCsv(s.csv);
    return { id: `set-${i + 1}`, name: s.name, questions, csv: questionsToCsv(questions) };
  });
}

async function loadSets() {
  try {
    const raw = JSON.parse(await readFile(SETS_FILE, 'utf8'));
    const sets = Array.isArray(raw) ? raw : raw.sets;
    if (Array.isArray(sets) && sets.length) return sets;
  } catch { /* first run, or the file was hand-edited into rubble */ }
  const seeded = seedSets();
  await saveSets(seeded);
  return seeded;
}

let writing = Promise.resolve();
function saveSets(sets) {
  // Serialise writes and swap through a temp file: a teacher hitting SAVE
  // twice mid-lesson must never leave a half-written JSON on disk.
  writing = writing.then(async () => {
    const tmp = `${SETS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(sets, null, 2), 'utf8');
    await rename(tmp, SETS_FILE);
  }).catch((e) => process.stderr.write(`  ! could not save question sets: ${e.message}\n`));
  return writing;
}

const initialSets = await loadSets();

// ------------------------------------------------------------------- sockets

const sockets = new Map();
let nextId = 1;

const room = new Room({
  meta: {},
  sets: initialSets,
  persistSets: (sets) => saveSets(sets),
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
    `  Admin  (teacher)   :  http://${ip}:${PORT}/admin\n` +
    `  ---------------------------------------------\n\n`
  );
});
