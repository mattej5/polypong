import { describe, test, expect } from 'bun:test';
import type { Snapshot, SnapBall, SnapPlayer, SnapHazard } from '../src/shared/protocol';
import { blendSnapshots, SnapshotStream } from '../src/client/net/interp';
import { PaddlePredictor } from '../src/client/net/predict';

// ---------------------------------------------------------------- fixtures

function player(i: number, s: number, l = 3, a: 0 | 1 = 1): SnapPlayer {
  return { i, l, a, b: 0, n: `p${i}`, s };
}

function ball(i: number, p: [number, number], v: [number, number] = [0, 0], h: 0 | 1 = 0): SnapBall {
  return { i, p, v, h };
}

function hazard(k: 'blackhole' | 'sun', p: [number, number], o = 0): SnapHazard {
  return { k, p, o };
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ph: 'playing',
    tm: 0,
    rd: 1,
    bn: '',
    pl: [player(0, 0.5), player(1, 0.5)],
    bl: [ball(1, [0, 0])],
    hz: [],
    sp: null,
    wn: null,
    ...overrides,
  };
}

// ------------------------------------------------------- anti-extrapolation

describe('blendSnapshots: anti-extrapolation', () => {
  const a = snap({
    tm: 10,
    pl: [player(0, 0.2), player(1, 0.8)],
    bl: [ball(1, [-0.5, -0.5], [1, 1])],
    hz: [hazard('sun', [0.1, 0.1])],
    sp: [0, 0],
  });
  const b = snap({
    tm: 8,
    pl: [player(0, 0.6), player(1, 0.3)],
    bl: [ball(1, [0.5, 0.5], [-1, 2])],
    hz: [hazard('sun', [0.3, -0.2])],
    sp: [0.2, 0.4],
  });

  const between = (lo: number, hi: number, v: number) =>
    v >= Math.min(lo, hi) - 1e-9 && v <= Math.max(lo, hi) + 1e-9;

  test('every interpolated field lies between the two bracketing snapshots, for every t', () => {
    for (let step = 0; step <= 20; step++) {
      const t = step / 20;
      const out = blendSnapshots(a, b, t);

      expect(between(a.tm, b.tm, out.tm)).toBe(true);

      for (let i = 0; i < out.pl.length; i++) {
        const oa = a.pl[i]!;
        const ob = b.pl[i]!;
        const os = out.pl[i]!;
        expect(between(oa.s, ob.s, os.s)).toBe(true);
      }

      for (let i = 0; i < out.hz.length; i++) {
        const oa = a.hz[i]!;
        const ob = b.hz[i]!;
        const oh = out.hz[i]!;
        expect(between(oa.p[0], ob.p[0], oh.p[0])).toBe(true);
        expect(between(oa.p[1], ob.p[1], oh.p[1])).toBe(true);
      }

      for (const ob of out.bl) {
        const oa = a.bl.find((x) => x.i === ob.i)!;
        const obb = b.bl.find((x) => x.i === ob.i)!;
        expect(between(oa.p[0], obb.p[0], ob.p[0])).toBe(true);
        expect(between(oa.p[1], obb.p[1], ob.p[1])).toBe(true);
        expect(between(oa.v[0], obb.v[0], ob.v[0])).toBe(true);
        expect(between(oa.v[1], obb.v[1], ob.v[1])).toBe(true);
      }

      if (out.sp) {
        expect(between(a.sp![0], b.sp![0], out.sp[0])).toBe(true);
        expect(between(a.sp![1], b.sp![1], out.sp[1])).toBe(true);
      }
    }
  });

  test('t <= 0 returns exactly a, t >= 1 returns exactly b', () => {
    expect(blendSnapshots(a, b, 0)).toEqual(a);
    expect(blendSnapshots(a, b, 1)).toEqual(b);
    expect(blendSnapshots(a, b, -5)).toEqual(a);
    expect(blendSnapshots(a, b, 5)).toEqual(b);
  });

  test('a null second snapshot holds a', () => {
    expect(blendSnapshots(a, null, 0.5)).toBe(a);
  });
});

// ------------------------------------------------------------ ball identity

