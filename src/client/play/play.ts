// The student page. SPEC §8.
//
// Seven screens, one socket, one requestAnimationFrame loop, and a hard rule
// that the frame path allocates nothing (SPEC C2). Everything expensive — DOM
// construction, roster lists, the question modal — happens on a message, of
// which there are a handful a minute. Everything in the loop reads pooled
// objects that `SceneBuilder` overwrites in place.
//
// THREE THINGS IN HERE ARE EASY TO GET WRONG AND EXPENSIVE TO SHIP WRONG:
//
// 1. The rank/seat mapping. `Edge.owner` ranks LIVING players, so the wall a
//    student defends moves every time somebody is eliminated. It is recomputed
//    from the snapshot's alive set every frame in scene.ts, never cached.
//
// 2. The prediction sign. The wire's paddle position is a fraction from
//    `edge.a` to `edge.b`, and which screen direction that runs in depends on
//    `edge.rightSign` — which flips between walls and can flip UNDER a held
//    key when the arena shrinks. The server multiplies by it (game.ts); the
//    local predictor has to multiply by exactly the same thing or the
//    predicted paddle slides one way while the authoritative one slides the
//    other. So `input` goes to the server in the SCREEN frame (SPEC §5.3) and
//    into the predictor in the ARENA frame, and the arena-frame value is
//    re-derived every frame so a mid-match rebuild corrects itself.
//
// 3. Focus. The question modal is real DOM over a canvas, so opening it must
//    move focus into it and closing it must put focus back, or a student on a
//    screen reader is reading a page that is no longer on screen.

import { MAX_SEATS, NAME_MAX_LEN, T } from '../../shared/config';
import type { Phase, RosterEntry, ServerMsg, Snapshot } from '../../shared/protocol';
import { Socket } from '../net/socket';
import { SnapshotStream } from '../net/interp';
import { PaddlePredictor, type Dir, type PredictRange } from '../net/predict';
import { Camera } from '../view/camera';
import type { Viewport } from '../view/camera';
import { Effects, render, resetRenderState } from '../view/render';
import {
  NEUTRAL, PADDLE_MAX_FRAC, PADDLE_MIN_FRAC, SceneBuilder, seatColor, type BuildInput,
} from './scene';
import { QuestionModal } from './modal';
import { isQuestion, isReveal, isRoster, isSnapshot, safeName } from './guards';

// --------------------------------------------------------------- constants

const NAME_KEY = 'polypong.name';
/** No snapshot for this long means the socket is down. The server broadcasts
 *  at TIMING.snapHz in every phase including the lobby, so silence is never
 *  normal. */
const OFFLINE_AFTER = 1.8;
/** How long a join may hang before we tell the student rather than spin. */
const JOIN_TIMEOUT = 8;
/** Chromebook GPUs gain nothing from a 3x backing store. */
const MAX_DPR = 2;

/** Paddle travel in wire units. Matches `Paddle.attach` and T.paddleSpeed. */
const RANGE: PredictRange = {
  speed: T.paddleSpeed,
  min: PADDLE_MIN_FRAC,
  max: PADDLE_MAX_FRAC,
};

// --------------------------------------------------------------------- dom

const el = <E extends HTMLElement>(id: string): E => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as E;
};

const canvas = el<HTMLCanvasElement>('arena');
const ctx = canvas.getContext('2d', { alpha: false });

const screens = {
  name: el('s-name'),
  lobby: el('s-lobby'),
  wait: el('s-wait'),
  ended: el('s-ended'),
};
type ScreenName = keyof typeof screens | 'game';

const joinForm = el<HTMLFormElement>('join-form');
const nameInput = el<HTMLInputElement>('name-input');
const joinBtn = el<HTMLButtonElement>('join-btn');
const joinError = el('join-error');
const lobbySwatch = el('lobby-swatch');
const lobbyName = el('lobby-name');
const lobbySeat = el('lobby-seat');
const lobbyWait = el('lobby-wait');
const lobbyCount = el('lobby-count');
const lobbyList = el<HTMLUListElement>('lobby-list');
const waitCount = el('wait-count');
const waitList = el<HTMLUListElement>('wait-list');
const endedMsg = el('ended-msg');
const endedRetry = el<HTMLButtonElement>('ended-retry');
const scoreboard = el('scoreboard');
const sbTitle = el('sb-title');
const sbRows = el<HTMLUListElement>('sb-rows');
const netstatus = el('netstatus');

