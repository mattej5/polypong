// The frame renderer. Vector-CRT, additive glow, pure black interior.
//
// Two rules carried across from the previous build, both still load-bearing:
//
//   1. Glow is additive, never blurred. See the header of `beam.ts` for why
//      canvas shadow blur and canvas gradients are banned outright, with no
//      exception anywhere in this lane (SPEC C2, §9).
//   2. The arena interior is pure black. Every pixel that is not black is a
//      thing you can hit, own, or die to. Nothing decorative is ever lit.
//
// New in this build, and the reason this file is longer than the old one: the
// READABILITY LAYER (SPEC §9). Colour is never the only channel. Every wall
// carries its owner's name in mono type and their lives as discrete pips, the
// viewer's own wall carries a bright inner underline, and the banner speaks
// plain classroom English. A colour-blind student, or one three rows back from
// a projector, can still tell whose wall is whose.
//
// PERFORMANCE. The budget is 60fps at 8 players / 7 balls / 4 hazards /
// particles on the oldest Chromebook in the room, so the per-frame path
// allocates NOTHING: no `{x, y}` literals, no `.map`/`.filter`, no gradients,
// no offscreen canvases, and `save`/`restore` only for the one hazard clip
// that genuinely needs it. Scratch objects and typed arrays are module-level
// and reused.

import type { Arena, Edge } from '../../shared/geometry';
import type { Phase } from '../../shared/protocol';
import { T } from '../../shared/config';
import type { Camera, Viewport, XY } from './camera';
import {
  beamDot,
  beamLine,
  beamPolyline,
  beamRing,
  beamStroke,
  beamText,
  monoFont,
  polygonPath,
  resetFontCache,
} from './beam';
import { drawHud } from './hud';

const TAU = Math.PI * 2;
const BG = '#000000';

/** Deliberately dull: the 2-player court's solid walls must not read as a
 *  player. Desaturated blue-grey, well outside every seat hue. (SPEC §5.1) */
const DEAD_WALL = 'hsl(222, 18%, 62%)';
const BALL_COLD = 'hsl(196, 86%, 62%)';
const BALL_HOT = 'hsl(24, 96%, 60%)';
const SPLIT = 'hsl(162, 86%, 62%)';
const HZ_COLOR = { blackhole: 'hsl(276, 86%, 62%)', sun: 'hsl(34, 92%, 60%)' } as const;
const HUD_DIM = 'hsl(216, 34%, 74%)';
const SUN_CORE = 'hsl(38, 100%, 66%)';

/** Where a wall label sits, in arena units OUTSIDE its wall. Must stay under
 *  `camera.pad`, which is what reserves the room for it in the fit. */
const LABEL_OUT = 0.09;

// ------------------------------------------------------------------- scene
// What the renderer needs, and nothing else. The netcode lane builds this from
// a `Snapshot` plus roster names and the viewer's own seat; the two page lanes
// pass it straight through. Deliberately flat and already resolved — the
// renderer does no lookups, no name joins, and no colour decisions.

export interface WallView {
  /** Arena rank. Equals `Edge.owner`, which indexes LIVING players, not seats. */
  rank: number;
  /** Seat index 0..7. Carried for the caller's benefit; unused when drawing. */
  seat: number;
  name: string;
  color: string;
  lives: number;
  /** Lives at full health, so the empty pips can be drawn. */
  maxLives: number;
  /** Paddle centre as a fraction 0..1 from `edge.a` to `edge.b`. */
  paddle: number;
  /** Paddle half-length in ARENA UNITS (not a fraction). */
  paddleHalf: number;
  /** The viewer's own wall. Gets the bright inner underline. */
  isMe: boolean;
  bot: boolean;
}

export interface BallView {
  /** Stable id, matched across snapshots. Trails are keyed on it. */
  id: number;
  x: number;
  y: number;
  hot: boolean;
}

export interface HazardView {
  kind: 'blackhole' | 'sun';
  x: number;
  y: number;
  /** Seat colour of the player whose elimination spawned it (SnapHazard.o). */
  ownerColor: string;
}

