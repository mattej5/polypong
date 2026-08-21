import { Game, STATE } from './game.js';
import { render } from './render.js';
import { C, S, decode, encode } from './net/protocol.js';
import { SnapshotStream } from './net/interp.js';
import { PaddlePredictor } from './net/predict.js';
import { T, COLORS } from './config.js';
import { LETTERS } from './quiz.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const game = new Game();
game.replica = true;

// The arena screen renders the world from interpolated snapshots — always a
// little behind the server, never ahead of it. See src/net/interp.js for why
// that is what stops the ball crossing a paddle.
const stream = new SnapshotStream();
const nowSec = () => performance.now() / 1000;

// ------------------------------------------------------------------ transport
// Two connections, deliberately. The display connection is the projector: it
// drives the lobby, the match controls and the question wall, and it is all a
// teacher who never opts in will ever open. Claiming a seat opens a SECOND
// connection in the player role, which is the same conversation a /play tab
// has with the room — so the room needs no notion of "a display that is also a
// player", and the projector-only case is untouched.

let socket = null;

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
  if (msg.t === S.QUIZ_ASK) return wallAsk(msg);
  if (msg.t === S.QUIZ_TICK) return wallTick(msg);
  if (msg.t === S.QUIZ_END) return wallEnd(msg);
  if (msg.t === S.QUIZ_OFF) return wallHide();
  if (msg.t === S.SNAP) {
    stream.push(msg.c, msg.s);
    // Prediction anchors on the newest raw snapshot, not the interpolated one.
    const mine = seat.slot === null ? null : msg.s.pl[seat.slot];
    if (mine) seat.predictor.onAuthoritative(mine.s, nowSec());
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

// ------------------------------------------------------- play from this screen
// The launcher opens `/` on the machine someone is actually sitting at, so this
// is the screen they watch and want to play from — but every input surface used
// to live in /play, which meant the on-screen buttons worked and the keyboard
// did nothing. This section is that missing half.
//
// It is opt-in, and nothing below runs until someone opts in: a teacher who
// only ever projects this page sees the same screen they saw before, minus one
// extra button on the lobby panel.
//
// One seat, not eight. Eight people around one keyboard is what /solo already
// does offline with KEY_PAIRS; here each seat is a real room participant with
// its own quiz identity, and one person cannot answer eight students' questions.

const SEAT_KEY = 'polypong.token.arena';   // never the /play key: a /play tab in
                                           // the same browser must not have its
                                           // seat stolen by the arena screen.

const seat = {
  slot: null,
  name: '',
  color: '#fff',
  socket: null,
  dir: 0,
  predictor: new PaddlePredictor(),
};

const selfJoin = document.getElementById('selfjoin');
const selfName = document.getElementById('selfname');
const selfGo = document.getElementById('selfgo');
const selfErr = document.getElementById('selferr');
const selfChip = document.getElementById('selfchip');
const selfDot = document.getElementById('selfdot');
const selfWho = document.getElementById('selfwho');
const selfLives = document.getElementById('selflives');
const selfDrop = document.getElementById('selfdrop');

const seated = () => seat.slot !== null;

function seatConnect(name) {
  seat.socket = new WebSocket(`ws://${location.host}`);
  seat.socket.addEventListener('open', () => {
    seat.socket.send(encode({
      t: C.HELLO, role: 'player', name, token: localStorage.getItem(SEAT_KEY),
    }));
  });
  seat.socket.addEventListener('message', (e) => seatHandle(decode(e.data)));
  seat.socket.addEventListener('close', () => {
    if (seated()) setTimeout(() => seatConnect(seat.name || name), 1000);
  });
}

const seatSend = (msg) => {
  if (seat.socket && seat.socket.readyState === WebSocket.OPEN) seat.socket.send(encode(msg));
};

/**
 * The seat connection only listens for what is personal to it. Everything
 * shared — snapshots, the lobby, the question wall — arrives on the display
 * connection and is handled once, there.
 */
function seatHandle(msg) {
  if (!msg) return;
  if (msg.t === S.ERROR) { selfErr.textContent = msg.msg; return; }
  if (msg.t === S.WELCOME && msg.role === 'player') {
    seat.slot = msg.slot;
    seat.name = msg.name;
    seat.color = msg.color;
    localStorage.setItem(SEAT_KEY, msg.token);
    seat.predictor.reset();
    selfErr.textContent = '';
    selfJoin.classList.add('hidden');
    selfDot.style.background = seat.color;
    selfWho.textContent = seat.name;
    selfLives.style.color = seat.color;
    selfChip.classList.remove('hidden');
    return;
  }
}

function claimSeat() {
  const name = selfName.value.trim();
  if (!name) { selfErr.textContent = 'Type a name first.'; return; }
  selfErr.textContent = '';
  seat.name = name;
  seatConnect(name);
}
selfGo.addEventListener('click', claimSeat);
selfName.addEventListener('keydown', (e) => {
  e.stopPropagation();                       // never steer while typing a name
  if (e.key === 'Enter') claimSeat();
});

// --------------------------------------------------------------------- input

const typing = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
};