nameInput.maxLength = NAME_MAX_LEN;

// ------------------------------------------------------------------- state

let socket: Socket | null = null;
let screen: ScreenName = 'name';

let myPid: string | null = null;
let myName = '';
let mySeat: number | null = null;
let maxLives = 3;
let phase: Phase = 'lobby';
let roster: RosterEntry[] = [];
let sessionOver = false;

const stream = new SnapshotStream();
const predictor = new PaddlePredictor();
const camera = new Camera();
const effects = new Effects();
const builder = new SceneBuilder();
const modal = new QuestionModal(el('qmodal'), sendAnswer);

let viewport: Viewport = { w: 1, h: 1, dpr: 1 };
/** Reused every frame. An object literal here would be the only garbage the
 *  render path produces, which is exactly the budget SPEC C2 protects. */
const buildInput: BuildInput = {
  snap: null as unknown as Snapshot,
  mySeat: null,
  myName: '',
  maxLives: 3,
  viewport,
  effects,
};
let lastRaw: Snapshot | null = null;
let lastFrameT = 0;
let lastMsgAt = 0;
let offline = false;
let joinedOnce = false;
let joinDeadline = 0;
let everSeated = false;

/** Which key is physically down. `dir` is derived, never assigned directly. */
let keyLeft = false;
let keyRight = false;
let sentDir: Dir = 0;
/** Sign that turns screen direction into wire direction on the current wall. */
let rightSign = 1;

/** Discrete-event detection for effects, per seat. -1 = nothing seen yet. */
const prevLives = new Int16Array(MAX_SEATS).fill(-1);
const prevAlive = new Int8Array(MAX_SEATS).fill(-1);

const nowSec = (): number => performance.now() / 1000;

// -------------------------------------------------------------- name entry

function readStoredName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // A locked-down Chromebook profile can refuse storage. The student simply
    // types their name again next period; it is not worth an error.
  }
}

/**
 * The socket layer replays a stored join token on its own, so a student who
 * reloads mid-match reclaims their seat with no name screen. The NAME is
 * stored alongside it here for the other case: a token from before the
 * teacher restarted the app is unknown to the new server, which would
 * otherwise seat them as "Player 4". Sending the name too means the reclaim
 * falls back to their real name instead.
 */
function connect(name: string): void {
  if (socket) socket.close();
  joinBtn.disabled = true;
  joinBtn.textContent = 'JOINING…';
  joinDeadline = nowSec() + JOIN_TIMEOUT;
  lastMsgAt = nowSec();
  sessionOver = false;
  const s = new Socket('player', name);
  socket = s;
  s.onMessage(handleMessage);
  s.connect();
}

joinForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const typed = nameInput.value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LEN);
  if (typed === '') {
    showJoinError('Type your name first.');
    nameInput.focus();
    return;
  }
  hideJoinError();
  myName = typed;
  storeName(typed);
  connect(typed);
});

// Enter submits. Implicit form submission normally covers this, but it is the
// single most likely thing a student does after typing their name, and one
// browser quirk between it and the lobby is a whole class stuck on a text
// field. Explicit beats implicit here; `requestSubmit` fires the same submit
// handler exactly once.
nameInput.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  joinForm.requestSubmit();
});

endedRetry.addEventListener('click', () => {
  // A hard restart is the honest response to "your teacher removed you" or
  // "the session ended": everything this page knew is stale.
  location.reload();
});

function showJoinError(msg: string): void {
  joinError.textContent = msg;
  joinError.hidden = false;
  joinBtn.disabled = false;
  joinBtn.textContent = 'JOIN THE GAME';
}

function hideJoinError(): void {
  joinError.hidden = true;
  joinError.textContent = '';
}

// ---------------------------------------------------------------- messages

