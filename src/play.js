import { Game, STATE } from './game.js';
import { render } from './render.js';
import { C, S, decode, encode } from './net/protocol.js';
import { LETTERS } from './quiz.js';

const game = new Game();
game.replica = true;

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
let lastSnapAt = 0;

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
    resize();
    return;
  }
  if (msg.t === S.SNAP) {
    game.applySnapshot(msg.s);
    lastSnapAt = performance.now();
    refreshStatus();
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
const qWhy = document.getElementById('qwhy');
const qText = document.getElementById('qtext');
const qOpts = document.getElementById('qopts');
const qTimer = document.getElementById('qtimer');
const qStatus = document.getElementById('qstatus');

let quiz = null;          // { qid, options, locked }
let hideTimer = null;

function quizAsk(msg) {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  quiz = { qid: msg.qid, options: msg.options, locked: false, choice: null };

  qWhy.textContent = msg.reason === 'elimination' ? 'QUESTION — after an elimination'
    : msg.reason === 'volley' ? 'QUESTION — after 3 volleys'
    : 'QUESTION';
  qText.textContent = msg.q;
  qTimer.textContent = '';
  qStatus.textContent = msg.twoOption ? 'Pick one of two answers.' : 'Pick one answer.';

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
  qStatus.textContent = `Locked in ${LETTERS[i]}. Waiting for the rest of the class…`;
  sendMsg({ t: C.ANSWER, qid: quiz.qid, c: i });
}

function quizTick(msg) {
  if (!quiz || msg.qid !== quiz.qid) return;
  qTimer.textContent = msg.overtime ? 'take your time' : `${msg.remaining}s`;
  qTimer.classList.toggle('over', !!msg.overtime);
  if (!quiz.locked) {
    qStatus.textContent = `${msg.answered} of ${msg.total} answered — pick one answer.`;
  }
}

function quizEnd(msg) {
  if (!quiz || msg.qid !== quiz.qid) { quizHide(); return; }
  quiz.locked = true;
  [...qOpts.children].forEach((b, j) => {
    b.disabled = true;
    b.classList.toggle('right', j === msg.correct);
    b.classList.toggle('wrong', j === quiz.choice && j !== msg.correct);
  });
  qTimer.textContent = '';
  const key = `${LETTERS[msg.correct]}. ${msg.options[msg.correct]}`;
  qStatus.textContent =
    msg.youWere === 'right' ? (msg.revived ? `Correct — you are back in the game!` : `Correct.`)
    : msg.youWere === 'missed' ? `Time. The answer was ${key}.`
    : `Not this time. The answer was ${key}.`;
  if (msg.targeted) qStatus.textContent += ' Watch your wall on the next serve.';
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

  const job = game.pending[0];
  const mine = job && job.player && job.player.idx === me.slot;
  dropBtn.classList.toggle('show', !!mine);

  if (mine) {
    statusEl.textContent = `you are out — tap the arena, then DROP IT to place your ${job.kind === 'sun' ? 'SUN' : 'BLACK HOLE'}`;
  } else if (game.state === STATE.PLACEMENT) {
    statusEl.textContent = `${job ? job.player.name : 'someone'} is placing a hazard…`;
  } else if (game.state === STATE.MENU) {
    statusEl.textContent = 'waiting for the teacher to start…';
  } else if (game.state === STATE.GAMEOVER) {
    statusEl.textContent = game.winner ? `${game.winner.name} wins!` : 'game over';
  } else if (!p.alive) {
    statusEl.textContent = 'you are out — watch for your next chance';
  } else {
    statusEl.textContent = '';
  }
}

// -------------------------------------------------------------------- inputs

let dir = 0;
function setDir(d) {
  if (d === dir) return;
  dir = d;
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

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (game.state === STATE.PLAYING && now - lastSnapAt < 250) {
    for (const b of game.balls) { b.p.x += b.v.x * dt; b.p.y += b.v.y * dt; }
  }
  game.update(dt);
  render(ctx, game, now / 1000);
  requestAnimationFrame(frame);
}
resize();
requestAnimationFrame(frame);
window.game = game;
