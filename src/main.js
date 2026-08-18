import { Game, STATE } from './game.js';
import { render } from './render.js';
import { KEY_LABELS, COLORS } from './config.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

// Local driver: turns this machine's keyboard and mouse into Game API calls.
// A websocket driver will call exactly the same three methods.
const held = new Set();

function syncInput() {
  for (const p of game.players) {
    if (p.isBot || !p.keys) continue;
    let dir = 0;
    if (held.has(p.keys[0])) dir -= 1;
    if (held.has(p.keys[1])) dir += 1;
    game.setInput(p.idx, dir);
  }
}

function aimFromPointer(e) {
  const r = canvas.getBoundingClientRect();
  const job = game.pending[0];
  if (!job || !game.arena) return null;
  const { R } = game.viewport;
  const u = (e.clientX - r.left - game.arena.center.x) / R;
  const v = (e.clientY - r.top - game.arena.center.y) / R;
  game.aimHazard(job.player.idx, u, v);
  return job;
}

const BLOCK = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']);
addEventListener('keydown', (e) => {
  if (BLOCK.has(e.code)) e.preventDefault();
  if (e.repeat) return;
  held.add(e.code);
  syncInput();
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (game.state === STATE.PLAYING || game.state === STATE.COUNTDOWN) game.paused = !game.paused;
  }
});
addEventListener('keyup', (e) => { held.delete(e.code); syncInput(); });
addEventListener('blur', () => { held.clear(); syncInput(); });

canvas.addEventListener('pointermove', aimFromPointer);
canvas.addEventListener('pointerdown', (e) => {
  const job = aimFromPointer(e);
  if (job) game.placeHazard(job.player.idx);
});

const game = new Game();

function resize() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(320, innerWidth || 960), h = Math.max(240, innerHeight || 600);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  game.setViewport(w, h, dpr);
}
addEventListener('resize', resize);

// ------------------------------------------------------------------- menu UI

const menu = document.getElementById('menu');
const over = document.getElementById('over');
const playersSel = document.getElementById('players');
const botsSel = document.getElementById('bots');
const legend = document.getElementById('legend');

function refreshMenu() {
  const total = +playersSel.value;
  const prev = +botsSel.value;
  botsSel.innerHTML = '';
  for (let b = 0; b <= total; b++) {
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = b === 0 ? '0 (all human)' : b === total ? `${b} (watch mode)` : String(b);
    botsSel.appendChild(o);
  }
  botsSel.value = String(Math.min(prev, total));

  const humans = total - +botsSel.value;
  legend.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const isBot = i >= humans;
    row.innerHTML =
      `<span class="dot" style="background:${COLORS[i]}"></span>` +
      `<span class="who">${isBot ? `BOT ${i + 1}` : `P${i + 1}`}</span>` +
      `<span class="keys">${isBot ? 'CPU' : KEY_LABELS[i]}</span>`;
    legend.appendChild(row);
  }
}

playersSel.addEventListener('change', refreshMenu);
botsSel.addEventListener('change', refreshMenu);

document.getElementById('start').addEventListener('click', () => {
  menu.classList.add('hidden');
  over.classList.add('hidden');
  game.start(+playersSel.value, +botsSel.value);
});
document.getElementById('again').addEventListener('click', () => {
  over.classList.add('hidden');
  menu.classList.remove('hidden');
  game.state = STATE.MENU;
});

let overShown = false;
function syncOverlays() {
  if (game.state === STATE.GAMEOVER && !overShown) {
    overShown = true;
    const w = game.winner;
    const title = document.getElementById('over-title');
    title.textContent = w ? `${w.name} WINS` : 'DRAW';
    title.style.color = w ? w.color : '#fff';
    document.getElementById('over-sub').textContent =
      `${game.round} rounds  ·  ${game.hazards.length} hazards left on the field`;
    over.classList.remove('hidden');
  }
  if (game.state !== STATE.GAMEOVER) overShown = false;
}

// ------------------------------------------------------------------ mainloop

const STEP = 1 / 120;
let acc = 0;
let last = performance.now();

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard++ < 240) {
    game.update(STEP);
    acc -= STEP;
  }
  render(ctx, game, now / 1000);
  syncOverlays();
  requestAnimationFrame(frame);
}

refreshMenu();
resize();
requestAnimationFrame(frame);

window.game = game; // dev handle