function handleMessage(msg: ServerMsg): void {
  lastMsgAt = nowSec();
  if (offline) goOnline();
  try {
    route(msg);
  } catch (err) {
    // One malformed frame must never take the page down for the rest of the
    // lesson. Log it and keep drawing the last good world.
    console.warn('polypong: dropped a message', err);
  }
}

function route(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome': {
      if (msg.role !== 'player') return;
      joinedOnce = true;
      joinDeadline = 0;
      myPid = msg.pid;
      if (typeof msg.name === 'string' && msg.name !== '') {
        // The server may have suffixed a duplicate name. Its answer wins.
        myName = msg.name;
        storeName(msg.name);
      }
      if (msg.seat === null || Number.isFinite(msg.seat)) mySeat = msg.seat;
      hideJoinError();
      joinBtn.disabled = false;
      joinBtn.textContent = 'JOIN THE GAME';
      // A reconnect lands here mid-match: re-arm the paddle, because the room
      // zeroed our input the moment the socket dropped.
      predictor.reset();
      stream.reset();
      if (sentDir !== 0) socket?.send({ t: 'input', d: sentDir });
      paintIdentity();
      updateScreen();
      return;
    }

    case 'lobby': {
      if (isRoster(msg.roster)) {
        roster = msg.roster;
        const mine = myPid === null ? undefined : roster.find((r) => r.pid === myPid);
        if (mine) {
          mySeat = mine.seat;
          myName = mine.name;
        }
      }
      const lives = msg.settings?.lives;
      if (typeof lives === 'number' && Number.isFinite(lives)) maxLives = lives;
      setPhase(msg.phase);
      paintIdentity();
      paintRoster();
      updateScreen();
      return;
    }

    case 'snap': {
      if (!isSnapshot(msg.s) || typeof msg.c !== 'number' || !Number.isFinite(msg.c)) return;
      stream.push(msg.c, msg.s);
      setPhase(msg.s.ph);
      return;
    }

    case 'question': {
      if (!isQuestion(msg)) return;
      // Reading the question is the job now. A key still held from play would
      // otherwise walk the paddle across the wall while nobody is looking.
      releaseKeys();
      modal.open(msg);
      return;
    }

    case 'qtick': {
      if (typeof msg.qid !== 'string') return;
      modal.tick(msg.qid, num(msg.answered), num(msg.total), num(msg.remaining));
      return;
    }

    case 'reveal': {
      // A reveal for a question this client never saw (joined late, dropped
      // and came back) is dropped by the modal on the qid check.
      if (isReveal(msg)) modal.reveal(msg);
      return;
    }

    case 'questionOff':
      modal.hide();
      return;

    case 'scoreboard':
      paintScoreboard(msg.rows);
      return;

    case 'error': {
      const text = typeof msg.msg === 'string' && msg.msg !== '' ? msg.msg : 'Could not join.';
      if (joinedOnce) {
        // Already in the game: an error here is informational, and throwing a
        // seated student back to the name screen would be worse than the
        // error itself.
        netstatus.textContent = text;
        netstatus.hidden = false;
        return;
      }
      // "This class is full." is a real answer. It arrives on a socket that
      // will never be welcomed, so stop retrying and let them try again.
      socket?.close();
      socket = null;
      showJoinError(text);
      screen = 'name';
      applyScreen();
      return;
    }

    case 'ended':
      sessionOver = true;
      socket?.close();
      socket = null;
      modal.hide();
      endedMsg.textContent = typeof msg.msg === 'string' ? msg.msg : 'The session ended.';
      updateScreen();
      return;

    default:
      // `sets` and `qlive` are teacher-only and never arrive here.
      return;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function sendAnswer(qid: string, choice: number): void {
  socket?.send({ t: 'answer', qid, choice });
}

