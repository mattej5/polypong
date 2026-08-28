// The rotation-and-fit transform. SPEC §5.2, invariant I6.
//
// This module is deliberately pure maths over numbers. It never touches a
// canvas and never touches the DOM, which is the only reason I6 can be tested
// headlessly: `test/view.test.ts` runs the real transform, not a re-derivation
// of it, and a sign error here fails a test rather than shipping to a class of
// students staring at an upside-down court.
//
// The whole module works in CSS pixels. Device pixel ratio is applied once, by
// the renderer, when it hands the matrix to `setTransform`. Mixing dpr in here
// would mean every hit-test and label position needed to know about it too.

import type { Arena, Edge } from '../../shared/geometry';
import { viewRotation } from '../../shared/geometry';

/** Mutable point. `geometry.Vec` is readonly, and every hot path here writes
 *  into a caller-owned scratch object rather than allocating a new one. */
export interface XY {
  x: number;
  y: number;
}

export interface Viewport {
  /** CSS pixels. */
  readonly w: number;
  readonly h: number;
  /** devicePixelRatio. Stored here for the renderer's convenience; the camera
   *  itself never reads it. */
  readonly dpr: number;
}

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** SPEC §5.2: the shape snaps, the angle eases, over this long. */
export const EASE_SEC = 0.25;

/**
 * Slack left around the polygon, in arena units, when fitting it to the
 * viewport. Wall labels are drawn just OUTSIDE their wall (§9 readability
 * layer), so the fit has to reserve room for them or the bottom player's own
 * name falls off the bottom of the screen. It is applied symmetrically so the
 * arena centre still lands in the middle of the fitted box.
 */
export const ARENA_PAD = 0.17;

const TAU = Math.PI * 2;

/** Wrap to (-pi, pi]. The one function that makes the easing sane. */
export function wrapPi(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/**
 * Shortest signed rotation from `from` to `to`.
 *
 * A naive `lerp(from, to)` between angles either side of the ±pi seam sweeps
 * the long way: easing 0.1 -> 6.18 rad spins the entire arena through half a
 * turn instead of nudging it 0.2 rad backwards through zero. On a projector
 * that is a curiosity; on thirty Chromebooks it is thirty dizzy children.
 */
export function shortestDelta(from: number, to: number): number {
  return wrapPi(to - from);
}

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Default letterbox margins. The bottom is deeper than the top because the HUD
 * strip (own name, colour, life pips — SPEC §8) lives there and the arena must
 * not draw underneath it.
 */
export function writeDefaultMargins(w: number, h: number, out: Margins): Margins {
  const s = Math.min(w, h);
  const pad = Math.max(6, s * 0.03);
  const hud = Math.min(72, Math.max(26, s * 0.085));
  out.top = pad;
  out.right = pad;
  out.bottom = pad + hud;
  out.left = pad;
  return out;
}

/** Allocating convenience wrapper. Not for the per-frame path. */
export function defaultMargins(w: number, h: number): Margins {
  return writeDefaultMargins(w, h, { top: 0, right: 0, bottom: 0, left: 0 });
}

export interface Fit {
  scale: number;
  ox: number;
  oy: number;
}

/**
 * Fits the arena, rotated by `angle`, into the viewport with a SINGLE UNIFORM
 * SCALE and letterboxes it.
 *
 * Uniform is not a simplification, it is the requirement: a non-uniform fit
 * would make the 2-player rectangle fill each player's screen, but it would
 * also make the ball's speed depend on its direction and make a circular
 * hazard field an ellipse. Each player therefore sees a tall court that is
 * SMALLER on screen than the teacher's horizontal one. SPEC §5.2 calls that
 * out explicitly as correct rather than a bug.
 *
 * Writes into `out` and returns it, so the per-frame path allocates nothing.
 */
export function computeFit(
  arena: Arena,
  angle: number,
  viewport: Viewport,
  margins: Margins,
  pad: number,
  out: Fit,
): Fit {
  const c = Math.cos(angle);
  const s = Math.sin(angle);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const verts = arena.verts;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i]!;
    const rx = p.x * c - p.y * s;
    const ry = p.x * s + p.y * c;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }

  minX -= pad;
  maxX += pad;
  minY -= pad;
  maxY += pad;

  const availW = Math.max(1, viewport.w - margins.left - margins.right);
  const availH = Math.max(1, viewport.h - margins.top - margins.bottom);
  const boxW = Math.max(1e-6, maxX - minX);
  const boxH = Math.max(1e-6, maxY - minY);

  const scale = Math.min(availW / boxW, availH / boxH);

  // Centre of the box maps to the centre of the available (letterboxed) area.
  const cx = margins.left + availW / 2;
  const cy = margins.top + availH / 2;
  out.scale = scale;
  out.ox = cx - scale * ((minX + maxX) / 2);
  out.oy = cy - scale * ((minY + maxY) / 2);
  return out;
}

/**
 * Holds the eased view angle and the current fit.
 *
 * Sign convention, because getting it backwards puts every player at the TOP
 * of their own screen and still looks plausible in a screenshot:
 *
 *   Canvas y grows DOWNWARD, so the bottom of the screen is the +y direction,
 *   i.e. the angle +pi/2. A wall midpoint sits at arena angle
 *   phi = atan2(mid.y, mid.x). Rotating the world by theta sends it to
 *   phi + theta, and we want that to be +pi/2, so theta = pi/2 - phi. That is
 *   exactly what `geometry.viewRotation` returns, and it is applied directly —
 *   `ctx.rotate(+theta)`, not `-theta`. (SPEC §5.2 writes the same rotation as
 *   `rotate(-θ)` with `θ = atan2(mid) - π/2`; same number, opposite naming.)
 */
