// The pure maths of the view lane. Everything asserted here is a number, which
// is why `camera.ts` is forbidden from touching a canvas: I6 is a property of
// a transform, and a property of a transform can be tested without a browser.

import { describe, expect, test } from 'bun:test';
import { buildArena, viewRotation } from '../src/shared/geometry';
import type { Arena } from '../src/shared/geometry';
import {
  Camera,
  EASE_SEC,
  computeFit,
  defaultMargins,
  shortestDelta,
  wrapPi,
} from '../src/client/view/camera';
import type { Viewport, XY } from '../src/client/view/camera';

const SIZES = [2, 3, 4, 5, 6, 7, 8];

const VIEWPORTS: readonly (Viewport & { label: string })[] = [
  { label: 'chromebook 1366x768', w: 1366, h: 768, dpr: 1 },
  { label: 'teacher 1440x900', w: 1440, h: 900, dpr: 2 },
  { label: 'narrow 800x1200', w: 800, h: 1200, dpr: 1 },
  { label: 'small 640x480', w: 640, h: 480, dpr: 1 },
];

const pt = (): XY => ({ x: 0, y: 0 });

function seated(arena: Arena, rank: number, vp: Viewport): Camera {
  const cam = new Camera();
  cam.snapToEdge(arena.goalEdges[rank]!);
  cam.update(arena, vp, 0);
  return cam;
}

// ---------------------------------------------------------------- SPEC I6

