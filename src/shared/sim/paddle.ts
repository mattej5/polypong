// A paddle is one number: how far along its own edge the centre sits.
//
// Storing the position as an arc-length `s` rather than a point means the
// arena can be rebuilt underneath a player — a smaller polygon, a different
// edge, a different orientation — and the paddle keeps a meaningful position
// without any of the callers doing trigonometry. `attach` is the only thing
// that needs to know the edge changed.

import { add, clamp, mul, type Edge, type Vec } from '../geometry';
import { T } from '../config';

export class Paddle {
  /** Half the paddle's length, in arena units along the edge. */
  half = 0;
  /** Travel limits for `s`, so the paddle never hangs off its own wall. */
  min = 0;
  max = 0;
  /** Centre, as arc length from `edge.a` toward `edge.b`. */
  s = 0;
  /** Arena units per second along the edge. Feeds the spin transfer. */
  vel = 0;

  constructor(edge: Edge) {
    this.attach(edge);
  }

  /**
   * Bind to a (possibly new) edge and recentre. Callers that want to preserve
   * the player's relative position across an arena rebuild re-set `s`
   * afterwards from the fraction they saved; doing it here would need this
   * class to remember an edge it no longer owns.
   */
  attach(edge: Edge): void {
    const frac = Math.max(T.paddleFracMin, T.paddleFrac);
    this.half = (edge.length * frac) / 2;
    this.min = this.half;
    this.max = edge.length - this.half;
    this.s = edge.length / 2;
    this.vel = 0;
  }

  /**
   * `dir` is already in ARENA sense: +1 means "toward edge.b". The screen-frame
   * conversion (Edge.rightSign) happens exactly once, in Game. A paddle has no
   * idea a screen exists.
   *
   * `vel` is measured from the actual clamped movement, not from `dir`, so a
   * paddle pinned against the end of its wall imparts no spin. Holding a key
   * into the corner used to be a free curve in an early build.
   */
  update(edge: Edge, dir: number, dt: number, speedMul = 1): void {
    const before = this.s;
    this.s = clamp(
      this.s + dir * edge.length * T.paddleSpeed * speedMul * dt,
      this.min,
      this.max,
    );
    this.vel = dt > 0 ? (this.s - before) / dt : 0;
  }

  center(edge: Edge): Vec {
    return add(edge.a, mul(edge.dir, this.s));
  }

  /** Position along the wall as a fraction 0..1. This is what goes on the wire. */
  fraction(edge: Edge): number {
    return edge.length > 0 ? this.s / edge.length : 0.5;
  }
}
