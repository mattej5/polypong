// The projected arena. Canonical orientation (SPEC I6: the teacher is not a
// player, so the view edge is null and the rotation is zero), full effects.
//
// This is the one thing on the page that runs at 60 Hz, so it is the one thing
// written to the same rules as the renderer itself: NOTHING IN THIS FILE
// ALLOCATES PER FRAME. The `Scene` object, its wall / ball / hazard views, and
// its arrays are built once and mutated in place; arenas are memoised by
// player count, because `buildArena` is a pure function of that count and the
// result is immutable. No DOM panel is touched from here — those update on
// message, not on frame (see console.ts).
//
// One allocation on the frame path is NOT this file's to fix and is recorded
// here so nobody has to rediscover it: `SnapshotStream.advance` calls
// `blendSnapshots` (src/client/net/interp.ts), which rebuilds the player,
// ball, and hazard arrays with `.map` every frame it blends. That is the
// netcode lane's; the teacher console is a caller.
//
// The server never sends a particle or a sound cue, and it should not: they
// are presentation. So the two events this page reacts to audibly - a paddle
// hit and an elimination - are DERIVED here by diffing consecutive raw
// snapshots. That keeps the wire unchanged and keeps the derivation in the one
// place that can afford to be wrong: a missed spark costs nothing.

import { COLORS, MAX_SEATS, T } from '../../shared/config';
import { buildArena, type Arena } from '../../shared/geometry';
import type { Phase, SnapPlayer, Snapshot } from '../../shared/protocol';
import { SnapshotStream } from '../net/interp';
import { Camera, type Viewport, type XY } from '../view/camera';
import {
  Effects,
  render,
  resetRenderState,
  type BallView,
  type HazardView,
  type Scene,
  type WallView,
} from '../view/render';
import type { Sfx } from './audio';

/** Wire input is not trusted: a snapshot claiming 400 balls must not grow an
 *  unbounded pool. The sim's own cap is T.maxBalls; this is headroom over it. */
const BALL_POOL = 16;
const HAZARD_POOL = 16;

/** Paddle half-length in arena units, matching sim/paddle.ts `attach`. */
const PADDLE_FRAC = Math.max(T.paddleFracMin, T.paddleFrac);

/** How far the ball must be from the nearest wall for a direction change to be
 *  a hazard curving it rather than a paddle returning it. */
const NEAR_WALL = 0.06;

/** Direction change, in radians, over one snapshot interval that only a paddle
 *  can produce. A hazard field cannot turn a ball this hard this close to a
 *  wall — it is kept `T.hazardMargin` clear of every one of them. */
const BOUNCE_ANGLE = 1.0;

const seatColor = (seat: number): string => COLORS[((seat % 8) + 8) % 8] ?? '#ffffff';

const arenaCache = new Map<number, Arena>();
function arenaFor(count: number): Arena {
  // Clamped before it is used as a cache key: the player count comes off the
  // wire, and an unclamped one would both build a nonsense polygon and grow
  // this cache without bound.
  const n = Math.min(MAX_SEATS, Math.max(2, Math.floor(count) || 2));
  let a = arenaCache.get(n);
  if (!a) {
    a = buildArena(n);
    arenaCache.set(n, a);
  }
  return a;
}

function aliveCount(snap: Snapshot): number {
  let n = 0;
  for (let i = 0; i < snap.pl.length; i++) if (snap.pl[i]?.a === 1) n++;
  return n;
}

export interface ArenaViewOptions {
  canvas: HTMLCanvasElement;
  sfx: Sfx;
  /** Fired when the snapshot phase changes. The snapshot stream is the only
   *  thing that reports every phase — `lobby` messages are not sent for the
   *  question/reveal/announce transitions. */
  onPhase: (phase: Phase) => void;
  /**
   * Fired when any seat's lives, alive flag, or bot flag changes.
   *
   * The roster panel needs this because `Match` only broadcasts a `lobby`
   * message on a join, a rename, a removal, a start, or an end — not on an
   * elimination. Without this the teacher's roster would still say ALIVE ●●●
   * for a student who lost their last life two minutes ago. It is fired on a
   * CHANGE, not per snapshot, so the roster still repaints on an event rather
   * than thirty times a second.
   */
  onVitals: (players: readonly SnapPlayer[]) => void;
  /** Called once if the render loop fails repeatedly, so the page can say so
   *  instead of silently freezing. */
  onFatal: (message: string) => void;
}