function setDir(d) {
  if (!seated() || d === seat.dir) return;
  seat.dir = d;
  seat.predictor.setDir(d, nowSec());    // move first, then tell the server
  seatSend({ t: C.INPUT, d });
}

const KEYS_L = new Set(['ArrowLeft', 'KeyA']);
const KEYS_R = new Set(['ArrowRight', 'KeyD']);

addEventListener('keydown', (e) => {
  if (typing()) return;

  // Digits answer the open question. Letters are deliberately not bound to
  // answers: A and D steer, and reaching for "A" mid-question must not swerve
  // the paddle. Same rule /play follows.
  if (seated() && wallQid !== null && !wallLocked) {
    const n = Number(e.key);
    if (n >= 1 && n <= wallOptCount) { e.preventDefault(); answer(n - 1); return; }
  }
  if (e.repeat) return;
  if (wallQid !== null) return;            // frozen arena: no steering mid-question

  if (seated() && (e.code === 'Enter' || e.code === 'Space') && myPlacement()) {
    e.preventDefault(); seatSend({ t: C.PLACE }); return;
  }
  if (KEYS_L.has(e.code)) { e.preventDefault(); setDir(-1); }
  if (KEYS_R.has(e.code)) { e.preventDefault(); setDir(1); }
});
addEventListener('keyup', (e) => {
  if (KEYS_L.has(e.code) && seat.dir === -1) setDir(0);
  if (KEYS_R.has(e.code) && seat.dir === 1) setDir(0);
});
addEventListener('blur', () => setDir(0));

/** True while this screen's own seat is the one owing a hazard placement. */
function myPlacement() {
  const job = game.pending[0];
  return !!(job && job.player && job.player.idx === seat.slot);
}

// Aim is two-step, exactly as it is on a phone: click the arena to aim, then
// DROP (or Enter) to commit. One mis-click must never burn your only hazard.
canvas.addEventListener('pointerdown', (e) => {
  if (!seated() || !myPlacement() || !game.arena) return;
  const r = canvas.getBoundingClientRect();
  const R = game.viewport.R;
  seatSend({
    t: C.AIM,
    u: (e.clientX - r.left - game.arena.center.x) / R,
    v: (e.clientY - r.top - game.arena.center.y) / R,
  });
});
selfDrop.addEventListener('click', () => seatSend({ t: C.PLACE }));

// ------------------------------------------------------------ projected quiz
// The wall shows the question and a bare answered-count. Per-student
// correct/incorrect belongs on the teacher's own screen (/admin) and only
// reaches the projector if the teacher explicitly switches it on.

const wall = document.getElementById('quizwall');
const wallText = document.getElementById('walltext');
const wallOpts = document.getElementById('wallopts');
const wallCount = document.getElementById('wallcount');
const wallRows = document.getElementById('wallrows');
let wallQid = null;
let wallOptCount = 0;
let wallLocked = false;
let wallHideTimer = null;

function answer(i) {
  if (!seated() || wallQid === null || wallLocked) return;
  wallLocked = true;
  [...wallOpts.children].forEach((li, j) => li.classList.toggle('picked', j === i));
  seatSend({ t: C.ANSWER, qid: wallQid, c: i });
}

function wallAsk(msg) {
  if (wallHideTimer) { clearTimeout(wallHideTimer); wallHideTimer = null; }
  wallQid = msg.qid;
  wallOptCount = msg.options.length;
  wallLocked = false;
  setDir(0);                        // never keep drifting while a question is up
  wallText.textContent = msg.q;
  wallOpts.innerHTML = '';
  wallOpts.classList.toggle('two', msg.options.length === 2);
  wallOpts.classList.toggle('pickable', seated());
  msg.options.forEach((o, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><span></span>';
    li.querySelector('b').textContent = LETTERS[i];
    li.querySelector('span').textContent = o;
    if (seated()) li.addEventListener('click', () => answer(i));
    wallOpts.appendChild(li);
  });
  wallCount.textContent = '0 answered';
  wallRows.textContent = '';
  wall.classList.remove('hidden');
}

function wallTick(msg) {
  if (msg.qid !== wallQid) return;
  wallCount.textContent = `${msg.answered} of ${msg.total} answered`;
}

