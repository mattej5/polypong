// Builds the renderer's `Scene` from one interpolated snapshot.
//
// PERFORMANCE (SPEC C2). This runs once per frame at 60fps on the oldest
// Chromebook in the room, so it ALLOCATES NOTHING after construction: every
// WallView, BallView, HazardView and the Scene itself are pooled objects that
// are overwritten in place, the arenas for 2..8 players are built once and
// cached, and the variable-length lists are the same arrays with their
// `.length` moved rather than fresh ones from `.map`.
//
// THE RANK SUBTLETY, which is the whole reason this file exists. `Edge.owner`
// is a rank in the ring of LIVING players, not a seat index. The arena is
// `buildArena(aliveCount)` and goal edge k belongs to the k-th living player
// in seat order (game.ts `rebuildArena`). So a seat's wall MOVES every time
// somebody is eliminated: seat 5 defends edge 5 at eight players and edge 2 at
// three. Recomputing that mapping from the snapshot's alive set every frame —
// rather than caching it against a seat — is what keeps the camera pointed at
// the viewer's actual wall after an elimination.

import { COLORS, MAX_SEATS, T } from '../../shared/config';
import { buildArena, type Arena, type Edge } from '../../shared/geometry';
import type { Snapshot } from '../../shared/protocol';
import type { Viewport, XY } from '../view/camera';
import type { BallView, Effects, HazardView, Scene, SelfView, WallView } from '../view/render';

/** Paddle length as a fraction of its edge, exactly as `Paddle.attach` derives it. */
export const PADDLE_FRAC = Math.max(T.paddleFracMin, T.paddleFrac);

/** Travel limits for the wire's paddle fraction, for `PaddlePredictor`. */
export const PADDLE_MIN_FRAC = PADDLE_FRAC / 2;
export const PADDLE_MAX_FRAC = 1 - PADDLE_FRAC / 2;

/** A spectator has no seat hue. Same dim blue-grey the HUD uses. */
export const NEUTRAL = 'hsl(216, 34%, 74%)';

export const seatColor = (seat: number): string =>
  COLORS[((seat % COLORS.length) + COLORS.length) % COLORS.length] ?? NEUTRAL;

// One arena per player count, built on first use and then shared. `buildArena`
// allocates a dozen objects; doing it per frame would be the single largest
// source of garbage on the page.
const arenaCache: (Arena | null)[] = new Array<Arena | null>(MAX_SEATS + 1).fill(null);

export function arenaFor(n: number): Arena {
  const k = n < 2 ? 2 : n > MAX_SEATS ? MAX_SEATS : Math.floor(n);
  const hit = arenaCache[k];
  if (hit) return hit;
  const built = buildArena(k);
  arenaCache[k] = built;
  return built;
}

export interface BuildInput {
  snap: Snapshot;
  /** The viewer's seat, or null for a spectator. */
  mySeat: number | null;
  myName: string;
  maxLives: number;
  viewport: Viewport;
  effects: Effects;
}

export class SceneBuilder {
  /** The viewer's own wall this frame, or null (dead, or a spectator). */
  myEdge: Edge | null = null;
  myWall: WallView | null = null;
  /** How many living players the arena was built for this frame. */
  aliveCount = 0;

  /**
   * Last known wall midpoint per seat, in arena units. Kept because the
   * interesting moment for an effect — an elimination — is the exact moment
   * the wall stops existing, and firing the burst at the arena centre instead
   * would put the sparks nowhere near the thing that happened.
   */
  readonly wallMid = new Float32Array(MAX_SEATS * 2);

  private readonly wallPool: WallView[] = [];
  private readonly walls: (WallView | null)[] = new Array<WallView | null>(MAX_SEATS).fill(null);
  private readonly ballPool: BallView[] = [];
  private readonly balls: BallView[] = [];
  private readonly hazardPool: HazardView[] = [];
  private readonly hazards: HazardView[] = [];
  private readonly splitterPt: XY = { x: 0, y: 0 };
  private readonly me: SelfView = { name: '', color: NEUTRAL, lives: 0, maxLives: 3, seat: null };
  private readonly out: Scene;

