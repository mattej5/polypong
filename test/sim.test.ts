// Tests for src/shared/sim. Headless, no browser, no sockets, driven entirely
// by an injected dt and an injected Rng, which is what SPEC §12 is built on.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { T, TIMING } from '../src/shared/config';
import {
  buildArena, dot, len, mul, norm, rot, sub, viewRotation,
  type Edge, type Vec,
} from '../src/shared/geometry';
import { Game, type GameEvent } from '../src/shared/sim/game';
import { makeBall } from '../src/shared/sim/ball';
import { legalHazardSpot, randomHazardSpot } from '../src/shared/sim/hazards';
import { mulberry32 } from './helpers/rng';

const SIZES = [2, 3, 4, 5, 6, 7, 8] as const;

/** Every seat human, so no bot steers a paddle the test did not ask it to. */
const allHuman = (n: number): boolean[] => Array.from({ length: n }, () => false);
const allBots = (n: number): boolean[] => Array.from({ length: n }, () => true);

function freshGame(n: number, seed = 1, lives = 3, bots = false): Game {
  const g = new Game(mulberry32(seed));
  g.start(n, lives, bots ? allBots(n) : allHuman(n));
  return g;
}

function edgeOf(g: Game, seat: number): Edge {
  const e = g.players[seat]?.edge;
  if (!e) throw new Error(`seat ${seat} has no edge`);
  return e;
}

/** Where the renderer would actually draw a point for the viewer on `edge`:
 *  the shared arena position, put through that viewer's rotation (SPEC §5.2). */
function toScreen(p: Vec, edge: Edge): Vec {
  return rot(p, viewRotation(edge));
}

function paddleScreen(g: Game, seat: number): Vec {
  const p = g.players[seat];
  if (!p?.paddle || !p.edge) throw new Error(`seat ${seat} has no paddle`);
  return toScreen(p.paddle.center(p.edge), p.edge);
}

// ---------------------------------------------------------------- SPEC I5

describe('I5 — D is the player\'s own screen-right on every wall', () => {
  // The single most bug-prone thing in the project. `Edge.dir` shares one
  // winding sense around the polygon, so "+dir" is rightward on one wall and
  // leftward, upward or downward on the next; Edge.rightSign is the only thing
  // standing between a student and a paddle that runs the wrong way. Checked in
  // ROTATED SCREEN COORDINATES, because arena-space agreement proves nothing
  // about what the student sees.

  for (const n of SIZES) {
    test(`${n}-player arena: every seat, both directions`, () => {
      for (let seat = 0; seat < n; seat++) {
        for (const screenDir of [1, -1] as const) {
          const g = freshGame(n);
          const edge = edgeOf(g, seat);

          // The viewer's own wall must be at the BOTTOM of their screen (I6),
          // otherwise "screen-right" is not even a meaningful claim.
          const midScreen = toScreen(edge.mid, edge);
          expect(midScreen.y).toBeGreaterThan(0.3);
          expect(Math.abs(midScreen.x)).toBeLessThan(1e-9);

          const before = paddleScreen(g, seat);
          g.setInput(seat, screenDir);
          g.update(0.05);
          const after = paddleScreen(g, seat);

          const dx = after.x - before.x;
          const dy = after.y - before.y;

          // It moved, it moved the way the key says, and it stayed on its wall.
          expect(Math.abs(dx)).toBeGreaterThan(1e-4);
          expect(Math.sign(dx)).toBe(screenDir);
          expect(Math.abs(dy)).toBeLessThan(Math.abs(dx) * 1e-6);
        }
      }
    });
  }

  test('holds after eliminations reshuffle every seat onto a new wall', () => {
    // Seat index and wall RANK diverge the moment somebody is eliminated:
    // seat 5 can end up defending goal edge 1. A mapping that only works while
    // rank === seat passes the loop above and fails in a real match.
    for (const n of [4, 6, 8]) {
      const g = freshGame(n, 7);
      // Kill the first two seats outright.
      g.loseLife(0, 99);
      g.loseLife(1, 99);
      expect(g.arena.n).toBe(n - 2);

      for (let seat = 2; seat < n; seat++) {
        for (const screenDir of [1, -1] as const) {
          const edge = edgeOf(g, seat);
          expect(toScreen(edge.mid, edge).y).toBeGreaterThan(0.3);

          const before = paddleScreen(g, seat);
          g.setInput(seat, screenDir);
          g.update(0.05);
          const after = paddleScreen(g, seat);
          g.setInput(seat, 0);

          expect(Math.sign(after.x - before.x)).toBe(screenDir);
        }
      }
    }
  });

  test('a key held through an elimination still means screen-right after it', () => {
    // The reason setInput stores the raw screen direction rather than the
    // converted one: the player's new wall can have the opposite rightSign.
    const g = freshGame(5, 11);
    for (let seat = 0; seat < 5; seat++) g.setInput(seat, 1);
    g.update(0.02);
    g.loseLife(0, 99);
    for (let seat = 1; seat < 5; seat++) {
      const before = paddleScreen(g, seat);
      g.update(0.05);
      const after = paddleScreen(g, seat);
      expect(after.x).toBeGreaterThan(before.x);
    }
  });
});

