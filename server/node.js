// Node transport adapter. Everything runtime-specific lives here: http, ws,
// the clock, and finding the LAN address. Room and Game stay portable.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
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
// One per boot, not persisted: the projector (arena.html) legitimately runs
// on a second device — a Chromebook or laptop plugged into the classroom
// projector — so it can't be gated to loopback like the teacher console.
// This key is how it proves it got the link from the teacher, not a guess.
const DISPLAY_KEY = randomBytes(6).toString('hex');

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

// The teacher console runs the whole quiz + match control surface. A student
// on the same Wi-Fi has no business loading it — it only ever needs to be
// opened on the machine actually running this server.
function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/admin' && !isLoopback(req.socket.remoteAddress)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
      .end('The teacher console only works from this computer.');
    return;
  }
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
    // Old files are a bare array of sets with no config; new ones are
    // { sets, cfg }. Both are read; only the new shape is ever written.
    const sets = Array.isArray(raw) ? raw : raw.sets;
    const cfg = Array.isArray(raw) ? {} : (raw.cfg || {});
    if (Array.isArray(sets) && sets.length) return { sets, cfg };
  } catch { /* first run, or the file was hand-edited into rubble */ }
  const seeded = seedSets();
  await saveSets({ sets: seeded, cfg: {} });
  return { sets: seeded, cfg: {} };
}

let writing = Promise.resolve();
function saveSets({ sets, cfg }) {
  // Serialise writes and swap through a temp file: a teacher hitting SAVE
  // twice mid-lesson must never leave a half-written JSON on disk. Quiz
  // settings (questions on/off, timer, auto-advance) ride along with the
  // sets so ending class and starting fresh next period keeps them.
  writing = writing.then(async () => {
    const tmp = `${SETS_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify({ sets, cfg }, null, 2), 'utf8');
    await rename(tmp, SETS_FILE);
  }).catch((e) => process.stderr.write(`  ! could not save question sets: ${e.message}\n`));
  return writing;
}

const { sets: initialSets, cfg: initialCfg } = await loadSets();

// ------------------------------------------------------------------- sockets

const sockets = new Map();
let nextId = 1;

const room = new Room({
  meta: {},
  sets: initialSets,
  cfg: initialCfg,
  displayKey: DISPLAY_KEY,
  persistSets: (payload) => saveSets(payload),
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
  onShutdown: () => shutdown(),
});

const wss = new WebSocketServer({ server: http });
wss.on('connection', (ws, req) => {
  const id = nextId++;
  sockets.set(id, ws);
  // The HTTP 403 above stops a student loading the console page, but nothing
  // stops them opening a raw WebSocket from devtools and claiming role
  // 'teacher' by hand — this is the check that actually enforces it.
  room.join(id, isLoopback(req.socket.remoteAddress));
  ws.on('message', (raw) => room.message(id, decode(raw.toString())));
  ws.on('close', () => { sockets.delete(id); room.leave(id); });
  ws.on('error', () => { sockets.delete(id); room.leave(id); });
});

// --------------------------------------------------------------------- clock

let last = process.hrtime.bigint();
const tickTimer = setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25;
  room.tick(dt);
}, 1000 / TICK_HZ);

// --------------------------------------------------------------- shutdown
// Room.shutdown() has already broadcast the "session ended" message by the
// time this runs; the ordering here is just: stop simulating, let that
// message actually leave the socket buffers, then close everything and exit.
// A teacher hitting the button mid-lesson must never leave question-set saves
// half-written, so the in-flight `writing` chain is awaited before exit.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(tickTimer);
  setTimeout(async () => {
    for (const ws of sockets.values()) ws.close();
    wss.close();
    await writing.catch(() => {});
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  }, 150);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
  // The projector may be a second device (see the 'display' branch in
  // Room.hello()), so its link carries the per-boot key. Opened on this same
  // machine, the key is harmless and unnecessary (isLocal already covers it),
  // but it works either way, so one link serves both cases.
  room.meta.arenaUrl = `${ip}:${PORT}/?key=${DISPLAY_KEY}`;
  process.stdout.write(
    `\n  POLYPONG server running\n` +
    `  ---------------------------------------------\n` +
    `  Arena  (projector) :  http://${room.meta.arenaUrl}\n` +
    `                         (or http://localhost:${PORT}/ on this machine)\n` +
    `  Join   (students)  :  http://${ip}:${PORT}/play\n` +
    `  Admin  (teacher)   :  http://localhost:${PORT}/admin\n` +
    `  ---------------------------------------------\n\n`
  );
});