describe('I6: every client renders its own wall at the bottom', () => {
  for (const vp of VIEWPORTS) {
    for (const n of SIZES) {
      const arena = buildArena(n);
      for (let rank = 0; rank < arena.goalEdges.length; rank++) {
        test(`${vp.label}, ${n} players, seat ${rank}`, () => {
          const cam = seated(arena, rank, vp);
          const edge = arena.goalEdges[rank]!;

          const mid = cam.arenaToScreen(edge.mid.x, edge.mid.y, pt());
          const centre = cam.arenaToScreen(0, 0, pt());

          // Below the arena centre, by a real margin and not a rounding error.
          expect(mid.y).toBeGreaterThan(centre.y + vp.h * 0.05);
          // In the bottom half of the viewport outright.
          expect(mid.y).toBeGreaterThan(vp.h * 0.5);
          // And on screen.
          expect(mid.y).toBeLessThan(vp.h);

          // Own wall is centred left-right: the player faces straight up the
          // court, which is what makes A/D read as left/right (SPEC I5).
          expect(Math.abs(mid.x - vp.w / 2)).toBeLessThan(1e-6);

          // The arena centre sits near the middle of the screen. Not exactly:
          // the bottom margin is deeper than the top because the HUD strip
          // lives there.
          expect(Math.abs(centre.x - vp.w / 2)).toBeLessThan(1e-6);
          expect(Math.abs(centre.y - vp.h / 2)).toBeLessThan(vp.h * 0.12);
        });
      }
    }
  }

  test('the far side of the arena is above the centre, not below it', () => {
    // The sign guard. If `viewRotation` were applied negated, every player
    // would sit at the TOP of their own screen and the assertions above would
    // still look plausible in isolation on a symmetric polygon. Pinning both
    // ends of the court catches it.
    for (const n of SIZES) {
      const arena = buildArena(n);
      for (let rank = 0; rank < arena.goalEdges.length; rank++) {
        const cam = seated(arena, rank, VIEWPORTS[0]!);
        const e = arena.goalEdges[rank]!;
        // A point on the far side, mirrored through the centre.
        const far = cam.arenaToScreen(-e.mid.x, -e.mid.y, pt());
        const centre = cam.arenaToScreen(0, 0, pt());
        expect(far.y).toBeLessThan(centre.y);
      }
    }
  });

  test('an explicitly negated rotation breaks I6 (the bug this guards against)', () => {
    // Canvas y grows DOWNWARD, so the correct rotation is +viewRotation, not
    // -viewRotation. Negating it sends a wall at arena angle phi to
    // 2*phi - pi/2 instead of pi/2 — off to one side, and for half the seats
    // above the centre entirely. Seats at phi = +/- pi/2 land on the bottom
    // under BOTH signs and cannot tell them apart, so they are excluded.
    const vp = VIEWPORTS[0]!;
    let checked = 0;
    for (const n of SIZES) {
      const arena = buildArena(n);
      for (let rank = 0; rank < arena.goalEdges.length; rank++) {
        const e = arena.goalEdges[rank]!;
        const phi = Math.atan2(e.mid.y, e.mid.x);
        if (Math.abs(wrapPi(2 * phi - Math.PI)) < 0.2) continue;
        const cam = new Camera();
        cam.snapAngle(-viewRotation(e)); // deliberately wrong sign
        cam.update(arena, vp, 0);
        const mid = cam.arenaToScreen(e.mid.x, e.mid.y, pt());
        const centre = cam.arenaToScreen(0, 0, pt());
        // I6 is "own wall at the bottom, centred". The negated transform
        // always fails at least one half of that: it either lifts the wall
        // above the centre or slides it off to one side.
        const atBottom = mid.y > centre.y + vp.h * 0.05;
        const centred = Math.abs(mid.x - vp.w / 2) < 1;
        expect(atBottom && centred).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test('2-player: both seats get a TALL court, smaller than the teacher view', () => {
    const arena = buildArena(2);
    const vp = VIEWPORTS[0]!;
    const teacher = new Camera();
    teacher.snapToEdge(null);
    teacher.update(arena, vp, 0);

    for (let rank = 0; rank < 2; rank++) {
      const cam = seated(arena, rank, vp);
      // SPEC §5.2 states this outright: the rotated rectangle fits worse, so
      // each player's court is SMALLER on screen. Correct, not a bug.
      expect(cam.scale).toBeLessThan(teacher.scale);

      const a = cam.arenaToScreen(arena.verts[0]!.x, arena.verts[0]!.y, pt());
      const b = cam.arenaToScreen(arena.verts[2]!.x, arena.verts[2]!.y, pt());
      // Taller than it is wide, in screen pixels.
      expect(Math.abs(b.y - a.y)).toBeGreaterThan(Math.abs(b.x - a.x));
    }
  });

  test('teacher and spectator get the canonical unrotated orientation', () => {
    for (const n of SIZES) {
      const cam = new Camera();
      cam.snapToEdge(null);
      cam.update(buildArena(n), VIEWPORTS[0]!, 0);
      expect(cam.angle).toBe(0);
      const p = cam.arenaToScreen(1, 0, pt());
      const q = cam.arenaToScreen(0, 0, pt());
      // +x in arena units is still +x on screen: no rotation at all.
      expect(p.y).toBeCloseTo(q.y, 9);
      expect(p.x).toBeGreaterThan(q.x);
    }
  });
});

// ------------------------------------------------------------------- fit

describe('fit is uniform and fully on screen', () => {
  test('a single uniform scale, no shear, no flip', () => {
    const out = new Float64Array(6);
    for (const vp of VIEWPORTS) {
      for (const n of SIZES) {
        const arena = buildArena(n);
        for (let rank = 0; rank < arena.goalEdges.length; rank++) {
          const cam = seated(arena, rank, vp);
          cam.writeTransform(out);
          const [a, b, c, d] = [out[0]!, out[1]!, out[2]!, out[3]!];
          // Pure scaled rotation: a === d, c === -b.
          expect(a).toBeCloseTo(d, 9);
          expect(c).toBeCloseTo(-b, 9);
          // Equal magnification on both axes.
          expect(Math.hypot(a, b)).toBeCloseTo(Math.hypot(c, d), 9);
          expect(Math.hypot(a, b)).toBeCloseTo(cam.scale, 9);
          // Determinant positive: no mirroring.
          expect(a * d - b * c).toBeGreaterThan(0);
        }
      }
    }
  });

  test('the whole rotated arena, plus its label padding, lands inside the viewport', () => {
    const p = pt();
    for (const vp of VIEWPORTS) {
      for (const n of SIZES) {
        const arena = buildArena(n);
        for (let rank = 0; rank < arena.goalEdges.length; rank++) {
          const cam = seated(arena, rank, vp);
          const m = cam.margins;
          for (const vtx of arena.verts) {
            cam.arenaToScreen(vtx.x, vtx.y, p);
            expect(p.x).toBeGreaterThanOrEqual(m.left - 1e-6);
            expect(p.x).toBeLessThanOrEqual(vp.w - m.right + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(m.top - 1e-6);
            expect(p.y).toBeLessThanOrEqual(vp.h - m.bottom + 1e-6);
          }
          // Wall labels are drawn outside their wall, within `cam.pad`. That
          // room has to be on screen too or the bottom player's own name falls
          // off the bottom edge.
          for (const e of arena.edges) {
            cam.arenaToScreen(
              e.mid.x - e.n.x * cam.pad,
              e.mid.y - e.n.y * cam.pad,
              p,
            );
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(vp.w);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(vp.h);
          }
        }
      }
    }
  });

  test('computeFit letterboxes: it never overflows the smaller axis', () => {
    const fit = { scale: 0, ox: 0, oy: 0 };
    const arena = buildArena(6);
    const vp: Viewport = { w: 300, h: 1000, dpr: 1 };
    const m = defaultMargins(vp.w, vp.h);
    computeFit(arena, 0.7, vp, m, 0.17, fit);
    const availW = vp.w - m.left - m.right;
    const availH = vp.h - m.top - m.bottom;
    // Width-limited here, so the fitted height must be strictly under the
    // available height rather than equal to it.
    expect(fit.scale * (2 + 2 * 0.17)).toBeLessThanOrEqual(availH + 1e-6);
    expect(fit.scale).toBeGreaterThan(0);
    expect(availW).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- easing

describe('rotation easing takes the short way around', () => {
  test('wrapPi and shortestDelta agree on the seam', () => {
    expect(wrapPi(Math.PI * 2 - 0.1)).toBeCloseTo(-0.1, 12);
    expect(wrapPi(-Math.PI * 2 + 0.1)).toBeCloseTo(0.1, 12);
    expect(shortestDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(-0.2, 12);
    expect(shortestDelta(Math.PI * 2 - 0.1, 0.1)).toBeCloseTo(0.2, 12);
    // Exactly opposite is allowed to go either way, but must not exceed pi.
    expect(Math.abs(shortestDelta(0, Math.PI))).toBeLessThanOrEqual(Math.PI + 1e-12);
  });

  test('0.1 rad -> (2pi - 0.1) rad passes through zero, never through pi', () => {
    const arena = buildArena(5);
    const vp = VIEWPORTS[0]!;
    const cam = new Camera();
    cam.snapAngle(0.1);
    cam.update(arena, vp, 0);
    cam.setTargetAngle(Math.PI * 2 - 0.1);

    const seen: number[] = [];
    const dt = 1 / 120;
    for (let i = 0; i < 60; i++) {
      cam.update(arena, vp, dt);
      seen.push(wrapPi(cam.angle));
    }

    // Every intermediate angle stays inside the 0.2 rad short arc. A naive
    // lerp would sweep the long way and every sample would be far from zero.
    for (const a of seen) {
      expect(Math.abs(a)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    // It really did cross zero rather than sitting still.
    expect(Math.min(...seen)).toBeLessThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0);
    // And it landed on the target.
    expect(wrapPi(cam.angle)).toBeCloseTo(-0.1, 6);
    expect(cam.easing).toBe(false);
  });

  test('the ease lasts EASE_SEC and nothing snaps mid-way', () => {
    const arena = buildArena(4);
    const vp = VIEWPORTS[0]!;
    const cam = new Camera();
    cam.snapAngle(0);
    cam.update(arena, vp, 0);
    cam.setTargetAngle(1.2);

    cam.update(arena, vp, EASE_SEC * 0.5);
    expect(cam.easing).toBe(true);
    const half = cam.angle;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1.2);

    cam.update(arena, vp, EASE_SEC * 0.5);
    expect(cam.easing).toBe(false);
    expect(cam.angle).toBeCloseTo(1.2, 9);
  });

  test('re-asserting the same target every frame does not restart the ease', () => {
    const arena = buildArena(4);
    const vp = VIEWPORTS[0]!;
    const cam = new Camera();
    cam.snapAngle(0);
    cam.setTargetAngle(1.0);
    for (let i = 0; i < 40; i++) {
      cam.setTargetAngle(1.0); // what the render loop actually does
      cam.update(arena, vp, 1 / 120);
    }
    expect(cam.easing).toBe(false);
    expect(cam.angle).toBeCloseTo(1.0, 9);
  });

  test('the first target snaps; there is nothing to ease from', () => {
    const cam = new Camera();
    cam.setTargetAngle(2.0);
    expect(cam.angle).toBe(2.0);
    expect(cam.easing).toBe(false);
  });

  test('an elimination eases between real adjacent seat angles the short way', () => {
    // The concrete case from SPEC §5.2: the polygon shrinks under a seated
    // player, so their own edge — and therefore their view angle — moves.
    const vp = VIEWPORTS[0]!;
    const before = buildArena(8);
    const after = buildArena(7);
    for (let rank = 0; rank < 7; rank++) {
      const cam = new Camera();
      cam.snapToEdge(before.goalEdges[rank]!);
      cam.update(before, vp, 0);
      const start = cam.angle;
      cam.setViewEdge(after.goalEdges[rank]!);
      const target = viewRotation(after.goalEdges[rank]!);
      expect(Math.abs(shortestDelta(start, target))).toBeLessThanOrEqual(Math.PI + 1e-12);

      let prev = start;
      for (let i = 0; i < 40; i++) {
        cam.update(after, vp, 1 / 120);
        // Monotone and never more than the short arc away from either end.
        expect(Math.abs(shortestDelta(prev, cam.angle))).toBeLessThan(0.5);
        prev = cam.angle;
      }
      expect(wrapPi(cam.angle - target)).toBeCloseTo(0, 6);
      // And it ends up at the bottom, which is the whole point.
      const mid = cam.arenaToScreen(
        after.goalEdges[rank]!.mid.x,
        after.goalEdges[rank]!.mid.y,
        pt(),
      );
      expect(mid.y).toBeGreaterThan(cam.arenaToScreen(0, 0, pt()).y);
    }
  });
});

// ------------------------------------------------------------ round trip

describe('screenToArena is the inverse of arenaToScreen', () => {
  test('round-trips at every arena size and seat', () => {
    const a = pt();
    const s = pt();
    const probes: readonly [number, number][] = [
      [0, 0],
      [0.5, -0.3],
      [-0.9, 0.4],
      [1.0, 0.0],
      [0.0, -1.0],
      [-0.31, -0.77],
    ];
    for (const vp of VIEWPORTS) {
      for (const n of SIZES) {
        const arena = buildArena(n);
        for (let rank = 0; rank < arena.goalEdges.length; rank++) {
          const cam = seated(arena, rank, vp);
          for (const [x, y] of probes) {
            cam.arenaToScreen(x, y, s);
            cam.screenToArena(s.x, s.y, a);
            expect(a.x).toBeCloseTo(x, 9);
            expect(a.y).toBeCloseTo(y, 9);
          }
        }
      }
    }
  });

  test('round-trips from screen pixels back to screen pixels', () => {
    const arena = buildArena(6);
    const cam = seated(arena, 2, VIEWPORTS[1]!);
    const a = pt();
    const s = pt();
    for (const [sx, sy] of [
      [0, 0],
      [720, 450],
      [1439, 899],
      [12, 880],
    ] as const) {
      cam.screenToArena(sx, sy, a);
      cam.arenaToScreen(a.x, a.y, s);
      expect(s.x).toBeCloseTo(sx, 6);
      expect(s.y).toBeCloseTo(sy, 6);
    }
  });

  test('mid-ease, the inverse still matches the forward map', () => {
    // `cos`/`sin` are cached on the camera; a stale cache would show up here
    // and nowhere else.
    const arena = buildArena(5);
    const vp = VIEWPORTS[0]!;
    const cam = new Camera();
    cam.snapAngle(0);
    cam.setTargetAngle(2.4);
    const a = pt();
    const s = pt();
    for (let i = 0; i < 20; i++) {
      cam.update(arena, vp, 1 / 120);
      cam.arenaToScreen(0.42, -0.17, s);
      cam.screenToArena(s.x, s.y, a);
      expect(a.x).toBeCloseTo(0.42, 9);
      expect(a.y).toBeCloseTo(-0.17, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: the camera must always end up pointing at its target.
//
// Found by watching a real match, not by reasoning. The arena sat visibly
// askew with nobody at the bottom. Cause: while the arena rebuilds, the
// viewer's own wall can briefly flap between two ranks; each new target
// restarts the ease FROM THE CURRENT ANGLE, so alternating targets converge on
// the midpoint between them and stay there forever. Nothing recovered it,
// because every frame looked like a fresh ease.
describe('camera convergence guarantee', () => {
  const vp = { w: 1280, h: 800, dpr: 1 };
  const arena = buildArena(4);
  // Angular distance. The camera's angle is deliberately UNWRAPPED (it may sit
  // outside (-pi, pi] after several eases), so a naive modulo reports an angle
  // that differs by exactly 2*pi as maximally wrong. JS `%` keeps the sign of
  // the dividend, so the negative branch has to be folded back by hand.
  const norm = (x: number) => {
    let a = (x + Math.PI) % (2 * Math.PI);
    if (a < 0) a += 2 * Math.PI;
    return Math.abs(a - Math.PI);
  };

  test('a steady target is reached exactly, and stays reached', () => {
    for (let seat = 0; seat < 4; seat++) {
      const cam = new Camera();
      cam.snapToEdge(arena.goalEdges[(seat + 2) % 4]!);
      const edge = arena.goalEdges[seat]!;
      for (let i = 0; i < 40; i++) {
        cam.setViewEdge(edge);            // re-aimed every frame, as the client does
        cam.update(arena, vp, 1 / 60);
      }
      expect(norm(cam.angle - viewRotation(edge))).toBeLessThan(1e-9);
    }
  });

  test('recovers exactly after the target stops flapping', () => {
    const cam = new Camera();
    const a = arena.goalEdges[0]!;
    const b = arena.goalEdges[1]!;
    cam.snapToEdge(a);
    // Five seconds of the pathological input that caused the askew arena.
    for (let i = 0; i < 300; i++) {
      cam.setViewEdge(i % 2 === 0 ? a : b);
      cam.update(arena, vp, 1 / 60);
    }
    // Then the arena settles. Half a second later the view must be true.
    for (let i = 0; i < 30; i++) {
      cam.setViewEdge(b);
      cam.update(arena, vp, 1 / 60);
    }
    expect(norm(cam.angle - viewRotation(b))).toBeLessThan(1e-9);
  });
});