function setPhase(next: Phase): void {
  if (next === phase) return;
  phase = next;
  if (next === 'countdown') {
    // A fresh match must not inherit the previous one's ball tails, sparks, or
    // life-change history.
    resetRenderState();
    effects.clear();
    prevLives.fill(-1);
    prevAlive.fill(-1);
  }
  if (next !== 'matchover') hideScoreboard();
  // The modal belongs to exactly two phases. The server sends `questionOff`
  // only when a match ends (match.ts), so the ordinary path out of a question
  // — reveal, announce, 3-2-1, serve — has no message that closes it. The
  // phase does. Without this the modal sits over the arena for the rest of
  // the round and the student cannot see the ball they are about to concede.
  if (next !== 'question' && next !== 'reveal') modal.hide();
  updateScreen();
}

// ----------------------------------------------------------------- screens

function updateScreen(): void {
  const next = pickScreen();
  if (next === screen) return;
  screen = next;
  applyScreen();
}

function pickScreen(): ScreenName {
  if (sessionOver) return 'ended';
  if (!joinedOnce) return 'name';
  if (phase === 'lobby') return 'lobby';
  return mySeat === null ? 'wait' : 'game';
}

function applyScreen(): void {
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== screen;
  canvas.hidden = screen !== 'game';
  if (screen === 'game') {
    // Focus goes to the canvas so the keyboard belongs to the game and a
    // stray Tab does not land on something behind the arena.
    if (!modal.isOpen) canvas.focus();
  } else {
    releaseKeys();
  }
  if (screen === 'name') nameInput.focus();
  if (screen === 'wait' || screen === 'lobby') paintRoster();
}

/**
 * Seats do not exist until the teacher presses Start, so in the lobby the
 * colour is PROVISIONAL: seats are handed out in join order (match.ts
 * `startMatch`), so a student's position in the roster is the seat they will
 * get, for everyone who fits inside the arena. Showing that beats a lobby
 * where every student is the same grey — SPEC §8 asks for their colour, and
 * this is the only colour there is to show yet.
 */
function rosterIndex(pid: string | null): number {
  if (pid === null) return -1;
  for (let i = 0; i < roster.length; i++) if (roster[i]!.pid === pid) return i;
  return -1;
}

function colorFor(r: RosterEntry, index: number): string {
  if (r.seat !== null) return seatColor(r.seat);
  return index >= 0 ? seatColor(index) : NEUTRAL;
}

function paintIdentity(): void {
  const idx = rosterIndex(myPid);
  const color = mySeat !== null ? seatColor(mySeat) : idx >= 0 ? seatColor(idx) : NEUTRAL;
  lobbySwatch.style.background = color;
  lobbyName.textContent = myName || 'You';
  lobbyName.style.color = color;
  if (mySeat === null) {
    lobbySeat.textContent = 'READY';
    lobbyWait.textContent =
      'Waiting for your teacher to start the game. If every seat is taken you play in the next one.';
  } else {
    lobbySeat.textContent = `SEAT ${mySeat + 1}`;
    lobbyWait.textContent = 'Waiting for your teacher to start the game.';
  }
  lobbySeat.style.borderColor = color;
  lobbySeat.style.color = color;
}

/** Rebuilt on a roster message only. Never from the frame loop. */
function paintRoster(): void {
  const playing = roster.filter((r) => r.seat !== null);
  lobbyCount.textContent = String(roster.length);
  waitCount.textContent = String(playing.length);
  fillRoster(lobbyList, roster);
  fillRoster(waitList, playing.length > 0 ? playing : roster);
}

function fillRoster(list: HTMLUListElement, rows: readonly RosterEntry[]): void {
  list.replaceChildren();
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'rrow empty';
    li.textContent = 'Nobody else yet.';
    list.append(li);
    return;
  }
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'rrow';
    const dot = document.createElement('span');
    dot.className = 'swatch small';
    dot.style.background = colorFor(r, rosterIndex(r.pid));
    const name = document.createElement('span');
    name.className = 'rname';
    // textContent, always: this string came from another student.
    name.textContent = safeName(r.name);
    if (r.pid === myPid) {
      li.classList.add('me');
      const you = document.createElement('span');
      you.className = 'tag you';
      you.textContent = 'YOU';
      li.append(dot, name, you);
    } else {
      const state = document.createElement('span');
      state.className = 'rstate';
      state.textContent = rosterState(r);
      li.append(dot, name, state);
    }
    list.append(li);
  }
}