describe('blendSnapshots: ball identity', () => {
  test('a ball reordered in the array (split/goal) is tracked by id, not index', () => {
    // Ball 1 sits far left, ball 2 sits far right in `a`. Between `a` and
    // `b`, a split-then-goal reorders the array so ball 2 now comes first —
    // and ball 2 barely moved, while ball 1 shot across the arena to a
    // symmetric position. Index matching would blend "index 0" (ball 1 in a,
    // ball 2 in b) into a single object that jumps from ball 1's position
    // toward ball 2's — a visible teleport neither ball ever made.
    const a = snap({
      bl: [ball(1, [-0.9, 0]), ball(2, [0.9, 0])],
    });
    const b = snap({
      bl: [ball(2, [0.91, 0.01]), ball(1, [-0.91, -0.01])], // reordered, barely moved
    });

    const out = blendSnapshots(a, b, 0.5);
    const b1 = out.bl.find((x) => x.i === 1)!;
    const b2 = out.bl.find((x) => x.i === 2)!;

    // Correct (id-matched) result: each ball barely moves from its own start.
    expect(b1.p[0]).toBeCloseTo(-0.905, 5);
    expect(b2.p[0]).toBeCloseTo(0.905, 5);

    // What index matching would have produced instead: index 0 blends
    // a.bl[0] (ball 1 @ -0.9) with b.bl[0] (ball 2 @ 0.91) — a huge jump.
    const indexMatchedWrong = a.bl[0]!.p[0] + (b.bl[0]!.p[0] - a.bl[0]!.p[0]) * 0.5;
    expect(indexMatchedWrong).toBeCloseTo(0.005, 5);

    // The real output must NOT match the index-matched result for either ball.
    expect(b1.p[0]).not.toBeCloseTo(indexMatchedWrong, 2);
    expect(b2.p[0]).not.toBeCloseTo(indexMatchedWrong, 2);
  });

  test('a ball present only in a (consumed) is held at its last position', () => {
    const a = snap({ bl: [ball(1, [0, 0]), ball(2, [0.5, 0.5])] });
    const b = snap({ bl: [ball(1, [0.2, 0.2])] }); // ball 2 consumed
    const out = blendSnapshots(a, b, 0.5);
    expect(out.bl.length).toBe(2);
    const held = out.bl.find((x) => x.i === 2)!;
    expect(held.p).toEqual([0.5, 0.5]);
  });
});

// -------------------------------------------------------------- comparable

describe('blendSnapshots: shape mismatches hold the earlier snapshot', () => {
  const a = snap({ rd: 1, tm: 5, pl: [player(0, 0.1), player(1, 0.1)] });

  test('different round is not blended', () => {
    const b = snap({ rd: 2, tm: 3, pl: [player(0, 0.9), player(1, 0.9)] });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });

  test('different alive set is not blended', () => {
    const b = snap({ pl: [player(0, 0.9, 3, 0), player(1, 0.9)] });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });

  test('different life count is not blended', () => {
    const b = snap({ pl: [player(0, 0.9, 2), player(1, 0.9)] });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });

  test('different hazard count is not blended', () => {
    const b = snap({ hz: [hazard('sun', [0, 0])] });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });

  test('different ball count is not blended', () => {
    const b = snap({ bl: [ball(1, [0, 0]), ball(2, [1, 1])] });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });

  test('different phase is not blended', () => {
    const b = snap({ ph: 'question' });
    const out = blendSnapshots(a, b, 0.5);
    expect(out).toEqual(a);
  });
});

// ---------------------------------------------------------------- playback

describe('SnapshotStream playback', () => {
  test('resyncs with a jump after a large gap instead of easing forever', () => {
    const stream = new SnapshotStream();
    // Establish a steady 1/30s cadence so `interval` settles near real value.
    let t = 0;
    for (let i = 0; i < 10; i++) {
      t += 1 / 30;
      stream.push(t, snap({ tm: t }));
      stream.advance(1 / 30);
    }
    const beforeGapPlayback = stream.advance(1 / 30);
    expect(beforeGapPlayback).not.toBeNull();

    // Chromebook sleeps for 30 seconds, then a fresh snapshot lands far ahead.
    t += 30;
    stream.push(t, snap({ tm: t }));

    const out = stream.advance(1 / 60); // one normal frame's worth of dt
    expect(out).not.toBeNull();
    // A crawl at followRate would move playback by roughly err*followRate*dt
    // — a few thousandths of a second, tops. A resync jump instead covers
    // nearly the entire 30s gap in this single frame.
    expect(out!.tm - beforeGapPlayback!.tm).toBeGreaterThan(25);
    expect(out!.tm).toBeLessThanOrEqual(t);
    expect(out!.tm).toBeGreaterThan(t - 1); // within one snapshot's delay of latest
  });

  test('holds the newest snapshot when starved, never runs past it', () => {
    const stream = new SnapshotStream();
    stream.push(1 / 30, snap({ tm: 1 }));
    stream.push(2 / 30, snap({ tm: 2 }));
    for (let i = 0; i < 50; i++) stream.advance(1 / 30);
    const out = stream.advance(1 / 30);
    expect(out).not.toBeNull();
    expect(out!.tm).toBeLessThanOrEqual(2);
  });

  test('reset clears buffered history', () => {
    const stream = new SnapshotStream();
    stream.push(1 / 30, snap());
    stream.push(2 / 30, snap());
    stream.reset();
    expect(stream.advance(1 / 30)).toBeNull();
    expect(stream.newest).toBeNull();
  });
});