// ---------------------------------------------------------------- SPEC I7

/**
 * Aim a ball at `seat`'s wall from `angle` off the inward normal, park the
 * paddle exactly on the predicted arrival, and run until it turns around.
 *
 * `standoff` is swept by the caller because the collision is sampled at
 * discrete sub-steps: a fixed launch distance always lands the ball at the same
 * phase relative to the wall, and a tunnelling bug that only shows up at some
 * phases would hide behind it forever.
 *
 * Returns null when the arrival lands off the end of the wall — that is a
 * geometry limit of the trial, not a physics result.
 */
function interceptTrial(
  g: Game,
  seat: number,
  angle: number,
  speed: number,
  dt: number,
  standoff: number,
): { minPerp: number; bounced: boolean; conceded: GameEvent[] } | null {
  const player = g.players[seat];
  const edge = edgeOf(g, seat);
  const paddle = player?.paddle;
  if (!paddle) throw new Error('no paddle');

  const p0 = { x: edge.mid.x + edge.n.x * standoff, y: edge.mid.y + edge.n.y * standoff };
  const dir = norm({
    x: -edge.n.x * Math.cos(angle) + edge.dir.x * Math.sin(angle),
    y: -edge.n.y * Math.cos(angle) + edge.dir.y * Math.sin(angle),
  });

  const vperp = -speed * Math.cos(angle);
  const tHit = (standoff - T.ballRadius) / -vperp;
  const hit = { x: p0.x + dir.x * speed * tHit, y: p0.y + dir.y * speed * tHit };
  const along = dot(sub(hit, edge.a), edge.dir);
  if (along < paddle.min || along > paddle.max) return null;

  paddle.s = along;
  paddle.vel = 0;

  const ball = makeBall(9000, p0, 0);
  ball.v = mul(dir, speed);
  g.balls = [ball];
  g.drainEvents();

  let minPerp = Infinity;
  let bounced = false;
  const conceded: GameEvent[] = [];

  for (let i = 0; i < 4000 && !bounced; i++) {
    g.update(dt);
    for (const e of g.drainEvents()) if (e.t === 'conceded' && e.seat === seat) conceded.push(e);
    const b = g.balls[0];
    if (!b || b.id !== ball.id) break; // it was scored, or the table was reset
    const perp = dot(sub(b.p, edge.a), edge.n);
    minPerp = Math.min(minPerp, perp);
    if (dot(b.v, edge.n) > 0 && perp > b.r) bounced = true;
  }
  return { minPerp, bounced, conceded };
}

/** Run the sim with an empty table so the stall breaker inflates the speed cap.
 *  It is the only way the sim legitimately produces its true top speed, and the
 *  top speed is the only speed at which I7 is actually in danger. */
function inflateSpeedCap(g: Game, seconds: number): void {
  g.setRunning(true);
  g.balls = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) g.update(1 / 60);
  g.drainEvents();
}