function rosterState(r: RosterEntry): string {
  if (!r.connected) return 'DROPPED';
  if (r.seat === null) return phase === 'lobby' ? 'READY' : 'WAITING';
  if (r.status === 'out') return 'OUT';
  if (r.status === 'alive') return `${r.lives} LEFT`;
  return 'PLAYING';
}

function paintScoreboard(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  sbTitle.textContent = 'GAME OVER';
  sbRows.replaceChildren();
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const li = document.createElement('li');
    li.className = 'sbrow';
    if (r.pid === myPid) li.classList.add('me');
    const place = document.createElement('span');
    const p = typeof r.place === 'number' && r.place > 0 ? r.place : 0;
    place.className = 'sbplace';
    place.textContent = p === 0 ? '—' : String(p);
    if (p === 1) place.classList.add('first');
    const name = document.createElement('span');
    name.className = 'sbname';
    name.textContent = safeName(r.name);
    const q = document.createElement('span');
    q.className = 'sbq';
    q.textContent = `${num(r.correct)} / ${num(r.attempted)}`;
    const w = document.createElement('span');
    w.className = 'sbw';
    w.textContent = String(num(r.matchesWon));
    li.append(place, name, q, w);
    sbRows.append(li);
  }
  scoreboard.hidden = false;
}

function hideScoreboard(): void {
  scoreboard.hidden = true;
}

// ------------------------------------------------------------------- input
// SPEC §5.3: A and D, nothing else, sent on change only. Both keys held is a
// net zero, and a key held when the window loses focus is released — a stuck
// key runs a student into a wall for the rest of the round and they cannot
// tell why.

function currentDir(): Dir {
  const d = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

function pushDir(): void {
  const dir = currentDir();
  // Prediction runs in the ARENA frame, so it takes the same multiply the
  // server applies. The send stays in the screen frame (SPEC §5.3).
  predictor.setDir((dir * rightSign) as Dir, nowSec());
  if (dir === sentDir) return;
  sentDir = dir;
  socket?.send({ t: 'input', d: dir });
}

function releaseKeys(): void {
  if (!keyLeft && !keyRight && sentDir === 0) return;
  keyLeft = false;
  keyRight = false;
  pushDir();
}

window.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const target = ev.target;
  // Never steal a key from the name field.
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  if (modal.isOpen) {
    // 1-4 and A-D answer. The match is frozen behind the modal anyway, so
    // there is no movement to lose by giving the keys to the question.
    if (modal.selectByKey(ev.key)) ev.preventDefault();
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === 'a') {
    if (!keyLeft) {
      keyLeft = true;
      pushDir();
    }
    ev.preventDefault();
  } else if (k === 'd') {
    if (!keyRight) {
      keyRight = true;
      pushDir();
    }
    ev.preventDefault();
  }
});

window.addEventListener('keyup', (ev) => {
  const k = ev.key.toLowerCase();
  if (k === 'a' && keyLeft) {
    keyLeft = false;
    pushDir();
  } else if (k === 'd' && keyRight) {
    keyRight = false;
    pushDir();
  }
});

window.addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseKeys();
});

// ------------------------------------------------------------- frame loop

function syncCanvas(): boolean {
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return false;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  // Assigning width/height reallocates the backing store, so it is done only
  // when it actually changed. The element itself is never replaced, which is
  // what stops a resize from leaking canvases.
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  if (viewport.w !== w || viewport.h !== h || viewport.dpr !== dpr) {
    viewport = { w, h, dpr };
  }
  return true;
}

/**
 * Events the client can see for itself: a life dropping and an elimination.
 * The server sends no particles (SPEC: they are renderer-owned), so this is
 * where a hit becomes something you feel. Detected on RAW snapshots, because
 * the interpolated stream deliberately holds a pair across a shape change and
 * would report the same event twice.
 */
