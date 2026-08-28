// Ball state. Everything here is in arena units: the arena centre is the
// origin and the circumradius is 1, so T.ballRadius IS the radius and
// T.ballSpeed IS the speed. No multiplication by an arena radius anywhere.

import { type Vec } from '../geometry';
import { T } from '../config';

/** How many past positions the CRT tail keeps. Purely visual. */
export const TRAIL_MAX = 14;

export interface Ball {
  /**
   * Stable identity, NOT the array index. A split inserts and a goal splices,
   * so index means nothing across two consecutive snapshots; a client that
   * interpolates by index blends two different balls together and sends one
   * skating across the arena. Ids are minted per Game instance, never from a
   * module-level counter, so two Games fed the same seed agree exactly.
   */
  readonly id: number;
  p: Vec;
  v: Vec;
  readonly r: number;
  /** Seconds of remaining heat. A hot ball costs T.hotCost lives, not 1. */
  hot: number;
  /**
   * hazard id -> seconds spent continuously inside that hazard's field.
   * Resets the moment the ball leaves. See hazards.applyFields — this is the
   * anti-orbit accumulator, and it is per-hazard because a ball threading two
   * overlapping fields is not orbiting either of them.
   */
  grip: Map<number, number>;
  /** Render-only. The sim never reads it. */
  trail: Vec[];
  /** Seat of the last paddle to touch it, or null off a fresh serve. */
  lastHit: number | null;
}

export function makeBall(id: number, at: Vec, angle: number, speed = T.ballSpeed): Ball {
  return {
    id,
    p: { x: at.x, y: at.y },
    v: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    r: T.ballRadius,
    hot: 0,
    grip: new Map(),
    trail: [],
    lastHit: null,
  };
}

export function pushTrail(b: Ball, limit = TRAIL_MAX): void {
  b.trail.push({ x: b.p.x, y: b.p.y });
  if (b.trail.length > limit) b.trail.shift();
}