/** The viewer, whether or not they hold a wall. Spectators have seat null. */
export interface SelfView {
  name: string;
  color: string;
  lives: number;
  maxLives: number;
  seat: number | null;
}

export interface Scene {
  arena: Arena;
  phase: Phase;
  /** Seconds remaining on the current phase timer. */
  timer: number;
  /** Already in plain classroom English, from the server. */
  banner: string;
  round: number;
  /** Indexed by arena rank. A hole is a rank with no live owner. */
  walls: readonly (WallView | null)[];
  balls: readonly BallView[];
  hazards: readonly HazardView[];
  splitter: XY | null;
  me: SelfView | null;
  /** The viewer's own edge, or null for the teacher and spectators. */
  myEdge: Edge | null;
  effects: Effects;
  viewport: Viewport;
}

// ----------------------------------------------------------------- effects
// Particles and screen shake are purely presentational, so the renderer owns
// them rather than the netcode: the server never sends a particle. The play
// lane calls `emit`/`bump` on the events it already receives.

const MAX_PARTICLES = 240;

export class Effects {
  /** 0..1. Decays on its own; `bump` raises it. */
  shake = 0;

  private n = 0;
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly col: string[] = new Array<string>(MAX_PARTICLES).fill('#ffffff');

  bump(mag: number): void {
    if (mag > this.shake) this.shake = mag;
  }

  /** Positions and speeds are in arena units. */
  emit(x: number, y: number, color: string, count: number, speed = 0.45): void {
    for (let i = 0; i < count; i++) {
      // The pool is a hard cap, not a queue: past it the burst is simply
      // smaller. Dropping particles is always cheaper than dropping frames.
      if (this.n >= MAX_PARTICLES) return;
      const a = Math.random() * TAU;
      const s = speed * (0.35 + Math.random() * 0.65);
      const k = this.n++;
      this.px[k] = x;
      this.py[k] = y;
      this.vx[k] = Math.cos(a) * s;
      this.vy[k] = Math.sin(a) * s;
      const l = 0.35 + Math.random() * 0.45;
      this.life[k] = l;
      this.maxLife[k] = l;
      this.col[k] = color;
    }
  }

  clear(): void {
    this.n = 0;
    this.shake = 0;
  }

  update(dt: number): void {
    this.shake = this.shake > 0 ? Math.max(0, this.shake - dt * 3.2) : 0;
    const drag = Math.max(0, 1 - dt * 2.4);
    for (let i = 0; i < this.n; ) {
      const l = this.life[i]! - dt;
      if (l <= 0) {
        // Swap-remove keeps the live particles packed at the front, so the
        // draw loop is a straight walk with no liveness test per particle.
        const last = --this.n;
        this.px[i] = this.px[last]!;
        this.py[i] = this.py[last]!;
        this.vx[i] = this.vx[last]!;
        this.vy[i] = this.vy[last]!;
        this.life[i] = this.life[last]!;
        this.maxLife[i] = this.maxLife[last]!;
        this.col[i] = this.col[last]!;
        continue;
      }
      this.life[i] = l;
      this.px[i] = this.px[i]! + this.vx[i]! * dt;
      this.py[i] = this.py[i]! + this.vy[i]! * dt;
      this.vx[i] = this.vx[i]! * drag;
      this.vy[i] = this.vy[i]! * drag;
      i++;
    }
  }