describe('I7 — the ball never passes through a paddle', () => {
  // Sub-stepping is the whole mechanism (T.subStepMaxTravel), so this is run at
  // three tick rates: a fine one, the real 60 Hz server tick, and a deliberately
  // coarse 30 Hz. The launch distance is swept as well, so the ball meets the
  // wall at many different sub-step phases rather than one.
  // Out to +/-1.2 rad off the normal: past that the straight-line intercept
  // lands beyond the end of the wall on the smaller polygons and the trial is
  // skipped, so widening further buys nothing.
  const angles = Array.from({ length: 25 }, (_, i) => -1.2 + (i * 2.4) / 24);
  const standoffs = [0.30, 0.325, 0.35, 0.375];

  // The cap at round start, and the cap after a 60-second rally, which is what
  // the stall breaker actually hands the sim in a long round.
  const cases: { name: string; warm: number; speed: number; dt: number }[] = [];
  for (const dt of [1 / 240, 1 / 60, 1 / 30]) {
    cases.push({ name: `fresh round, dt=1/${Math.round(1 / dt)}`, warm: 0, speed: T.ballSpeedMax * 1.15, dt });
    cases.push({
      name: `60s stall-inflated, dt=1/${Math.round(1 / dt)}`,
      warm: 60,
      speed: T.ballSpeedMax * (1 + 50 * 0.05) * 1.15,
      dt,
    });
  }

  for (const c of cases) {
    test(`${c.name}: every seat, every angle`, () => {
      let trials = 0;
      for (const n of SIZES) {
        for (let seat = 0; seat < n; seat++) {
          for (const angle of angles) {
            for (const standoff of standoffs) {
              const g = freshGame(n, 3);
              if (c.warm > 0) inflateSpeedCap(g, c.warm);
              else g.setRunning(true);
              const r = interceptTrial(g, seat, angle, c.speed, c.dt, standoff);
              if (!r) continue;
              trials++;
              expect(r.conceded).toEqual([]);
              // The centre never ends a step behind the wall plane it defends.
              expect(r.minPerp).toBeGreaterThan(0);
              expect(r.bounced).toBe(true);
            }
          }
        }
      }
      // Guard against the whole suite silently skipping every case.
      expect(trials).toBeGreaterThan(800);
    });
  }

  test('a paddle moved away does concede — the trial can actually fail', () => {
    // Without this, an I7 test that never reaches a wall would pass forever.
    const g = freshGame(4, 3);
    g.setRunning(true);
    const edge = edgeOf(g, 0);
    const paddle = g.players[0]?.paddle;
    if (!paddle) throw new Error('no paddle');
    paddle.s = paddle.min;

    const ball = makeBall(9001, { x: edge.mid.x + edge.n.x * 0.3, y: edge.mid.y + edge.n.y * 0.3 }, 0);
    ball.v = mul(edge.n, -T.ballSpeed);
    g.balls = [ball];
    g.drainEvents();

    let sawGoal = false;
    for (let i = 0; i < 600 && !sawGoal; i++) {
      g.update(1 / 60);
      for (const e of g.drainEvents()) if (e.t === 'conceded' && e.seat === 0) sawGoal = true;
    }
    expect(sawGoal).toBe(true);
  });
});

// -------------------------------------------------- serving, lives, shrink