export class Camera {
  /** Current eased rotation, radians. Unwrapped: may drift outside (-pi, pi]. */
  angle = 0;
  scale = 1;
  ox = 0;
  oy = 0;
  margins: Margins = { top: 0, right: 0, bottom: 0, left: 0 };
  pad = ARENA_PAD;

  private cs = 1;
  private sn = 0;
  private target = 0;
  /**
   * Seconds the target has held still. This exists because a target that
   * ALTERNATES every frame — the viewer's own wall flapping between two ranks
   * while the arena rebuilds — restarts the ease from the current angle each
   * time, which converges on the midpoint BETWEEN the two walls and stays
   * there. The arena then sits permanently askew with nobody at the bottom,
   * and nothing recovers it, because every frame it is handed a "new" target
   * and starts over. Measured: alternating two walls of a square parks the
   * camera 0.79 rad from both and never settles.
   *
   * So convergence is guaranteed rather than hoped for: once the target has
   * been still for a full ease, the angle IS the target, exactly.
   */
  private sinceTargetChange = Number.POSITIVE_INFINITY;
  private easeFrom = 0;
  private easeDelta = 0;
  private easeT = 1;
  private seeded = false;
  private readonly fit: Fit = { scale: 1, ox: 0, oy: 0 };

  /** True while the rotation is still easing. Useful to suppress prediction. */
  get easing(): boolean {
    return this.easeT < 1;
  }

  get targetAngle(): number {
    return this.target;
  }

  private setAngle(a: number): void {
    this.angle = a;
    this.cs = Math.cos(a);
    this.sn = Math.sin(a);
  }

  /** Jump straight to `a`, cancelling any ease. Used on the first frame. */
  snapAngle(a: number): void {
    this.target = a;
    this.easeFrom = a;
    this.easeDelta = 0;
    this.easeT = 1;
    this.seeded = true;
    this.setAngle(a);
  }

  /**
   * Aim at `a`. The first call snaps (there is nothing to ease from); every
   * later call eases over EASE_SEC along the short way round.
   */
  setTargetAngle(a: number): void {
    if (!this.seeded) {
      this.snapAngle(a);
      return;
    }
    // Same target as last frame: do not restart the ease. Callers push the
    // current edge every frame, so this is the common case.
    if (Math.abs(shortestDelta(this.target, a)) < 1e-9) return;
    this.sinceTargetChange = 0;
    this.target = a;
    this.easeFrom = this.angle;
    this.easeDelta = shortestDelta(this.angle, a);
    this.easeT = 0;
  }

  /** `null` = the teacher or a spectator: canonical unrotated orientation. */
  setViewEdge(edge: Edge | null): void {
    this.setTargetAngle(viewRotation(edge));
  }

  snapToEdge(edge: Edge | null): void {
    this.snapAngle(viewRotation(edge));
  }

  /** Advance the ease and recompute the fit. Call once per frame. */
  update(arena: Arena, viewport: Viewport, dt: number): void {
    this.sinceTargetChange += dt;
    if (this.easeT < 1) {
      this.easeT = Math.min(1, this.easeT + dt / EASE_SEC);
      this.setAngle(this.easeFrom + this.easeDelta * smoothstep(this.easeT));
    }
    // The guarantee. See `sinceTargetChange`.
    if (this.sinceTargetChange >= EASE_SEC && Math.abs(shortestDelta(this.angle, this.target)) > 1e-9) {
      this.setAngle(this.target);
      this.easeT = 1;
    }
    // Written in place: `update` runs 60 times a second and must not allocate.
    writeDefaultMargins(viewport.w, viewport.h, this.margins);
    computeFit(arena, this.angle, viewport, this.margins, this.pad, this.fit);
    this.scale = this.fit.scale;
    this.ox = this.fit.ox;
    this.oy = this.fit.oy;
  }

  arenaToScreen(x: number, y: number, out: XY): XY {
    out.x = this.ox + this.scale * (x * this.cs - y * this.sn);
    out.y = this.oy + this.scale * (x * this.sn + y * this.cs);
    return out;
  }

  /** Inverse of `arenaToScreen`. The teacher console may want to hit-test. */
  screenToArena(sx: number, sy: number, out: XY): XY {
    const dx = (sx - this.ox) / this.scale;
    const dy = (sy - this.oy) / this.scale;
    out.x = dx * this.cs + dy * this.sn;
    out.y = -dx * this.sn + dy * this.cs;
    return out;
  }

  /**
   * Canvas `setTransform` arguments [a, b, c, d, e, f], where
   * x' = a*x + c*y + e and y' = b*x + d*y + f. Written into `out` so the
   * renderer's per-frame path allocates nothing.
   */
  writeTransform(out: Float64Array | number[]): void {
    out[0] = this.scale * this.cs;
    out[1] = this.scale * this.sn;
    out[2] = -this.scale * this.sn;
    out[3] = this.scale * this.cs;
    out[4] = this.ox;
    out[5] = this.oy;
  }
}