  constructor() {
    for (let i = 0; i < MAX_SEATS; i++) {
      this.wallPool.push({
        rank: i, seat: i, name: '', color: NEUTRAL, lives: 0, maxLives: 3,
        paddle: 0.5, paddleHalf: 0.1, isMe: false, bot: false,
      });
      this.hazardPool.push({ kind: 'blackhole', x: 0, y: 0, ownerColor: NEUTRAL });
    }
    for (let i = 0; i < T.maxBalls; i++) this.ballPool.push({ id: -1, x: 0, y: 0, hot: false });

    this.out = {
      arena: arenaFor(2),
      phase: 'lobby',
      timer: 0,
      banner: '',
      round: 0,
      walls: this.walls,
      balls: this.balls,
      hazards: this.hazards,
      splitter: null,
      me: this.me,
      myEdge: null,
      effects: undefined as unknown as Effects, // set on every build
      viewport: { w: 1, h: 1, dpr: 1 },
    };
  }

  build(input: BuildInput): Scene {
    const { snap, mySeat, maxLives } = input;
    const pl = snap.pl;

    let alive = 0;
    for (let i = 0; i < pl.length; i++) if (pl[i]!.a === 1) alive++;
    this.aliveCount = alive;

    const arena = arenaFor(alive);
    const goals = arena.goalEdges;

    this.myEdge = null;
    this.myWall = null;

    let rank = 0;
    for (let i = 0; i < pl.length && rank < MAX_SEATS; i++) {
      const p = pl[i]!;
      if (p.a !== 1) continue;
      const edge = goals[rank];
      // More living players than the arena has walls cannot happen — the
      // arena is a function of that same count — but a snapshot is wire data
      // and a missing edge must drop the wall, not throw in the frame path.
      if (!edge) break;

      const w = this.wallPool[rank]!;
      w.rank = rank;
      w.seat = p.i;
      w.name = p.n;
      w.color = seatColor(p.i);
      w.lives = p.l;
      w.maxLives = Math.max(maxLives, p.l);
      w.paddle = p.s < 0 ? 0 : p.s > 1 ? 1 : p.s;
      w.paddleHalf = (edge.length * PADDLE_FRAC) / 2;
      w.isMe = mySeat !== null && p.i === mySeat;
      w.bot = p.b === 1;
      this.walls[rank] = w;

      if (p.i >= 0 && p.i < MAX_SEATS) {
        this.wallMid[p.i * 2] = edge.mid.x;
        this.wallMid[p.i * 2 + 1] = edge.mid.y;
      }
      if (w.isMe) {
        this.myEdge = edge;
        this.myWall = w;
      }
      rank++;
    }
    for (let r = rank; r < MAX_SEATS; r++) this.walls[r] = null;

    // Balls. Capped at the pool, which is T.maxBalls — the same cap the
    // server enforces, so the clamp is a guard and never a visible loss.
    const bn = Math.min(snap.bl.length, this.ballPool.length);
    for (let i = 0; i < bn; i++) {
      const q = snap.bl[i]!;
      const b = this.ballPool[i]!;
      b.id = q.i;
      b.x = q.p[0];
      b.y = q.p[1];
      b.hot = q.h === 1;
      this.balls[i] = b;
    }
    this.balls.length = bn;

    const hn = Math.min(snap.hz.length, this.hazardPool.length);
    for (let i = 0; i < hn; i++) {
      const q = snap.hz[i]!;
      const h = this.hazardPool[i]!;
      h.kind = q.k;
      h.x = q.p[0];
      h.y = q.p[1];
      h.ownerColor = seatColor(q.o);
      this.hazards[i] = h;
    }
    this.hazards.length = hn;

    if (snap.sp) {
      this.splitterPt.x = snap.sp[0];
      this.splitterPt.y = snap.sp[1];
      this.out.splitter = this.splitterPt;
    } else {
      this.out.splitter = null;
    }

    const mine = mySeat === null ? undefined : pl[mySeat];
    this.me.name = input.myName;
    this.me.seat = mySeat;
    this.me.color = mySeat === null ? NEUTRAL : seatColor(mySeat);
    this.me.lives = mine ? mine.l : 0;
    this.me.maxLives = Math.max(maxLives, this.me.lives);

    this.out.arena = arena;
    this.out.phase = snap.ph;
    this.out.timer = snap.tm;
    this.out.banner = snap.bn;
    this.out.round = snap.rd;
    this.out.me = this.me;
    this.out.myEdge = this.myEdge;
    this.out.effects = input.effects;
    this.out.viewport = input.viewport;
    return this.out;
  }
}