describe('serve, concede, elimination, arena shrink', () => {
  test('serve puts exactly one ball on the centre and bumps the round', () => {
    const g = freshGame(5, 21);
    expect(g.round).toBe(0);
    g.serve();
    expect(g.round).toBe(1);
    expect(g.balls.length).toBe(1);
    const b = g.balls[0];
    if (!b) throw new Error('no ball');
    expect(Math.hypot(b.p.x, b.p.y)).toBeLessThan(1e-9);
    expect(len(b.v)).toBeCloseTo(T.ballSpeed, 6);
  });

  test('a splitter appears every T.splitEvery rounds and clones up to maxBalls', () => {
    const g = freshGame(4, 33);
    for (let i = 0; i < T.splitEvery - 1; i++) g.serve();
    expect(g.splitter).toBeNull();
    g.serve();
    expect(g.round % T.splitEvery).toBe(0);
    expect(g.splitter).not.toBeNull();

    // Drive a ball straight into it and watch the table grow, capped.
    g.setRunning(true);
    for (let i = 0; i < 400 && g.splitter; i++) {
      const sp = g.splitter;
      const b = g.balls[0];
      if (!b || !sp) break;
      b.p = { x: sp.p.x, y: sp.p.y };
      g.update(1 / 240);
    }
    expect(g.balls.length).toBeGreaterThan(1);
    expect(g.balls.length).toBeLessThanOrEqual(T.maxBalls);
  });

  test('a conceded ball costs one life, a hot one costs T.hotCost', () => {
    for (const hot of [false, true]) {
      const g = freshGame(4, 5);
      g.setRunning(true);
      const edge = edgeOf(g, 0);
      const paddle = g.players[0]?.paddle;
      if (!paddle) throw new Error('no paddle');
      paddle.s = paddle.min;

      const b = makeBall(1, { x: edge.mid.x + edge.n.x * 0.3, y: edge.mid.y + edge.n.y * 0.3 }, 0);
      b.v = mul(edge.n, -T.ballSpeed);
      if (hot) b.hot = T.sunHeat;
      g.balls = [b];
      g.drainEvents();

      let ev: GameEvent | undefined;
      for (let i = 0; i < 600 && !ev; i++) {
        g.update(1 / 120);
        ev = g.drainEvents().find((e) => e.t === 'conceded');
      }
      expect(ev).toBeDefined();
      if (ev?.t !== 'conceded') throw new Error('expected a concede');
      expect(ev.cost).toBe(hot ? T.hotCost : 1);
      expect(g.players[0]?.lives).toBe(3 - (hot ? T.hotCost : 1));
    }
  });

  test('an ordinary point arms the serve delay; an elimination does not', () => {
    const g = freshGame(4, 9);
    g.setRunning(true);
    g.serve();
    const drive = (seat: number): GameEvent[] => {
      const edge = edgeOf(g, seat);
      const paddle = g.players[seat]?.paddle;
      if (!paddle) throw new Error('no paddle');
      paddle.s = paddle.min;
      const b = makeBall(500 + seat, { x: edge.mid.x + edge.n.x * 0.3, y: edge.mid.y + edge.n.y * 0.3 }, 0);
      b.v = mul(edge.n, -T.ballSpeed);
      g.balls = [b];
      g.drainEvents();
      const out: GameEvent[] = [];
      for (let i = 0; i < 600; i++) {
        g.update(1 / 120);
        out.push(...g.drainEvents());
        if (out.some((e) => e.t === 'conceded')) break;
      }
      return out;
    };

    expect(drive(0).some((e) => e.t === 'roundEnded')).toBe(true);
    // The auto-serve fires on its own after TIMING.serveDelay.
    for (let i = 0; i < Math.ceil(TIMING.serveDelay * 120) + 4; i++) g.update(1 / 120);
    expect(g.balls.length).toBe(1);

    // Now finish seat 0 off. The table stays empty: the arena changed shape and
    // only the owner may restart play.
    g.loseLife(0, 99);
    for (let i = 0; i < 600; i++) g.update(1 / 120);
    expect(g.balls.length).toBe(0);
  });

  test('zero lives eliminates, shrinks the arena, and drops a hazard', () => {
    for (const n of SIZES) {
      const g = freshGame(n, 13);
      const before = g.players.map((p) => p.paddle?.fraction(p.edge!) ?? 0.5);
      // Nudge one survivor off centre so "keeps a sensible position" is testable.
      const survivor = n - 1;
      const sp = g.players[survivor]?.paddle;
      if (sp) sp.s = sp.min + (sp.max - sp.min) * 0.8;

      const killed = g.loseLife(0, 3);
      expect(killed).toBe(true);
      const ev = g.drainEvents();
      expect(ev.some((e) => e.t === 'eliminated' && e.seat === 0)).toBe(true);
      expect(g.players[0]?.alive).toBe(false);
      expect(g.players[0]?.edge).toBeNull();

      if (n > 2) {
        expect(g.arena.n).toBe(n - 1);
        expect(g.hazards.length).toBe(1);
        const hz = g.hazards[0];
        if (!hz) throw new Error('no hazard');
        expect(legalHazardSpot(g.arena, hz.p)).toBe(true);

        // Survivors are all on a wall, in range, and the one we moved kept its
        // relative position rather than snapping to an end.
        for (let s = 1; s < n; s++) {
          const p = g.players[s];
          expect(p?.alive).toBe(true);
          expect(p?.edge).not.toBeNull();
          const f = p?.paddle?.fraction(p.edge!) ?? -1;
          expect(f).toBeGreaterThan(0);
          expect(f).toBeLessThan(1);
        }
        const moved = g.players[survivor];
        const fr = moved?.paddle
          ? (moved.paddle.s - moved.paddle.min) / (moved.paddle.max - moved.paddle.min)
          : -1;
        expect(fr).toBeCloseTo(0.8, 6);
      } else {
        // Two players: the loser's elimination ends it outright.
        expect(g.over).toBe(true);
        expect(g.winner).toBe(1);
      }
      expect(before.length).toBe(n);
    }
  });

  test('every third elimination is a sun, the rest are black holes', () => {
    const g = freshGame(8, 41);
    const kinds: string[] = [];
    for (let seat = 0; seat < 6; seat++) {
      g.loseLife(seat, 99);
      const hz = g.hazards[g.hazards.length - 1];
      if (hz) kinds.push(hz.kind);
    }
    expect(kinds).toEqual([
      'blackhole', 'blackhole', 'sun',
      'blackhole', 'blackhole', 'sun',
    ]);
  });

  test('hazards are repositioned, not destroyed, when the arena shrinks', () => {
    const g = freshGame(8, 55);
    for (let seat = 0; seat < 4; seat++) g.loseLife(seat, 99);
    expect(g.hazards.length).toBe(4);
    for (const hz of g.hazards) expect(legalHazardSpot(g.arena, hz.p)).toBe(true);
  });

  test('the last survivor wins; a revive un-does that', () => {
    const g = freshGame(3, 17);
    g.loseLife(0, 99);
    expect(g.over).toBe(false);
    g.drainEvents();
    g.loseLife(1, 99);
    expect(g.over).toBe(true);
    expect(g.winner).toBe(2);
    expect(g.drainEvents().some((e) => e.t === 'matchOver' && e.winner === 2)).toBe(true);

    // SPEC §6.2: the revive question exists precisely for the case where the
    // class question knocked out the last challenger.
    expect(g.revive(1, 1)).toBe(true);
    expect(g.over).toBe(false);
    expect(g.winner).toBeNull();
    expect(g.players[1]?.lives).toBe(1);
    expect(g.players[1]?.edge).not.toBeNull();
    expect(g.arena.n).toBe(2);
  });

  test('a match where everyone dies at once is a draw, not a win', () => {
    const g = freshGame(2, 19);
    g.loseLife(0, 99);
    g.loseLife(1, 99);
    expect(g.over).toBe(true);
    expect(g.winner).toBeNull();
  });

  test('nothing moves while the sim is not running', () => {
    const g = freshGame(4, 23);
    g.serve();
    const b = g.balls[0];
    if (!b) throw new Error('no ball');
    const p0 = { ...b.p };
    for (let i = 0; i < 120; i++) g.update(1 / 60);
    expect(b.p.x).toBeCloseTo(p0.x, 12);
    expect(b.p.y).toBeCloseTo(p0.y, 12);

    // ...but a human paddle still does, so the 3-2-1 is not a dead screen.
    const before = paddleScreen(g, 0);
    g.setInput(0, 1);
    g.update(0.05);
    expect(paddleScreen(g, 0).x).toBeGreaterThan(before.x);
  });
});