  /** Plain arcs, no halo. There can be 240 of them; the halo is not worth it. */
  draw(ctx: CanvasRenderingContext2D, r: number): void {
    for (let i = 0; i < this.n; i++) {
      ctx.globalAlpha = (this.life[i]! / this.maxLife[i]!) * 0.9;
      ctx.fillStyle = this.col[i]!;
      ctx.beginPath();
      ctx.arc(this.px[i]!, this.py[i]!, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ trails
// Ball tails are a render-side memory of where a ball has been, keyed by the
// ball's STABLE ID and never by array index — a split or a goal reorders the
// snapshot array, and a trail matched by index sends one tail skating across
// the arena (SPEC §10.2, same reason interpolation matches by id).

const TRAIL_N = 14;
const TRAIL_SLOTS = T.maxBalls;

class Trails {
  private readonly id = new Int32Array(TRAIL_SLOTS).fill(-1);
  private readonly len = new Int32Array(TRAIL_SLOTS);
  private readonly head = new Int32Array(TRAIL_SLOTS);
  private readonly seen = new Uint8Array(TRAIL_SLOTS);
  private readonly buf = new Float32Array(TRAIL_SLOTS * TRAIL_N * 2);
  /** Oldest-to-newest scratch, refilled per ball. Never reallocated. */
  readonly out = new Float32Array(TRAIL_N * 2);

  beginFrame(): void {
    this.seen.fill(0);
  }

  /** Drops any slot whose ball was not in this frame's scene. */
  endFrame(): void {
    for (let s = 0; s < TRAIL_SLOTS; s++) {
      if (this.seen[s] === 0 && this.id[s] !== -1) {
        this.id[s] = -1;
        this.len[s] = 0;
        this.head[s] = 0;
      }
    }
  }

  reset(): void {
    this.id.fill(-1);
    this.len.fill(0);
    this.head.fill(0);
  }

  /** Records `(x, y)` for ball `id` and returns how many points are available. */
  push(id: number, x: number, y: number): number {
    let s = -1;
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      if (this.id[i] === id) {
        s = i;
        break;
      }
    }
    if (s === -1) {
      for (let i = 0; i < TRAIL_SLOTS; i++) {
        if (this.id[i] === -1) {
          s = i;
          break;
        }
      }
      if (s === -1) return 0;
      this.id[s] = id;
      this.len[s] = 0;
      this.head[s] = 0;
    }
    this.seen[s] = 1;
    const base = s * TRAIL_N * 2;
    const h = this.head[s]!;
    this.buf[base + h * 2] = x;
    this.buf[base + h * 2 + 1] = y;
    this.head[s] = (h + 1) % TRAIL_N;
    if (this.len[s]! < TRAIL_N) this.len[s] = this.len[s]! + 1;

    // Unroll the ring into `out`, oldest first, so the draw is one moveTo plus
    // a straight run of lineTo with no modular arithmetic per segment.
    const n = this.len[s]!;
    const start = (this.head[s]! - n + TRAIL_N) % TRAIL_N;
    for (let i = 0; i < n; i++) {
      const k = base + ((start + i) % TRAIL_N) * 2;
      this.out[i * 2] = this.buf[k]!;
      this.out[i * 2 + 1] = this.buf[k + 1]!;
    }
    return n;
  }
}

// ---------------------------------------------------------------- scratch

const trails = new Trails();
const xf: Float64Array = new Float64Array(6);
const sp: XY = { x: 0, y: 0 };
/** Serve-point crosshair, rebuilt per frame into a fixed buffer. */
let lastArenaN = -1;

/** Call when the match restarts, so a new round does not inherit old tails. */
export function resetRenderState(): void {
  trails.reset();
  lastArenaN = -1;
}

// ----------------------------------------------------------------- render

export function render(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
  time: number,
  dt: number,
): void {
  const vp = scene.viewport;
  const dpr = vp.dpr;

  // The arena changed shape: the tails describe a court that no longer exists.
  if (scene.arena.n !== lastArenaN) {
    trails.reset();
    lastArenaN = scene.arena.n;
  }

  scene.effects.update(dt);
  resetFontCache();

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, vp.w, vp.h);

  camera.writeTransform(xf);

  // Screen shake is a translation of the world transform, not a save/translate
  // pair: the HUD must NOT shake, and folding it into the matrix costs nothing.
  const shake = scene.effects.shake;
  let shx = 0;
  let shy = 0;
  if (shake > 0) {
    const amp = shake * camera.scale * 0.02;
    shx = (Math.random() - 0.5) * amp;
    shy = (Math.random() - 0.5) * amp;
  }

  ctx.setTransform(
    dpr * xf[0]!,
    dpr * xf[1]!,
    dpr * xf[2]!,
    dpr * xf[3]!,
    dpr * (xf[4]! + shx),
    dpr * (xf[5]! + shy),
  );
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  // One CSS pixel, expressed in arena units. Every "at least N pixels wide"
  // clamp below is written through this, because line widths are in user space
  // and the world transform scales them.
  const px = 1 / camera.scale;

  drawWalls(ctx, scene, px);
  drawCenterMark(ctx, time, px);

  if (scene.hazards.length > 0) {
    // Fields are CLIPPED to the arena interior. A field bleeding through a
    // wall reads as reach the ball does not actually have, and students play
    // to what they can see.
    ctx.save();
    polygonPath(ctx, scene.arena.verts);
    ctx.clip();
    for (let i = 0; i < scene.hazards.length; i++) {
      drawHazard(ctx, scene.hazards[i]!, time, px);
    }
    ctx.restore();
  }

  if (scene.splitter) drawSplitter(ctx, scene.splitter, time, px);

  trails.beginFrame();
  for (let i = 0; i < scene.balls.length; i++) drawBall(ctx, scene.balls[i]!);
  trails.endFrame();

  drawPaddles(ctx, scene, time, px);
  scene.effects.draw(ctx, 0.005);

  // --- readability layer, in SCREEN space -------------------------------
  // Wall labels must read right-way-up in the VIEWER'S frame, and the viewer's
  // frame is the screen. Drawing them under the world transform would need a
  // counter-rotation of -angle around every anchor: eight rotate/restore pairs
  // and eight glyph runs rasterised at an arbitrary angle. Mapping only the
  // ANCHOR through `camera.arenaToScreen` and then drawing horizontally is the
  // same counter-rotation applied once, in closed form, and it is upright at
  // every seat and every arena size by construction rather than by luck.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawWallLabels(ctx, scene, camera);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  drawHud(ctx, scene);
}

// ------------------------------------------------------------------ arena

function drawWalls(ctx: CanvasRenderingContext2D, scene: Scene, px: number): void {
  const edges = scene.arena.edges;
  const liveW = Math.max(1.5 * px, T.wallWidth);
  const deadW = Math.max(2 * px, T.deadWallWidth);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.owner === null) {
      beamLine(ctx, e.a.x, e.a.y, e.b.x, e.b.y, DEAD_WALL, deadW, 0.36, 2);
      continue;
    }
    const w = scene.walls[e.owner];
    if (!w) continue;
    beamLine(ctx, e.a.x, e.a.y, e.b.x, e.b.y, w.color, liveW, 0.32, 1);

    if (w.isMe) {
      // Readability layer: the viewer's own wall gets a bright inner underline
      // so they find themselves instantly, without reading a name or matching
      // a hue. It is INSIDE the wall — the only line on screen behind the
      // player's own paddle — and it is the brightest wall on the board.
      const o = T.wallWidth * 5;
      beamLine(
        ctx,
        e.a.x + e.n.x * o,
        e.a.y + e.n.y * o,
        e.b.x + e.n.x * o,
        e.b.y + e.n.y * o,
        w.color,
        Math.max(2 * px, T.wallWidth * 1.6),
        0.9,
        3,
      );
    }
  }
}

