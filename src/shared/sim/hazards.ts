// Hazards and the splitter: the two things on the table that are not a ball,
// a wall, or a paddle.
//
// SPEC §5.5 deleted the old aim-and-drop placement phase entirely. Hazards are
// now auto-placed by the server at a random legal spot the instant somebody is
// eliminated. That phase was the source of most of the old build's deadlocks:
// it was the one state whose exit depended on an actor rather than a clock,
// and it began at exactly the moment a question opened, so the eliminated
// student could not reach the aim UI and the match could never leave it.
// Nothing here waits on anybody.

import {
  add, clampInside, dist, insideArena, mul, norm, sub,
  type Arena, type Vec,
} from '../geometry';
import { T, type Rng } from '../config';
import type { Ball } from './ball';

export type HazardKind = 'blackhole' | 'sun';

export interface Hazard {
  readonly id: number;
  readonly kind: HazardKind;
  p: Vec;
  /** Field radius. The visible core is much smaller; this is the reach. */
  readonly r: number;
  /** Seat whose elimination spawned it. Colour only — physics ignores it. */
  readonly owner: number;
  age: number;
}

export interface Splitter {
  p: Vec;
  readonly r: number;
  age: number;
}

/** A sun does not just push, it accelerates. Fraction of speed added per second
 *  at the core, tapering with the same falloff as the push. (ported) */
const SUN_SPEED_GAIN = 0.45;

/** Splitter contact radius. Small enough that a ball has to be aimed at it. */
const SPLITTER_RADIUS = 0.028;

export function makeHazard(id: number, kind: HazardKind, p: Vec, owner: number): Hazard {
  return { id, kind, p: { x: p.x, y: p.y }, r: T.hazardRadius, owner, age: 0 };
}

export function makeSplitter(p: Vec): Splitter {
  return { p: { x: p.x, y: p.y }, r: SPLITTER_RADIUS, age: 0 };
}

/**
 * Field forces for one ball over one sub-step, plus the anti-orbit release.
 *
 * The release exists because a black hole and a ball are a two-body problem
 * with no energy loss: once the ball's speed and radius happen to match the
 * pull, it settles into a stable orbit and simply never reaches a wall again.
 * The round then cannot end, nobody concedes, and the class watches a screen
 * saver. So a ball that has been continuously inside ONE field for longer than
 * T.fieldGripMax stops being affected by THAT field until it leaves and comes
 * back. Per-field rather than global: a ball crossing two overlapping fields is
 * being flung around, not captured, and should keep feeling both.
 */
export function applyFields(b: Ball, hazards: readonly Hazard[], dt: number): void {
  for (const hz of hazards) {
    const d = dist(b.p, hz.p);
    if (d > hz.r) {
      b.grip.set(hz.id, 0);
      continue;
    }

    const held = (b.grip.get(hz.id) ?? 0) + dt;
    b.grip.set(hz.id, held);
    if (held > T.fieldGripMax) continue; // anti-orbit release

    // Linear falloff to zero at the field edge, so there is no discontinuity
    // when a ball crosses the boundary at speed.
    const falloff = 1 - d / hz.r;
    const toward = norm(sub(hz.p, b.p));

    if (hz.kind === 'blackhole') {
      b.v = add(b.v, mul(toward, T.blackHolePull * falloff * dt));
    } else {
      b.v = add(b.v, mul(toward, -T.sunPush * falloff * dt));
      b.v = mul(b.v, 1 + SUN_SPEED_GAIN * falloff * dt);
      b.hot = T.sunHeat;
    }
  }
}

/** True if `p` is a legal hazard core: clear of every wall and off the serve point. */
export function legalHazardSpot(arena: Arena, p: Vec): boolean {
  if (!insideArena(arena, p, T.hazardMargin)) return false;
  return dist(p, arena.center) >= T.hazardCenterClear;
}

/**
 * A random legal core position (SPEC §5.5). Rejection sampling, because the
 * legal region is a polygon minus a disc and there is no cheap direct
 * parameterisation of it; the try budget is fixed so this can never spin.
 *
 * `existing` is a preference, not a constraint: two hazards stacked on one
 * another is ugly but playable, whereas failing to place one at all would mean
 * an elimination silently produced nothing.
 */
export function randomHazardSpot(
  arena: Arena,
  rng: Rng,
  existing: readonly Hazard[] = [],
): Vec {
  const spread = T.hazardRadius * 0.6;
  let fallback: Vec | null = null;

  for (let tries = 0; tries < 64; tries++) {
    const a = rng() * Math.PI * 2;
    const d = T.hazardCenterClear + rng() * (1 - T.hazardCenterClear);
    const p: Vec = {
      x: arena.center.x + Math.cos(a) * d,
      y: arena.center.y + Math.sin(a) * d,
    };
    if (!legalHazardSpot(arena, p)) continue;
    if (!fallback) fallback = p;
    if (existing.some((h) => dist(p, h.p) < spread)) continue;
    return p;
  }
  if (fallback) return fallback;

  // The polygon was too tight for the sampler to find anything (a 3-gon has
  // barely any legal annulus). Push straight out from the centre instead —
  // deterministic, always inside, and it is the same rule the shrink uses.
  return pushOffCenter(arena, { x: arena.center.x + T.hazardCenterClear, y: arena.center.y });
}

/** Nearest legal spot to `p`: inside the walls, and off the serve point. */
export function pushOffCenter(arena: Arena, p: Vec): Vec {
  let q = clampInside(arena, p, T.hazardMargin);
  const d = dist(q, arena.center);
  if (d < T.hazardCenterClear) {
    // Degenerate case: exactly on the centre has no "away" direction. +x is as
    // good as any and keeps this a pure function of its inputs.
    const away = d < 1e-6 ? { x: 1, y: 0 } : norm(sub(q, arena.center));
    q = clampInside(arena, add(arena.center, mul(away, T.hazardCenterClear)), T.hazardMargin);
  }
  return q;
}

/**
 * SPEC §5.5: hazards are repositioned, never destroyed, when the arena shrinks.
 * Destroying them would mean the reward for surviving an elimination is that
 * the board gets easier, which is backwards.
 */
export function repositionHazards(arena: Arena, hazards: readonly Hazard[]): Hazard[] {
  return hazards.map((h) => ({ ...h, p: pushOffCenter(arena, h.p) }));
}

/**
 * Somewhere for the splitter that is well inside the arena and not buried in a
 * hazard field, where a ball would be yanked past it before it could touch.
 * Returns null if there is nowhere sensible — a splitter is a bonus, and a
 * round with none is a normal round.
 */
export function randomSplitterSpot(
  arena: Arena,
  rng: Rng,
  hazards: readonly Hazard[],
): Vec | null {
  const margin = T.hazardMargin + 0.10;
  for (let tries = 0; tries < 40; tries++) {
    const a = rng() * Math.PI * 2;
    const d = 0.25 + rng() * 0.5;
    const p: Vec = {
      x: arena.center.x + Math.cos(a) * d,
      y: arena.center.y + Math.sin(a) * d,
    };
    if (!insideArena(arena, p, margin)) continue;
    if (dist(p, arena.center) < 0.18) continue;
    if (hazards.some((h) => dist(p, h.p) < h.r * 0.5)) continue;
    return p;
  }
  return null;
}

/** A splitter outside the shrunken arena is gone, not clamped: unlike a hazard
 *  it has no field, so a clamped one would land silently on top of a wall. */
export function splitterSurvives(arena: Arena, s: Splitter): boolean {
  return insideArena(arena, s.p, T.hazardMargin);
}
