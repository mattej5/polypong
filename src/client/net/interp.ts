// Snapshot interpolation for replica clients. SPEC §10.2, I7.
//
// The client keeps a short buffer of snapshots, stamped with the server's own
// accumulated simulation clock (the `c` field of the `snap` message, NOT a
// wall-clock arrival time), and renders the world at `playback`: a clock that
// deliberately trails the newest server timestamp by a small delay. Every
// rendered frame is a blend of the two real snapshots that straddle that
// instant. Nothing is ever extrapolated: a position the server never produced
// is never drawn.
//
// That property is the whole point, and it is what stops the ball passing
// through a paddle (I7). Both endpoints of a blend are states the server
// actually simulated, so both sit in front of the paddle plane; the arena is
// convex, so every point on the straight segment between them sits in front
// of it too. Extrapolation has no such property — it advances the ball on its
// last known velocity with no collision at all — which is why it cannot be
// repaired by clamping and must not be added, including in the "ease the
// playback clock toward its target" path below: that path eases a scalar
// clock, never a position, so it never manufactures a ball position the
// server did not.
//
// Everything here is arithmetic over the wire format, in arena units. No DOM,
// no timers, no Date.now, no performance.now: the caller supplies dt. That
// keeps this testable under bare `bun test` and keeps the timing state on the
// client, where it belongs.

import type { Snapshot, SnapBall, SnapPlayer, SnapHazard } from '../../shared/protocol';

export interface SnapshotStreamOptions {
  /** Trail the newest snapshot by this many measured snapshot intervals. */
  delayFactor: number;
  minDelay: number;
  maxDelay: number;
  maxBuffer: number;
  /** Seconds of playback error past which we jump instead of ease. */
  resyncThreshold: number;
  /** How hard playback is eased onto its target, per second. */
  followRate: number;
}