/**
 * Serve point. A crosshair, not a ring: circles are the language of hazard
 * fields here, and a dim ring in the middle of the arena reads as one more
 * field the ball is about to be pulled into.
 */
function drawCenterMark(ctx: CanvasRenderingContext2D, time: number, px: number): void {
  const i0 = 0.045;
  const i1 = 0.1;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    ctx.moveTo(cs * i0, sn * i0);
    ctx.lineTo(cs * i1, sn * i1);
  }
  beamStroke(ctx, HUD_DIM, Math.max(px, 0.003), 0.3 + 0.1 * Math.sin(time * 1.7), 2);
}

function drawPaddles(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  time: number,
  px: number,
): void {
  const edges = scene.arena.edges;
  const width = Math.max(4 * px, T.paddleWidth);

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.owner === null) continue;
    const w = scene.walls[e.owner];
    if (!w) continue;

    const t = w.paddle;
    const cx = e.a.x + (e.b.x - e.a.x) * t;
    const cy = e.a.y + (e.b.y - e.a.y) * t;
    const half = w.paddleHalf;
    const ox = e.n.x * 0.008;
    const oy = e.n.y * 0.008;
    const ax = cx - e.dir.x * half + ox;
    const ay = cy - e.dir.y * half + oy;
    const bx = cx + e.dir.x * half + ox;
    const by = cy + e.dir.y * half + oy;

    const pulse = 0.86 + 0.14 * Math.sin(time * 3 + w.rank);
    beamLine(ctx, ax, ay, bx, by, w.color, width, pulse);
    // Hot filament. White additive over the hue keeps the core bright without
    // washing the halo out, so the seat colour still reads from the back row.
    beamLine(ctx, ax, ay, bx, by, '#ffffff', width * 0.3, 0.34, 1);
  }
}