export class ArenaView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly sfx: Sfx;
  private readonly onPhase: (phase: Phase) => void;
  private readonly onVitals: (players: readonly SnapPlayer[]) => void;
  private readonly onFatal: (message: string) => void;

  private readonly stream = new SnapshotStream();
  private readonly camera = new Camera();
  private readonly effects = new Effects();

  // ---- pools. Allocated once, mutated forever.
  private readonly wallPool: WallView[] = [];
  private readonly wallSlots: (WallView | null)[] = [];
  private readonly ballPool: BallView[] = [];
  private readonly ballList: BallView[] = [];
  private readonly hazardPool: HazardView[] = [];
  private readonly hazardList: HazardView[] = [];
  private readonly splitterScratch: XY = { x: 0, y: 0 };
  private readonly vp = { w: 1, h: 1, dpr: 1 };
  private readonly scene: Scene;

  private raf = 0;
  private lastFrame = 0;
  private hasScene = false;
  private maxLives = 3;
  private phase: Phase = 'lobby';
  private prevRaw: Snapshot | null = null;
  private vitalsKey = '';
  private frameErrors = 0;
  private pendingW = 0;
  private pendingH = 0;
  private resizeDirty = true;
  private observer: ResizeObserver | null = null;

  constructor(opts: ArenaViewOptions) {
    this.canvas = opts.canvas;
    this.sfx = opts.sfx;
    this.onPhase = opts.onPhase;
    this.onVitals = opts.onVitals;
    this.onFatal = opts.onFatal;

    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('teacher console: canvas 2d context unavailable');
    this.ctx = ctx;

    for (let i = 0; i < MAX_SEATS; i++) {
      this.wallPool.push({
        rank: i, seat: i, name: '', color: '#ffffff', lives: 0, maxLives: 3,
        paddle: 0.5, paddleHalf: 0.1, isMe: false, bot: false,
      });
      this.wallSlots.push(null);
    }
    for (let i = 0; i < BALL_POOL; i++) this.ballPool.push({ id: i, x: 0, y: 0, hot: false });
    for (let i = 0; i < HAZARD_POOL; i++) {
      this.hazardPool.push({ kind: 'blackhole', x: 0, y: 0, ownerColor: '#ffffff' });
    }

    this.camera.snapToEdge(null); // SPEC §5.2: the teacher view is unrotated.

    this.scene = {
      arena: arenaFor(2),
      phase: 'lobby',
      timer: 0,
      banner: '',
      round: 0,
      walls: this.wallSlots,
      balls: this.ballList,
      hazards: this.hazardList,
      splitter: null,
      me: null,
      myEdge: null,   // null = canonical orientation, the teacher is not seated
      effects: this.effects,
      viewport: this.vp as Viewport,
    };

    // A ResizeObserver rather than a per-frame getBoundingClientRect: reading
    // layout every frame both allocates a DOMRect and forces a synchronous
    // reflow. Fullscreen transitions come through here too.
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        if (!rect) return;
        this.pendingW = rect.width;
        this.pendingH = rect.height;
        this.resizeDirty = true;
      });
      this.observer.observe(this.canvas);
    }
    const rect = this.canvas.getBoundingClientRect();
    this.pendingW = rect.width;
    this.pendingH = rect.height;
  }

  /** Lives at full health, for the wall pips. Comes from match settings. */
  setMaxLives(lives: number): void {
    this.maxLives = Number.isFinite(lives) ? Math.max(1, Math.round(lives)) : 3;
  }

  /** A reconnect, or a server restart: the old timeline is gone. */
  reset(): void {
    this.vitalsKey = '';
    this.stream.reset();
    this.effects.clear();
    this.prevRaw = null;
    this.hasScene = false;
    resetRenderState();
  }

  start(): void {
    if (this.raf !== 0) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.observer?.disconnect();
    this.observer = null;
  }

  push(serverTime: number, snap: Snapshot): void {
    if (!snap || !Array.isArray(snap.pl) || !Array.isArray(snap.bl) || !Array.isArray(snap.hz)) {
      return; // a malformed frame is dropped, never thrown
    }
    this.detect(snap);
    this.stream.push(serverTime, snap);
    if (snap.ph !== this.phase) {
      this.phase = snap.ph;
      this.onPhase(snap.ph);
    }
    const vitals = vitalsKey(snap);
    if (vitals !== this.vitalsKey) {
      this.vitalsKey = vitals;
      this.onVitals(snap.pl);
    }
  }

  // ------------------------------------------------------- derived effects

  private detect(snap: Snapshot): void {
    const prev = this.prevRaw;
    this.prevRaw = snap;
    if (!prev) return;

    // Lives and the alive set are compared across ANY phase: a question's
    // reveal takes lives too, and that deserves the same thump as a ball does.
    const prevArena = arenaFor(Math.max(2, aliveCount(prev)));
    let prevRank = 0;
    for (let k = 0; k < prev.pl.length; k++) {
      const a = prev.pl[k];
      const b = snap.pl[k];
      const rank = prevRank;
      if (a?.a === 1) prevRank++;
      if (!a || !b || a.i !== b.i) continue;

      if (a.a === 1 && b.a === 0) {
        const e = prevArena.goalEdges[rank];
        if (e) this.effects.emit(e.mid.x, e.mid.y, seatColor(a.i), 34, 0.75);
        this.effects.bump(0.85);
        this.sfx.out();
        continue;
      }
      if (b.l < a.l && b.a === 1) {
        const e = prevArena.goalEdges[rank];
        if (e) this.effects.emit(e.mid.x, e.mid.y, seatColor(a.i), 16, 0.5);
        this.effects.bump(0.4);
        this.sfx.concede();
      }
    }

    // Paddle returns, only while the ball is actually moving.
    if (snap.ph !== 'playing' || prev.ph !== 'playing' || prev.rd !== snap.rd) return;
    const arena = arenaFor(Math.max(2, aliveCount(snap)));
    for (let i = 0; i < snap.bl.length; i++) {
      const nb = snap.bl[i];
      if (!nb) continue;
      const ob = findBall(prev.bl, nb.i);
      if (!ob) continue;
      const [ovx, ovy] = ob.v;
      const [nvx, nvy] = nb.v;
      const om = Math.hypot(ovx, ovy);
      const nm = Math.hypot(nvx, nvy);
      if (om < 1e-4 || nm < 1e-4) continue;
      const cos = (ovx * nvx + ovy * nvy) / (om * nm);
      if (cos > Math.cos(BOUNCE_ANGLE)) continue;
      // Near a wall, so a hazard's pull cannot be mistaken for a return: the
      // fields are kept T.hazardMargin clear of every wall.
      let nearest = Infinity;
      for (let e = 0; e < arena.edges.length; e++) {
        const edge = arena.edges[e];
        if (!edge) continue;
        const d = (nb.p[0] - edge.a.x) * edge.n.x + (nb.p[1] - edge.a.y) * edge.n.y;
        if (d < nearest) nearest = d;
      }
      if (nearest > NEAR_WALL) continue;
      this.effects.emit(nb.p[0], nb.p[1], nb.h === 1 ? 'hsl(24,96%,60%)' : 'hsl(196,86%,62%)', 7, 0.35);
      this.effects.bump(0.16);
      this.sfx.hit();
    }
  }

  // ------------------------------------------------------------ scene build

  private assemble(s: Snapshot): void {
    const n = Math.max(2, aliveCount(s));
    const arena = arenaFor(n);
    this.scene.arena = arena;

    for (let i = 0; i < this.wallSlots.length; i++) this.wallSlots[i] = null;

    let rank = 0;
    for (let i = 0; i < s.pl.length; i++) {
      const p = s.pl[i];
      if (!p || p.a !== 1) continue;
      if (rank >= this.wallPool.length) break;
      const edge = arena.goalEdges[rank];
      const w = this.wallPool[rank];
      if (!edge || !w) break;
      w.rank = rank;
      w.seat = p.i;
      w.name = typeof p.n === 'string' ? p.n : '';
      w.color = seatColor(p.i);
      w.lives = p.l;
      w.maxLives = Math.max(this.maxLives, p.l);
      w.paddle = typeof p.s === 'number' && Number.isFinite(p.s) ? p.s : 0.5;
      w.paddleHalf = (edge.length * PADDLE_FRAC) / 2;
      w.isMe = false;
      w.bot = p.b === 1;
      this.wallSlots[rank] = w;
      rank++;
    }

    const nb = Math.min(s.bl.length, this.ballPool.length);
    this.ballList.length = nb;
    for (let i = 0; i < nb; i++) {
      const q = s.bl[i];
      const b = this.ballPool[i];
      if (!q || !b) continue;
      b.id = q.i;
      b.x = q.p[0];
      b.y = q.p[1];
      b.hot = q.h === 1;
      this.ballList[i] = b;
    }

    const nh = Math.min(s.hz.length, this.hazardPool.length);
    this.hazardList.length = nh;
    for (let i = 0; i < nh; i++) {
      const q = s.hz[i];
      const h = this.hazardPool[i];
      if (!q || !h) continue;
      h.kind = q.k === 'sun' ? 'sun' : 'blackhole';
      h.x = q.p[0];
      h.y = q.p[1];
      h.ownerColor = seatColor(q.o);
      this.hazardList[i] = h;
    }

    if (s.sp) {
      this.splitterScratch.x = s.sp[0];
      this.splitterScratch.y = s.sp[1];
      this.scene.splitter = this.splitterScratch;
    } else {
      this.scene.splitter = null;
    }

    this.scene.phase = s.ph;
    this.scene.timer = s.tm;
    this.scene.banner = typeof s.bn === 'string' ? s.bn : '';
    this.scene.round = s.rd;
    this.hasScene = true;
  }

  // ------------------------------------------------------------------ loop

  private readonly frame = (nowMs: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const now = nowMs / 1000;
    let dt = this.lastFrame === 0 ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.25) dt = 0.25; // a backgrounded tab must not fast-forward

    try {
      // A projector plugged into a Retina laptop changes devicePixelRatio
      // WITHOUT changing the element's CSS size, so ResizeObserver never
      // fires and the backing store would stay at the old scale — the arena
      // draws at half or double size for the rest of the lesson. A property
      // read, no layout, no allocation.
      if (Math.min(2, window.devicePixelRatio || 1) !== this.vp.dpr) {
        this.resizeDirty = true;
      }
      this.applyResize();
      this.draw(now, dt);
      this.frameErrors = 0;
    } catch (err) {
      this.frameErrors++;
      if (this.frameErrors === 1) console.warn('arena frame failed', err);
      if (this.frameErrors > 40) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.onFatal('The arena view stopped drawing. The rest of the console still works.');
      }
    }
  };

  private applyResize(): void {
    if (!this.resizeDirty) return;
    this.resizeDirty = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.pendingW));
    const h = Math.max(1, Math.round(this.pendingH));
    if (w === this.vp.w && h === this.vp.h && dpr === this.vp.dpr) return;
    this.vp.w = w;
    this.vp.h = h;
    this.vp.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private draw(now: number, dt: number): void {
    const s = this.stream.advance(dt);
    if (s) this.assemble(s);

    if (!this.hasScene) {
      const ctx = this.ctx;
      ctx.setTransform(this.vp.dpr, 0, 0, this.vp.dpr, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.vp.w, this.vp.h);
      return;
    }

    this.camera.update(this.scene.arena, this.vp as Viewport, dt);
    render(this.ctx, this.scene, this.camera, now, dt);
  }
}

function findBall(list: Snapshot['bl'], id: number): Snapshot['bl'][number] | null {
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b && b.i === id) return b;
  }
  return null;
}

/** Everything the roster reads out of a snapshot, in one comparable string.
 *  Built once per snapshot (30 Hz), never in the render path. */
function vitalsKey(snap: Snapshot): string {
  let key = '';
  for (let i = 0; i < snap.pl.length; i++) {
    const p = snap.pl[i];
    if (!p) continue;
    key += `${p.i}.${p.l}.${p.a}.${p.b}|`;
  }
  return key;
}