const DEFAULTS: SnapshotStreamOptions = {
  delayFactor: 2,
  minDelay: 0.045,
  maxDelay: 0.25,
  maxBuffer: 60,
  resyncThreshold: 0.5,
  followRate: 3.0,
};

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp2 = (a: [number, number], b: [number, number], t: number): [number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/**
 * True when two snapshots describe the same world *shape* and may therefore
 * be blended. When they do not — a serve happened, a player was eliminated, a
 * hazard spawned or a ball split/scored — there is no meaningful in-between
 * state, so the caller holds the earlier snapshot until playback crosses into
 * the next pair. Blending across one of these would teleport things through
 * the arena.
 *
 * Checks, in order: phase, round (a new serve teleports the ball to centre),
 * player count, each seat's alive flag and life count (an elimination or a
 * life loss is a discrete event, never a blend), hazard count, and ball count
 * (a split or a goal changes how many balls exist — the id-matching below
 * handles *which* ball is which, but a changed count is itself a shape
 * change, same as the old build's `pd`-length check).
 */
function comparable(a: Snapshot, b: Snapshot): boolean {
  if (a.ph !== b.ph) return false;
  if (a.rd !== b.rd) return false;
  if (a.pl.length !== b.pl.length) return false;
  if (a.hz.length !== b.hz.length) return false;
  if (a.bl.length !== b.bl.length) return false;
  for (let i = 0; i < a.pl.length; i++) {
    const pa = a.pl[i];
    const pb = b.pl[i];
    if (!pa || !pb) return false;
    if (pa.a !== pb.a) return false;
    if (pa.l !== pb.l) return false;
  }
  return true;
}

/** Index balls by their wire id so a split or a goal cannot cross-match them. */
function ballsById(list: readonly SnapBall[]): Map<number, SnapBall> {
  const m = new Map<number, SnapBall>();
  for (const b of list) m.set(b.i, b);
  return m;
}

/**
 * Blend two straddling snapshots. Continuous quantities are interpolated;
 * discrete ones (phase, round, banner, names, winner) always come from `a`,
 * the snapshot playback has actually reached, so an event is never shown
 * early.
 */
export function blendSnapshots(a: Snapshot, b: Snapshot | null, t: number): Snapshot {
  if (!b || t <= 0) return a;
  if (t >= 1) return b;
  if (!comparable(a, b)) return a;

  const tc = clamp01(t);

  const pl: SnapPlayer[] = a.pl.map((pa, i) => {
    const pb = b.pl[i];
    return pb ? { ...pa, s: lerp(pa.s, pb.s, tc) } : pa;
  });

  const hz: SnapHazard[] = a.hz.map((ha, i) => {
    const hb = b.hz[i];
    return hb ? { ...ha, p: lerp2(ha.p, hb.p, tc) } : ha;
  });

  // A ball is drawn only while both endpoints exist under its own id. One
  // that appears in `b` alone has not been produced yet at this instant; one
  // that survives only in `a` was consumed (absorbed, scored), and holding it
  // at its last real position for the rest of the pair is closer to the
  // truth than inventing a path for it.
  const nextBalls = ballsById(b.bl);
  const bl: SnapBall[] = a.bl.map((ba) => {
    const bb = nextBalls.get(ba.i);
    if (!bb) return ba;
    return { i: ba.i, p: lerp2(ba.p, bb.p, tc), v: lerp2(ba.v, bb.v, tc), h: ba.h };
  });

  return {
    ph: a.ph,
    tm: lerp(a.tm, b.tm, tc),
    rd: a.rd,
    bn: a.bn,
    pl,
    bl,
    hz,
    sp: a.sp && b.sp ? lerp2(a.sp, b.sp, tc) : a.sp,
    wn: a.wn,
  };
}

interface BufEntry {
  t: number;
  s: Snapshot;
}

export class SnapshotStream {
  private readonly opt: SnapshotStreamOptions;
  private buf: BufEntry[] = [];
  private playback: number | null = null;
  private interval = 1 / 20;
  private latest: number | null = null;
  private latestSnap: Snapshot | null = null;
  private starvedFlag = false;

  constructor(opts: Partial<SnapshotStreamOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opts };
  }

  private get delay(): number {
    const o = this.opt;
    return Math.min(o.maxDelay, Math.max(o.minDelay, this.interval * o.delayFactor));
  }

  /** True once playback has caught up to (or run past) the newest snapshot. */
  get starved(): boolean {
    return this.starvedFlag;
  }

  /** The newest RAW snapshot seen, for paddle prediction to anchor on (predict.ts). */
  get newest(): Snapshot | null {
    return this.latestSnap;
  }

  /**
   * `serverTime` is the room's own accumulated simulation clock (the `c`
   * field of the `snap` message), not a local reading. Using the server's
   * timeline instead of local arrival times keeps network jitter out of the
   * render clock: a snapshot that arrives 8ms late still describes the
   * instant it always described.
   */
  push(serverTime: number, snap: Snapshot): void {
    // A clock that jumped backwards is a different server (restart), not a
    // late packet: without this, a mid-lesson server restart leaves the
    // client interpolating toward a timeline that will never arrive again.
    if (this.latest !== null && serverTime < this.latest - 1) this.reset();
    if (this.latest !== null && serverTime <= this.latest) return; // stale / reordered

    if (this.latest !== null) {
      const gap = serverTime - this.latest;
      if (gap > 0 && gap < 1) this.interval = this.interval * 0.85 + gap * 0.15;
    }
    this.latest = serverTime;
    this.latestSnap = snap;
    this.buf.push({ t: serverTime, s: snap });
    if (this.buf.length > this.opt.maxBuffer) this.buf.splice(0, this.buf.length - this.opt.maxBuffer);
  }

  /** A hard cut — a reconnect — where easing the clock would be wrong. */
  reset(): void {
    this.buf = [];
    this.playback = null;
    this.latest = null;
    this.latestSnap = null;
    this.starvedFlag = false;
  }

  /**
   * Advance the render clock by one frame and return the world to draw, or
   * null while there is not yet enough history to interpolate inside.
   */
  advance(dt: number): Snapshot | null {
    if (this.buf.length === 0 || this.latest === null) return null;
    const o = this.opt;
    const target = this.latest - this.delay;

    if (this.playback === null) {
      if (this.buf.length < 2) return null;
      this.playback = target;
    } else {
      this.playback += dt;
      const err = target - this.playback;
      // A Chromebook that slept for 30 seconds must snap onto the new target,
      // not crawl there at followRate over half a minute of wrong frames.
      if (Math.abs(err) > o.resyncThreshold) this.playback = target;
      else this.playback += err * Math.min(1, dt * o.followRate);
    }

    // Never run off either end of the buffer. Past the newest snapshot the
    // honest thing to draw is the newest snapshot, held still: a frozen ball
    // reads as a hitch, a ball that keeps flying through a wall reads as a
    // bug (I7).
    const first = this.buf[0];
    const last = this.buf[this.buf.length - 1];
    if (!first || !last) return null;
    if (this.playback < first.t) this.playback = first.t;
    this.starvedFlag = this.playback >= last.t;
    if (this.starvedFlag) this.playback = last.t;

    // Drop history the clock has already passed, keeping the straddling pair.
    while (this.buf.length > 2) {
      const second = this.buf[1];
      if (!second || second.t > this.playback) break;
      this.buf.shift();
    }

    let i = 0;
    while (i < this.buf.length - 2) {
      const next = this.buf[i + 1];
      if (!next || next.t > this.playback) break;
      i++;
    }
    const a = this.buf[i];
    const b = this.buf[i + 1];
    if (!a) return null;
    if (!b) return a.s;

    const span = b.t - a.t;
    const t = span > 1e-9 ? (this.playback - a.t) / span : 0;
    return blendSnapshots(a.s, b.s, clamp01(t));
  }
}