function wallEnd(msg) {
  if (msg.qid !== wallQid) { wallHide(); return; }
  wallLocked = true;
  // The right option lights up green; naming it again underneath is the same
  // fact twice.
  [...wallOpts.children].forEach((li, i) => li.classList.toggle('right', i === msg.correct));
  wallCount.textContent = '';
  // msg.rows only arrives when the teacher has opted in to projecting results.
  wallRows.textContent = Array.isArray(msg.rows)
    ? msg.rows.map((r) => `${r.name} ${r.choice === null ? '—' : r.correct ? '✓' : '✗'}`).join('   ')
    : '';
  wallHideTimer = setTimeout(wallHide, 4500);
}

function wallHide() {
  if (wallHideTimer) { clearTimeout(wallHideTimer); wallHideTimer = null; }
  wallQid = null;
  wallLocked = false;
  wall.classList.add('hidden');
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
  const seatCount = msg.seats.length;
  seatsEl.innerHTML = '';
  for (const s of msg.seats) {
    const el = document.createElement('div');
    el.className = 'seat' + (s.connected ? '' : ' off') + (s.slot === seat.slot ? ' mine' : '');
    el.innerHTML = `<span class="dot" style="background:${s.color}"></span><span>${s.name}</span>`;
    seatsEl.appendChild(el);
  }
  emptyEl.classList.toggle('hidden', seatCount > 0);

  const maxBots = msg.max - seatCount;
  const keep = Math.min(msg.bots, maxBots);
  botsSel.innerHTML = '';
  for (let b = 0; b <= maxBots; b++) {
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = b === 0 ? 'none' : `${b} bot${b > 1 ? 's' : ''}`;
    botsSel.appendChild(o);
  }
  botsSel.value = String(keep);
  startBtn.disabled = seatCount + keep < 2;
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

// ------------------------------------------------------------------- victory

const overEl = document.getElementById('over');
const overWho = document.getElementById('overwho');

document.getElementById('overagain').addEventListener('click', () => {
  setErr('');
  sendMsg({ t: C.REMATCH });
});
document.getElementById('overlobby').addEventListener('click', () => sendMsg({ t: C.RESET }));

function showVictory() {
  const w = game.winner;
  overWho.textContent = w ? `${w.name} WINS!` : 'GAME OVER';
  overWho.style.color = w ? (w.color || COLORS[w.idx]) : '#ffffff';
}

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

/**
 * Overwrite this screen's own interpolated paddle with the predicted one, so
 * the key you are holding is answered on this frame rather than after a round
 * trip. Every other paddle stays interpolated — their input has not reached us.
 */
function applyOwnPrediction() {
  if (!seated()) return;
  const p = game.players[seat.slot];
  if (!p || !p.alive || !p.paddle || !p.edge) return;
  const len = p.edge.length;
  if (!(len > 0)) return;
  const f = seat.predictor.predict(nowSec(), {
    speed: T.paddleSpeed,
    min: p.paddle.min / len,
    max: p.paddle.max / len,
  });
  if (f === null) return;
  p.paddle.s = Math.min(p.paddle.max, Math.max(p.paddle.min, f * len));
}

function refreshSeatHud() {
  if (!seated()) return;
  const p = game.players[seat.slot];
  selfLives.innerHTML = '';
  for (let i = 0; i < T.lives; i++) {
    const s = document.createElement('span');
    s.className = 'pip' + (p && i < p.lives ? ' on' : '');
    selfLives.appendChild(s);
  }
  // The DROP button appearing is the whole prompt. Life pips carry the rest.
  selfDrop.classList.toggle('show', myPlacement());
}

let last = performance.now();
let hudKey = '';
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  // One blended world per frame, built from the two real snapshots that
  // straddle the render clock. No dead reckoning anywhere: nothing is drawn at
  // a position the server did not actually produce.
  const snapshot = stream.advance(dt);
  if (snapshot) {
    const prevLives = game.players.map((p) => p.lives);
    game.applySnapshot(snapshot);
    applyOwnPrediction();
    game.pushTrails();
    flashGoals(prevLives);

    const over = game.state === STATE.GAMEOVER;
    lobby.classList.toggle('hidden', game.state !== STATE.MENU);
    hud.classList.toggle('hidden', game.state === STATE.MENU);
    overEl.classList.toggle('hidden', !over);

    const key = `${game.state}|${game.winner ? game.winner.idx : ''}|` +
      `${seated() ? game.players[seat.slot] && game.players[seat.slot].lives : ''}|` +
      `${myPlacement()}`;
    if (key !== hudKey) {
      hudKey = key;
      if (over) showVictory();
      refreshSeatHud();
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
window.net = { stream, seat };
