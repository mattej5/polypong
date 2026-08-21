import { Game, STATE } from './game.js';
import { render } from './render.js';
import { C, S, decode, encode } from './net/protocol.js';
import { SnapshotStream } from './net/interp.js';
import { PaddlePredictor } from './net/predict.js';
import { T, COLORS } from './config.js';
import { LETTERS } from './quiz.js';

const game = new Game();
game.replica = true;

// The world is rendered from interpolated snapshots, a little in the past.
// Your own paddle is not: it is predicted forward to now, so a key press moves
// it on the very next frame instead of after a round trip.
const stream = new SnapshotStream();
const predictor = new PaddlePredictor();
const nowSec = () => performance.now() / 1000;

const joinEl = document.getElementById('join');
const padEl = document.getElementById('pad');
const nameEl = document.getElementById('name');
const joinErr = document.getElementById('joinerr');
const statusEl = document.getElementById('status');
const livesEl = document.getElementById('mylives');
const dropBtn = document.getElementById('drop');
const canvas = document.getElementById('mini');
const ctx = canvas.getContext('2d');

const KEY = 'polypong.token';
let me = { slot: null, color: '#fff', name: '' };
let socket = null;

// ------------------------------------------------------------------ transport

function connect(name) {
  socket = new WebSocket(`ws://${location.host}`);
  socket.addEventListener('open', () => {
    socket.send(encode({ t: C.HELLO, role: 'player', name, token: localStorage.getItem(KEY) }));
  });
  socket.addEventListener('message', (e) => handle(decode(e.data)));
  socket.addEventListener('close', () => {
    statusEl.textContent = 'reconnecting…';
    setTimeout(() => connect(me.name || name), 1000);
  });
}

const sendMsg = (msg) => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(encode(msg));
};

function handle(msg) {
  if (!msg) return;
  if (msg.t === S.ERROR) { joinErr.textContent = msg.msg; return; }
  if (msg.t === S.WELCOME && msg.role === 'player') {
    me = { slot: msg.slot, color: msg.color, name: msg.name };
    localStorage.setItem(KEY, msg.token);
    document.getElementById('mycolor').style.background = me.color;
    document.getElementById('myname').textContent = me.name;
    livesEl.style.color = me.color;
    joinEl.classList.add('hidden');
    padEl.classList.remove('hidden');
    predictor.reset();
    resize();
    return;
  }
  if (msg.t === S.SNAP) {
    stream.push(msg.c, msg.s);
    // Prediction anchors on the newest raw snapshot, never on the interpolated
    // one: everything after the anchor is replayed from the local input log, so
    // the anchor wants to be as fresh as it can be.
    const mine = me.slot === null ? null : msg.s.pl[me.slot];
    if (mine) predictor.onAuthoritative(mine.s, nowSec());
    return;
  }
  if (msg.t === S.QUIZ_ASK) return quizAsk(msg);
  if (msg.t === S.QUIZ_TICK) return quizTick(msg);
  if (msg.t === S.QUIZ_END) return quizEnd(msg);
  if (msg.t === S.QUIZ_OFF) return quizHide();
}

// --------------------------------------------------------------------- quiz
// A DOM overlay, never the canvas: the text has to be selectable, focusable
// and readable by a screen reader. Eliminated students get the same overlay —
// answering is how they get back into the arena.

const quizEl = document.getElementById('quiz');
const qText = document.getElementById('qtext');
const qOpts = document.getElementById('qopts');
const qTimer = document.getElementById('qtimer');

let quiz = null;          // { qid, options, locked }
let hideTimer = null;