// ----------------------------------------------------------------- predict

describe('PaddlePredictor', () => {
  const range = { speed: 1.5, min: 0, max: 1 };

  test('an input moves the local paddle on the very next frame', () => {
    const p = new PaddlePredictor();
    p.onAuthoritative(0.5, 0, range);
    p.setDir(1, 0);
    const moved = p.predict(0.1, range)!;
    expect(moved).toBeCloseTo(0.5 + 1.5 * 0.1, 5);
  });

  test('an authoritative update that agrees with prediction produces no visible correction', () => {
    const p = new PaddlePredictor();
    p.onAuthoritative(0.5, 0, range);
    p.setDir(1, 0);
    const predictedAt02 = p.predict(0.2, range)!;

    // Server confirms exactly what we predicted for t=0.2.
    p.onAuthoritative(predictedAt02, 0.2, range);
    const justAfter = p.predict(0.2, range)!;
    expect(justAfter).toBeCloseTo(predictedAt02, 6);
  });

  test('an authoritative update that disagrees converges within a bounded number of frames', () => {
    const p = new PaddlePredictor();
    p.onAuthoritative(0.5, 0, range);
    p.setDir(1, 0);

    const now = 0.2;
    const predicted = p.predict(now, range)!;
    const serverSays = predicted - 0.05; // small disagreement, e.g. dropped input
    p.onAuthoritative(serverSays, now, range);

    // Immediately after the correction lands, the displayed value should
    // still be close to what was on screen a moment ago (eased), not
    // snapped straight to serverSays.
    const justAfter = p.predict(now, range)!;
    expect(Math.abs(justAfter - predicted)).toBeLessThan(0.05);
    expect(Math.abs(justAfter - serverSays)).toBeGreaterThan(0);

    // Advance a bounded number of frames (10, at 60Hz — well inside the
    // reconcileRate time constant) and require convergence to near the raw
    // (uncorrected) replay value, clamped to the paddle's legal span exactly
    // as predict() itself clamps.
    const dt = 1 / 60;
    let last = justAfter;
    let t = now;
    for (let frame = 0; frame < 10; frame++) {
      t += dt;
      last = p.predict(t, range)!;
    }
    const rawFinal = Math.min(range.max, Math.max(range.min, serverSays + 1.5 * (t - now)));
    expect(Math.abs(last - rawFinal)).toBeLessThan(1e-2);
  });

  test('a correction larger than the resync threshold snaps instead of easing', () => {
    const p = new PaddlePredictor();
    p.onAuthoritative(0.9, 0, range);
    const before = p.predict(0, range)!;
    expect(before).toBeCloseTo(0.9, 5);

    // A reseat-sized jump: nowhere near the previous prediction.
    p.onAuthoritative(0.05, 0, range);
    const after = p.predict(0, range)!;
    expect(after).toBeCloseTo(0.05, 5); // snapped, not eased from 0.9
  });

  test('reset forgets the anchor but keeps the currently held direction', () => {
    const p = new PaddlePredictor();
    p.onAuthoritative(0.5, 0, range);
    p.setDir(1, 0);
    p.reset();
    expect(p.predict(1, range)).toBeNull(); // no anchor: nothing to predict yet
    p.onAuthoritative(0.2, 1, range);
    // The held direction (1) should still be in force after the reset.
    const moved = p.predict(1.1, range)!;
    expect(moved).toBeCloseTo(0.2 + 1.5 * 0.1, 5);
  });
});
