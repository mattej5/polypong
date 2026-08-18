import { Game, STATE } from './game.js';
import { render } from './render.js';
import { C, S, decode, encode } from './net/protocol.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const game = new Game();
game.replica = true;

// ------------------------------------------------------------------ transport

let socket = null;
let lastSnapAt = 0;

function connect() {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    setConn('connected');
    socket.send(encode({ t: C.HELLO, role: 'display' }));
  });
  socket.addEventListener('message', (e) => handle(decode(e.data)));
  socket.addEventListener('close', () => {
    setConn('reconnecting…');
    setTimeout(connect, 1000);
  });
}

const sendMsg = (msg) => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
};

function handle(msg) {
  if (!msg) return;
  if (msg.t === S.LOBBY) return onLobby(msg);
  if (msg.t === S.ERROR) return setErr(msg.msg);
  if (msg.t === S.SNAP) {
    const prev = game.players.map((p) => p.lives);
    game.applySnapshot(msg.s);
    lastSnapAt = performance.now();
    flashGoals(prev);
    lobby.classList.toggle('hidden', msg.s.st !== STATE.MENU);
    hud.classList.toggle('hidden', msg.s.st === STATE.MENU);
  }
}

/** Snapshots carry no events, so goals are inferred from a life dropping. */
function flashGoals(prevLives) {
  game.players.forEach((p, i) => {
    if (prevLives[i] === undefined || p.lives >= prevLives[i]) return;
    const edge = p.edge || (game.arena && game.arena.goalEdges[0]);
    if (edge) game.sparks(edge.mid, p.color, 26);
    game.shake = Math.min(1, game.shake + 0.45);
  });
}

// --------------------------------------------------------------------- lobby

const lobby = document.getElementById('lobby');
const hud = document.getElementById('hud');
const seatsEl = document.getElementById('seats');
const emptyEl = document.getElementById('empty');
const botsSel = document.getElementById('bots');
const startBtn = document.getElementById('start');
const errEl = document.getElementById('err');
const connEl = document.getElementById('conn');

const setErr = (m) => { errEl.textContent = m || ''; };
const setConn = (m) => { connEl.textContent = m; };

const joinEl = document.getElementById('joinurl');
joinEl.textContent = `${location.host}/play`;

function onLobby(msg) {
  // The server knows its own LAN address; the address bar may just say localhost.
  if (msg.meta && msg.meta.joinUrl) joinEl.textContent = msg.meta.joinUrl;
  const seated = msg.seats.length;
  seatsEl.innerHTML = '';
  for (const s of msg.seats) {
    const el = document.createElement('div');
    el.className = 'seat' + (s.connected ? '' : ' off');
    el.innerHTML = `<span class="dot" style="background:${s.color}"></span><span>${s.name}</span>`;
    seatsEl.appendChild(el);
  }
  emptyEl.classList.toggle('hidden', seated > 0);

  const maxBots = msg.max - seated;
  const keep = Math.min(msg.bots, maxBots);
  botsSel.innerHTML = '';
  for (let b = 0; b <= maxBots; b++) {
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = b === 0 ? 'none' : `${b} bot${b > 1 ? 's' : ''}`;
    botsSel.appendChild(o);
  }
  botsSel.value = String(keep);
  startBtn.disabled = seated + keep < 2;
  setErr(seated + keep < 2 ? '' : '');
}

botsSel.addEventListener('change', () => {
  sendMsg({ t: C.CONFIG, bots: +botsSel.value });
});
startBtn.addEventListener('click', () => { setErr(''); sendMsg({ t: C.START }); });
document.getElementById('reset').addEventListener('click', () => sendMsg({ t: C.RESET }));

let paused = false;
document.getElementById('pause').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? 'RESUME' : 'PAUSE';
  sendMsg({ t: C.PAUSE, on: paused });
});

// ---------------------------------------------------------------------- view

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(320, innerWidth || 960), h = Math.max(240, innerHeight || 600);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  game.setViewport(w, h, dpr);
}
addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  // Snapshots land at 20Hz; carry the balls forward on their own velocity so
  // the projector still looks like 60fps.
  if (game.state === STATE.PLAYING && now - lastSnapAt < 250) {
    for (const b of game.balls) {
      b.p.x += b.v.x * dt;
      b.p.y += b.v.y * dt;
      b.trail.push({ x: b.p.x, y: b.p.y });
      if (b.trail.length > 14) b.trail.shift();
    }
  }
  game.update(dt);
  render(ctx, game, now / 1000);
  requestAnimationFrame(frame);
}

resize();
connect();
requestAnimationFrame(frame);
window.game = game;