function quizAsk(msg) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  quiz = { qid: msg.qid, options: msg.options, locked: false, choice: null };

  qText.textContent = msg.q;
  qTimer.textContent = '';

  qOpts.innerHTML = '';
  qOpts.classList.toggle('two', msg.options.length === 2);
  msg.options.forEach((text, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'qopt';
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `<span class="qletter">${LETTERS[i]}</span><span class="qlabel"></span>`;
    b.querySelector('.qlabel').textContent = text;
    b.addEventListener('click', () => choose(i));
    qOpts.appendChild(b);
  });

  setDir(0);                       // never keep drifting while a question is up
  quizEl.classList.remove('hidden');
  const first = qOpts.querySelector('.qopt');
  if (first) first.focus();
}

function choose(i) {
  if (!quiz || quiz.locked) return;
  quiz.locked = true;
  quiz.choice = i;
  [...qOpts.children].forEach((b, j) => {
    b.setAttribute('aria-pressed', j === i ? 'true' : 'false');
    b.classList.toggle('picked', j === i);
    b.disabled = true;
  });
  sendMsg({ t: C.ANSWER, qid: quiz.qid, c: i });
}

function quizTick(msg) {
  if (!quiz || msg.qid !== quiz.qid) return;
  // Past the clock the timer simply goes away. It used to say "take your time"
  // and take an `over` class — which collided with the victory overlay's own
  // `.over` rule and turned this span into a fullscreen sheet that swallowed
  // every tap on the answer buttons.
  qTimer.textContent = msg.overtime ? '' : `${msg.remaining}s`;
}

function quizEnd(msg) {
  if (!quiz || msg.qid !== quiz.qid) { quizHide(); return; }
  quiz.locked = true;
  [...qOpts.children].forEach((b, j) => {
    b.disabled = true;
    b.classList.toggle('right', j === msg.correct);
    b.classList.toggle('wrong', j === quiz.choice && j !== msg.correct);
  });
  // Green on the right answer, red on yours if it was not: the buttons already
  // say everything the sentence underneath used to.
  qTimer.textContent = '';
  hideTimer = setTimeout(quizHide, 4000);
}

function quizHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  quiz = null;
  quizEl.classList.add('hidden');
}

const quizOpen = () => !!quiz && !quizEl.classList.contains('hidden');

// 1-4 pick an answer. Letters are deliberately NOT bound: A and D drive the
// paddle, and a student reaching for "A" mid-question must not steer.
addEventListener('keydown', (e) => {
  if (!quizOpen() || quiz.locked) return;
  const n = Number(e.key);
  if (n >= 1 && n <= quiz.options.length) { e.preventDefault(); choose(n - 1); }
});

// ------------------------------------------------------------------- victory
// Everyone sees who won, including students eliminated in the first minute.
// Going quiet on them is how a class stops paying attention to the screen.

const overEl = document.getElementById('over');
const overWho = document.getElementById('overwho');

function refreshVictory() {
  const on = game.state === STATE.GAMEOVER;
  overEl.classList.toggle('hidden', !on);
  if (!on) return;
  const w = game.winner;
  overWho.textContent = w ? `${w.name} WINS!` : 'GAME OVER';
  overWho.style.color = w ? (w.color || COLORS[w.idx]) : '#fff';
}

// -------------------------------------------------------------------- status

function refreshStatus() {
  const p = game.players[me.slot];
  if (!p) return;

  livesEl.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('span');
    s.className = 'pip' + (i < p.lives ? ' on' : '');
    livesEl.appendChild(s);
  }

  // The DROP button appearing is the prompt; the mini arena is the rest of it.
  // `statusEl` is left for the one thing a player cannot see for themselves —
  // the connection dropping — which connect() writes on close.
  const job = game.pending[0];
  dropBtn.classList.toggle('show', !!(job && job.player && job.player.idx === me.slot));
  statusEl.textContent = '';
}

// -------------------------------------------------------------------- inputs

let dir = 0;
function setDir(d) {
  if (d === dir) return;
  dir = d;
  // Tell the predictor before the network, not after: the point of prediction
  // is that the paddle has already moved by the time the packet leaves.
  predictor.setDir(d, nowSec());
  sendMsg({ t: C.INPUT, d });
  document.getElementById('left').classList.toggle('active', d === -1);
  document.getElementById('right').classList.toggle('active', d === 1);
}