function reactTo(raw: Snapshot): void {
  for (let i = 0; i < raw.pl.length; i++) {
    const p = raw.pl[i]!;
    const seat = p.i;
    if (seat < 0 || seat >= MAX_SEATS) continue;
    const wasLives = prevLives[seat]!;
    const wasAlive = prevAlive[seat]!;
    const x = builder.wallMid[seat * 2]!;
    const y = builder.wallMid[seat * 2 + 1]!;
    const color = seatColor(seat);

    if (wasAlive === 1 && p.a === 0) {
      effects.emit(x, y, color, 34, 0.75);
      effects.bump(seat === mySeat ? 1 : 0.7);
    } else if (wasLives >= 0 && p.l < wasLives) {
      effects.emit(x, y, color, 18, 0.5);
      effects.bump(seat === mySeat ? 0.6 : 0.35);
    }
    prevLives[seat] = p.l;
    prevAlive[seat] = p.a;
  }
}

function frame(ms: number): void {
  requestAnimationFrame(frame);
  const t = ms / 1000;
  let dt = t - lastFrameT;
  lastFrameT = t;
  // A backgrounded tab produces one enormous dt. Clamp rather than
  // fast-forwarding every animation at once.
  if (!(dt > 0) || dt > 0.25) dt = 1 / 60;

  try {
    checkLink();
    modal.frame(dt);
    if (screen !== 'game' || !ctx) return;
    if (!syncCanvas()) return;

    const snap = stream.advance(dt);
    if (!snap) return;

    const raw = stream.newest;
    if (raw && raw !== lastRaw) {
      lastRaw = raw;
      reactTo(raw);
      const mine = mySeat === null ? undefined : raw.pl[mySeat];
      if (mine) predictor.onAuthoritative(mine.s, nowSec(), RANGE);
    }

    buildInput.snap = snap;
    buildInput.mySeat = mySeat;
    buildInput.myName = myName;
    buildInput.maxLives = maxLives;
    buildInput.viewport = viewport;
    const scene = builder.build(buildInput);

    const edge = builder.myEdge;
    if (edge) {
      everSeated = true;
      // The wall moved under an elimination: re-derive the sign, and re-issue
      // the currently held direction through it so a held key keeps meaning
      // the same thing on screen.
      if (edge.rightSign !== rightSign) {
        rightSign = edge.rightSign;
        predictor.setDir((currentDir() * rightSign) as Dir, nowSec());
      }
      camera.setViewEdge(edge);
      const wall = builder.myWall;
      // Own paddle on the prediction clock; every other paddle interpolated.
      if (wall) {
        const p = predictor.predict(nowSec(), RANGE);
        if (p !== null) wall.paddle = p;
      }
    } else if (!everSeated) {
      camera.setViewEdge(null);
    }
    // Eliminated: the wall is gone, so the camera holds the angle it had.
    // Snapping back to canonical would spin the whole arena under a student
    // who is still watching the game they were just in.

    camera.update(scene.arena, viewport, dt);
    render(ctx, scene, camera, t, dt);
  } catch (err) {
    console.warn('polypong: frame skipped', err);
  }
}

/** SPEC §8: say it plainly, because it reconnects on its own and a frozen
 *  screen with no explanation makes a student put their hand up. */
function checkLink(): void {
  if (!joinedOnce) {
    if (joinDeadline > 0 && nowSec() > joinDeadline) {
      joinDeadline = 0;
      showJoinError('Cannot reach the game. Check the address with your teacher, then try again.');
      socket?.close();
      socket = null;
    }
    return;
  }
  if (sessionOver) return;
  const silent = nowSec() - lastMsgAt;
  if (!offline && silent > OFFLINE_AFTER) {
    offline = true;
    netstatus.textContent = 'Reconnecting…';
    netstatus.hidden = false;
  }
}

function goOnline(): void {
  offline = false;
  netstatus.hidden = true;
  netstatus.textContent = '';
}

// -------------------------------------------------------------------- boot

const stored = readStoredName();
if (stored !== '') {
  myName = stored;
  nameInput.value = stored;
  connect(stored);
} else {
  nameInput.focus();
}
applyScreen();
lastFrameT = nowSec();
lastMsgAt = nowSec();
requestAnimationFrame(frame);