// ---------------------------------------------------------------- hazards
// Force falls off linearly to zero at exactly `T.hazardRadius`, so these rings
// are not decoration: the outer one is the edge of the field and the inner
// ones sit at 75 / 50 / 25 percent of full pull.

const RING_F = [1.0, 0.75, 0.5, 0.25] as const;
const RING_A = [0.6, 0.16, 0.24, 0.4] as const;

function drawHazard(
  ctx: CanvasRenderingContext2D,
  hz: HazardView,
  time: number,
  px: number,
): void {
  const r = T.hazardRadius;
  const color = HZ_COLOR[hz.kind];
  const thin = Math.max(px, r * 0.006);

  // The strength rings are in the hazard's KIND colour, because what the field
  // does to the ball matters more than whose elimination made it. The boundary
  // ring below carries the owner's seat colour instead, which is the only
  // place provenance is worth a channel.
  for (let i = 0; i < RING_F.length; i++) {
    beamRing(ctx, hz.x, hz.y, r * RING_F[i]!, color, thin, RING_A[i]!, i === 0 ? 3 : 2);
  }
  beamRing(ctx, hz.x, hz.y, r * 0.985, hz.ownerColor, thin, 0.45, 2);

  // Static ticks on the boundary. They do not rotate: the edge of the field is
  // a fixed fact about the arena, and only the core is allowed to look alive.
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i * TAU) / 12;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    ctx.moveTo(hz.x + cs * r * 0.93, hz.y + sn * r * 0.93);
    ctx.lineTo(hz.x + cs * r, hz.y + sn * r);
  }
  beamStroke(ctx, color, thin * 1.4, 0.5, 2);

  if (hz.kind === 'blackhole') {
    for (let i = 0; i < 2; i++) {
      const rr = r * (0.22 + i * 0.1);
      ctx.beginPath();
      ctx.ellipse(hz.x, hz.y, rr, rr * 0.4, time * (1.6 + i * 0.7), 0, TAU);
      beamStroke(ctx, color, thin, 0.45 - i * 0.12, 2);
    }
    // The only genuinely black thing inside an additive frame, so it has to
    // leave 'lighter' for exactly one fill. Its rim stays in the hazard hue
    // rather than white: a white disc here reads as a ball.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.beginPath();
    ctx.arc(hz.x, hz.y, r * 0.13, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    beamRing(ctx, hz.x, hz.y, r * 0.13, color, thin * 1.6, 0.95);
  } else {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = time * 0.6 + (i * TAU) / 10;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      const r0 = r * (0.15 + 0.02 * Math.sin(time * 4 + i));
      const r1 = r * (0.26 + 0.05 * Math.sin(time * 3 + i * 2));
      ctx.moveTo(hz.x + cs * r0, hz.y + sn * r0);
      ctx.lineTo(hz.x + cs * r1, hz.y + sn * r1);
    }
    beamStroke(ctx, color, thin, 0.7, 2);
    // Warm, not white, for the same reason the black hole's rim is not white.
    beamDot(ctx, hz.x, hz.y, r * 0.075, SUN_CORE, 1);
  }
}