function bindHold(el, d) {
  const press = (e) => { e.preventDefault(); setDir(d); };
  const release = (e) => { e.preventDefault(); if (dir === d) setDir(0); };
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}
bindHold(document.getElementById('left'), -1);
bindHold(document.getElementById('right'), 1);

// Chromebooks have real keyboards — arrows and A/D work too.
const KEYS_L = new Set(['ArrowLeft', 'KeyA']);
const KEYS_R = new Set(['ArrowRight', 'KeyD']);
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (quizOpen()) return;   // arrow keys belong to the question overlay
  if (KEYS_L.has(e.code)) { e.preventDefault(); setDir(-1); }
  if (KEYS_R.has(e.code)) { e.preventDefault(); setDir(1); }
});
addEventListener('keyup', (e) => {
  if (KEYS_L.has(e.code) && dir === -1) setDir(0);
  if (KEYS_R.has(e.code) && dir === 1) setDir(0);
});
addEventListener('blur', () => setDir(0));

// Aim is two-step on purpose: tap to aim, press DROP to commit. A single
// mis-tap should never burn your one hazard.
canvas.addEventListener('pointerdown', (e) => {
  const job = game.pending[0];
  if (!job || job.player.idx !== me.slot || !game.arena) return;
  const r = canvas.getBoundingClientRect();
  const R = game.viewport.R;
  sendMsg({
    t: C.AIM,
    u: (e.clientX - r.left - game.arena.center.x) / R,
    v: (e.clientY - r.top - game.arena.center.y) / R,
  });
});
dropBtn.addEventListener('click', () => sendMsg({ t: C.PLACE }));

// ---------------------------------------------------------------------- join

function doJoin() {
  const name = nameEl.value.trim();
  if (!name) { joinErr.textContent = 'Type a name first.'; return; }
  joinErr.textContent = '';
  me.name = name;
  connect(name);
}
document.getElementById('go').addEventListener('click', doJoin);
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

// ---------------------------------------------------------------------- view

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(200, r.width || 320), h = Math.max(160, r.height || 320);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  game.setViewport(w, h, dpr);
}
addEventListener('resize', resize);

/**
 * Overwrite the local player's interpolated paddle with the predicted one.
 * Everyone else's paddle stays on the interpolated clock, which is correct:
 * their input has not reached us yet, and guessing at it would be a guess.
 */
function applyOwnPrediction() {
  if (me.slot === null) return;
  const p = game.players[me.slot];
  if (!p || !p.alive || !p.paddle || !p.edge) return;
  const len = p.edge.length;
  if (!(len > 0)) return;
  const f = predictor.predict(nowSec(), {
    speed: T.paddleSpeed,
    min: p.paddle.min / len,
    max: p.paddle.max / len,
  });
  if (f === null) return;
  p.paddle.s = Math.min(p.paddle.max, Math.max(p.paddle.min, f * len));
}

let last = performance.now();
let statusKey = '';
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  const snap = stream.advance(dt);
  if (snap) {
    game.applySnapshot(snap);
    applyOwnPrediction();
    game.pushTrails();

    // refreshStatus rewrites DOM, so it runs on change rather than every frame.
    const p = game.players[me.slot];
    const job = game.pending[0];
    const key = `${game.state}|${p ? p.lives : ''}|${p ? p.alive : ''}|${job ? job.player.idx : ''}|${game.winner ? game.winner.idx : ''}`;
    if (key !== statusKey) {
      statusKey = key;
      refreshStatus();
      refreshVictory();
    }
  }

  game.update(dt);
  render(ctx, game, now / 1000);
  requestAnimationFrame(frame);
}
resize();
requestAnimationFrame(frame);
window.game = game;
window.net = { stream, predictor };