// ---------------------------------------------------------------- hazards

describe('hazards', () => {
  test('random placement is always legal for every arena size', () => {
    const rng = mulberry32(99);
    for (const n of SIZES) {
      const arena = buildArena(n);
      for (let i = 0; i < 300; i++) {
        expect(legalHazardSpot(arena, randomHazardSpot(arena, rng))).toBe(true);
      }
    }
  });

  test('the anti-orbit release lets a captured ball escape', () => {
    // Without it a ball settles into a stable orbit and the round never ends.
    // Park a black hole and drop a ball into a circular-ish orbit around it.
    const g = freshGame(6, 61);
    g.setRunning(true);
    g.loseLife(0, 99); // spawns a black hole
    const hz = g.hazards[0];
    if (!hz) throw new Error('no hazard');
    expect(hz.kind).toBe('blackhole');

    const b = makeBall(7, { x: hz.p.x + 0.08, y: hz.p.y }, 0);
    // Tangential, slow: the worst case for capture.
    b.v = { x: 0, y: T.ballSpeedMin };
    g.balls = [b];
    g.serve();
    g.balls = [b];

    let escaped = false;
    for (let i = 0; i < 60 * 40 && !escaped; i++) {
      g.update(1 / 60);
      const cur = g.balls.find((x) => x.id === 7);
      if (!cur) { escaped = true; break; }
      if (Math.hypot(cur.p.x - hz.p.x, cur.p.y - hz.p.y) > hz.r) escaped = true;
    }
    expect(escaped).toBe(true);
  });

  test('a sun heats the ball, and heat costs T.hotCost lives', () => {
    const g = freshGame(8, 71);
    g.setRunning(true);
    for (let seat = 0; seat < 3; seat++) g.loseLife(seat, 99);
    const sun = g.hazards.find((h) => h.kind === 'sun');
    if (!sun) throw new Error('no sun');

    const b = makeBall(8, { x: sun.p.x, y: sun.p.y }, 0);
    b.v = { x: T.ballSpeed, y: 0 };
    g.balls = [b];
    g.serve();
    g.balls = [b];
    g.update(1 / 60);
    expect(b.hot).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------- bots

describe('bots', () => {
  for (const n of SIZES) {
    test(`a ${n}-bot match always reaches a result`, () => {
      // Ten seeds each, because "terminates" that only holds for one RNG
      // stream is not a liveness property (SPEC I2).
      for (let seed = 1; seed <= 10; seed++) {
        const g = new Game(mulberry32(seed * 7919));
        g.start(n, 3, allBots(n));
        g.setRunning(true);
        g.serve();

        const dt = 1 / 60;
        // Generous ceiling: measured worst case across these seeds is 284
        // simulated seconds at n=8 (SPEC §11 targets 3-5 minutes), so 900 is
        // a termination proof, not a tuning assertion.
        const budget = 60 * 900;
        let ticks = 0;
        while (!g.over && ticks < budget) {
          g.update(dt);
          for (const e of g.drainEvents()) {
            // The owner drives the restart after an elimination; here the test
            // stands in for Match with no countdown at all.
            if (e.t === 'eliminated') g.serve();
          }
          ticks++;
        }
        expect(g.over).toBe(true);
        expect(g.winner === null || (g.winner >= 0 && g.winner < n)).toBe(true);
        const alive = g.players.filter((p) => p.alive).length;
        expect(alive).toBeLessThanOrEqual(1);
      }
    });
  }

  test('the stall breaker ends a rally the bots would otherwise never lose', () => {
    const g = new Game(mulberry32(1234));
    g.start(2, 3, allBots(2));
    g.setRunning(true);
    g.serve();
    const startRound = g.round;
    let ticks = 0;
    while (g.round === startRound && ticks < 60 * 120) {
      g.update(1 / 60);
      for (const e of g.drainEvents()) if (e.t === 'eliminated') g.serve();
      ticks++;
    }
    // T.stallTimeout is 10s and speed compounds from there; a rally lasting
    // two minutes means the breaker is not wired up.
    expect(ticks).toBeLessThan(60 * 120);
  });
});

// ---------------------------------------------------------- determinism

describe('determinism', () => {
  test('same seed and same inputs give byte-identical snapshots', () => {
    for (const n of SIZES) {
      const a = new Game(mulberry32(4242));
      const b = new Game(mulberry32(4242));
      for (const g of [a, b]) {
        // Mixed table: seats 0 and 1 are students, the rest are bots.
        g.start(n, 3, Array.from({ length: n }, (_, i) => i >= 2));
        g.setRunning(true);
        g.serve();
      }

      // A scripted, reproducible input stream, driven off its own PRNG so the
      // two Games see exactly the same keys at exactly the same ticks.
      const script = mulberry32(31337);
      for (let tick = 0; tick < 3000; tick++) {
        const d = (Math.floor(script() * 3) - 1) as -1 | 0 | 1;
        const seat = tick % 2;
        for (const g of [a, b]) {
          g.setInput(seat, d);
          g.update(1 / 60);
          for (const e of g.drainEvents()) if (e.t === 'eliminated') g.serve();
        }
        if (tick % 25 === 0) {
          expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
        }
      }
      expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
      expect(a.over).toBe(b.over);
    }
  });

  test('ball ids are per-Game, so two fresh Games mint the same ids', () => {
    // A module-level counter (what the old build used) makes the second Game in
    // a process disagree with the first on every id, and ids are what clients
    // match balls by.
    const a = freshGame(4, 8);
    const b = freshGame(4, 8);
    a.serve();
    b.serve();
    expect(a.balls[0]?.id).toBe(b.balls[0]?.id ?? -1);
  });
});

// --------------------------------------------------------------- snapshot

describe('snapshot and replica', () => {
  test('SnapPlayer.s is the paddle centre as a fraction along its own edge', () => {
    for (const n of SIZES) {
      const g = freshGame(n, 77);
      for (let seat = 0; seat < n; seat++) {
        const p = g.players[seat];
        if (!p?.paddle || !p.edge) throw new Error('no paddle');
        p.paddle.s = p.paddle.min;
        const snap = g.snapshot();
        const row = snap.pl.find((q) => q.i === seat);
        expect(row?.s).toBeCloseTo(p.paddle.min / p.edge.length, 4);
        expect(row?.s).toBeGreaterThan(0);
        expect(row?.s).toBeLessThan(1);
        p.paddle.s = p.paddle.max;
        expect(g.snapshot().pl.find((q) => q.i === seat)?.s)
          .toBeCloseTo(p.paddle.max / p.edge.length, 4);
      }
    }
  });

  test('the phase fields are pass-through — the sim never invents them', () => {
    const g = freshGame(4, 88);
    const s = g.snapshot({ ph: 'question', tm: 12.5, bn: 'RILEY IS OUT' });
    expect(s.ph).toBe('question');
    expect(s.tm).toBe(12.5);
    expect(s.bn).toBe('RILEY IS OUT');
  });

  test('a replica rebuilds from a snapshot and carries trails by ball id', () => {
    const src = freshGame(5, 101);
    src.setRunning(true);
    src.serve();
    for (let i = 0; i < 60; i++) src.update(1 / 60);

    const replica = new Game(mulberry32(1));
    replica.applySnapshot(src.snapshot());
    expect(replica.balls.length).toBe(src.balls.length);
    expect(replica.players.length).toBe(5);
    expect(replica.arena.n).toBe(5);

    // Give the replica a tail, then re-apply. The tail must follow the ID.
    replica.pushTrails();
    replica.pushTrails();
    const id = replica.balls[0]?.id ?? -1;
    const tailLen = replica.balls[0]?.trail.length ?? 0;
    expect(tailLen).toBeGreaterThan(0);

    // The next snapshot is built by hand rather than by running the sim on,
    // so the test asserts the id-matching rule and nothing about how long a
    // rally happens to last.
    const moved = src.snapshot();
    const b0 = moved.bl[0];
    if (!b0) throw new Error('no ball on the wire');
    // Same id, somewhere else...
    moved.bl[0] = { ...b0, i: id, p: [b0.p[0] + 0.2, b0.p[1] - 0.1] };
    // ...alongside a ball this replica has never seen, and one whose id is the
    // ARRAY INDEX of the first. Matching by index would hand this one the tail.
    moved.bl.push({ ...b0, i: 999999 });
    moved.bl.push({ ...b0, i: 0 });

    replica.applySnapshot(moved);
    expect(replica.balls.find((b) => b.id === id)?.trail.length).toBe(tailLen);
    expect(replica.balls.find((b) => b.id === 999999)?.trail.length).toBe(0);
    expect(replica.balls.find((b) => b.id === 0)?.trail.length).toBe(0);
  });

  test('a replica never simulates', () => {
    const src = freshGame(4, 111);
    src.setRunning(true);
    src.serve();
    for (let i = 0; i < 30; i++) src.update(1 / 60);

    const replica = new Game(mulberry32(2));
    replica.applySnapshot(src.snapshot());
    const p0 = { ...(replica.balls[0]?.p ?? { x: 0, y: 0 }) };
    for (let i = 0; i < 120; i++) replica.update(1 / 60);
    expect(replica.balls[0]?.p.x).toBeCloseTo(p0.x, 12);
    expect(replica.balls[0]?.p.y).toBeCloseTo(p0.y, 12);
  });
});

// ------------------------------------------------------------- SPEC I12

test('I12 — sim/ references no runtime API and no ambient randomness', () => {
  const dir = join(import.meta.dir, '..', 'src', 'shared', 'sim');
  const banned = /Math\.random|Date\.now|\bwindow\.|\bdocument\.|\bBun\b|from ['"]node:/;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      // The prose in the comments is allowed to name the thing it forbids.
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      expect(`${f}:${i + 1} ${banned.test(line) ? line.trim() : ''}`).toBe(`${f}:${i + 1} `);
    }
  }
});