// ------------------------------------------------------------- ball, bits

function drawBall(ctx: CanvasRenderingContext2D, b: BallView): void {
  const glow = b.hot ? BALL_HOT : BALL_COLD;
  const r = T.ballRadius;
  const n = trails.push(b.id, b.x, b.y);

  if (n > 2) {
    // A thin vector line, not a chain of soft blobs. Two passes: the whole tail
    // faint, then the recent third brighter, which gives the taper for the cost
    // of four strokes total.
    beamPolyline(ctx, trails.out, 0, n, false, glow, r * 0.55, 0.3, 2);
    const cut = Math.max(0, n - Math.ceil(n / 3));
    beamPolyline(ctx, trails.out, cut, n - cut, false, glow, r * 0.75, 0.55, 2);
  }

  beamDot(ctx, b.x, b.y, r, glow, b.hot ? 1 : 0.85);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 0.62, 0, TAU);
  ctx.fill();
}

function drawSplitter(
  ctx: CanvasRenderingContext2D,
  s: XY,
  time: number,
  px: number,
): void {
  const r = T.ballRadius * 1.4;
  const pulse = 1 + 0.28 * Math.sin(time * 6);
  beamDot(ctx, s.x, s.y, r * pulse, SPLIT, 0.9);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = time * 2 + (i * TAU) / 3;
    ctx.moveTo(s.x + Math.cos(a) * r * 3.2, s.y + Math.sin(a) * r * 3.2);
    ctx.arc(s.x, s.y, r * 3.2, a, a + 0.9);
  }
  beamStroke(ctx, SPLIT, Math.max(1.5 * px, r * 0.5), 0.8, 2);
}

// -------------------------------------------------- readability: labels

function drawWallLabels(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  camera: Camera,
): void {
  const edges = scene.arena.edges;
  const size = Math.min(26, Math.max(10, camera.scale * 0.045));
  const font = monoFont(700, size);
  const botFont = monoFont(500, size * 0.6);
  const pipR = size * 0.2;
  const gap = pipR * 2.9;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.owner === null) continue;
    const w = scene.walls[e.owner];
    if (!w) continue;

    // `e.n` points inward, so stepping along -n puts the label just outside
    // its own wall, where it cannot be crossed by the ball or hidden by the
    // paddle. `camera.pad` reserved the room for it in the fit.
    camera.arenaToScreen(e.mid.x - e.n.x * LABEL_OUT, e.mid.y - e.n.y * LABEL_OUT, sp);

    // The viewer's own label is drawn at full strength; everyone else's is
    // dimmer. That, the bright inner underline on the wall itself, and the HUD
    // strip repeating the same name at the bottom are three separate channels
    // saying "this one is you", none of which is colour.
    beamText(ctx, w.name, sp.x, sp.y - size * 0.55, font, w.color, w.isMe ? 1 : 0.85);

    // Lives as discrete PIPS, never a bar and never a colour: countable at a
    // glance from the back of a classroom, and legible to a student who cannot
    // separate two seat hues (SPEC §9).
    drawPips(ctx, sp.x, sp.y + size * 0.55, pipR, gap, w.lives, w.maxLives, w.color);

    if (w.bot) {
      beamText(
        ctx,
        'BOT',
        sp.x,
        sp.y + size * 0.55 + pipR * 3.4,
        botFont,
        HUD_DIM,
        0.5,
        false,
      );
    }
  }
}

export function drawPips(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  gap: number,
  lives: number,
  maxLives: number,
  color: string,
): void {
  const x0 = cx - ((maxLives - 1) * gap) / 2;
  for (let i = 0; i < maxLives; i++) {
    const x = x0 + i * gap;
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, TAU);
    if (i < lives) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      // A spent life is an empty ring, not a missing one: the row keeps its
      // width, so "2 of 3" is readable without counting the gaps.
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
