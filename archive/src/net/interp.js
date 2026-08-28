// Snapshot interpolation for replica clients.
//
// The client keeps a short buffer of snapshots and renders the world at
// `playback`, a clock that deliberately trails the newest server timestamp by a
// small delay. Every rendered frame is a blend of the two real snapshots that
// straddle that instant. Nothing is ever extrapolated: a position the server
// never produced is never drawn.
//
// That property is the whole point, and it is what stops the ball passing
// through a paddle. Both endpoints of a blend are states the server actually
// simulated, so both sit in front of the paddle plane; the arena is convex, so
// every point on the straight segment between them sits in front of it too.
// Extrapolation has no such property — it advances the ball on its last known
// velocity with no collision at all — which is why it cannot be repaired by
// clamping and is replaced outright.
//
// Everything here is arithmetic over the wire format, in arena units. No DOM,
// no timers, no Date.now: the caller supplies dt. That keeps it testable under
// bare Node and keeps the timing state on the client, where it belongs.

const DEFAULTS = {
  delayFactor: 2,        // trail the newest snapshot by this many intervals
  minDelay: 0.045,
  maxDelay: 0.250,
  maxBuffer: 60,
  resyncThreshold: 0.5,  // seconds of error past which we jump instead of ease
  followRate: 3.0,       // how hard playback is eased onto its target, per second
};

const lerp = (a, b, t) => a + (b - a) * t;
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * True when two snapshots describe the same world *shape* and may therefore be
 * blended. When they do not — a player was eliminated, a serve happened, a
 * hazard landed — there is no meaningful in-between state, so the caller holds
 * the earlier snapshot until playback crosses into the next pair. Blending
 * across one of these would teleport things through the arena.
 */
function comparable(a, b) {
  if (a.st !== b.st) return false;
  if (a.rd !== b.rd) return false;                 // new serve: ball teleports to centre
  if (a.pl.length !== b.pl.length) return false;
  if (a.hz.length !== b.hz.length) return false;
  if (a.pd.length !== b.pd.length) return false;
  for (let i = 0; i < a.pl.length; i++) {
    if (a.pl[i].a !== b.pl[i].a) return false;     // alive set changed -> arena rebuilt
    if (a.pl[i].l !== b.pl[i].l) return false;     // a life dropped: keep the event crisp
  }
  return true;
}

/** Index balls by their wire id so a split or a goal cannot cross-match them. */
function ballsById(list) {
  const m = new Map();
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    m.set(b.i === undefined ? `x${i}` : b.i, b);
  }
  return m;
}

/**
 * Blend two straddling snapshots. Continuous quantities are interpolated;
 * discrete ones (state, lives, names, who is placing) always come from `a`, the
 * snapshot playback has actually reached, so an event is never shown early.
 */
export function blendSnapshots(a, b, t) {
  if (!b || t <= 0) return a;
  if (t >= 1) return b;
  if (!comparable(a, b)) return a;

  const out = {
    st: a.st,
    tm: lerp(a.tm, b.tm, t),
    rd: a.rd,
    bn: a.bn,
    pl: a.pl.map((q, i) => ({ ...q, s: lerp(q.s, b.pl[i].s, t) })),
    hz: a.hz.map((h, i) => ({ ...h, p: lerp2(h.p, b.hz[i].p, t) })),
    sp: a.sp && b.sp ? lerp2(a.sp, b.sp, t) : a.sp,
    pd: a.pd,
    gh: a.gh && b.gh ? lerp2(a.gh, b.gh, t) : a.gh,
    wn: a.wn,
    bl: [],
  };

  // A ball is drawn only while both endpoints exist. One that appears in `b`
  // alone has not been served yet at this instant; one that survives only in
  // `a` was consumed, and holding it at its last real position for the rest of
  // the pair is closer to the truth than inventing a path for it.
  const nextBalls = ballsById(b.bl);
  for (let i = 0; i < a.bl.length; i++) {
    const ba = a.bl[i];
    const bb = nextBalls.get(ba.i === undefined ? `x${i}` : ba.i);
    if (!bb) { out.bl.push(ba); continue; }
    out.bl.push({
      i: ba.i,
      p: lerp2(ba.p, bb.p, t),
      v: lerp2(ba.v, bb.v, t),
      h: ba.h,
    });
  }
  return out;
}

export class SnapshotStream {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.opt = o;
    this.buf = [];            // [{ t: serverSeconds, s: snapshot }], ascending
    this.playback = null;     // render clock, in server seconds
    this.interval = 1 / 20;   // measured snapshot spacing
    this.latest = null;       // newest server timestamp seen
    this.latestSnap = null;   // newest raw snapshot (prediction anchors on this)
    this.starved = false;     // playback ran past the newest snapshot
  }

  get delay() {
    const o = this.opt;
    return Math.min(o.maxDelay, Math.max(o.minDelay, this.interval * o.delayFactor));
  }

  /**
   * `serverTime` is the room's own accumulated simulation clock, not a local
   * reading. Using the server's timeline instead of local arrival times keeps
   * network jitter out of the render clock: a snapshot that arrives 8ms late
   * still describes the instant it always described.
   */
  push(serverTime, snap) {
    if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) {
      // A server too old to stamp its snapshots: synthesise a timeline from the
      // measured interval so the client still interpolates rather than steps.
      serverTime = this.latest === null ? 0 : this.latest + this.interval;
    }
    // A clock that jumped backwards is a different server, not a late packet:
    // restart the room mid-lesson and this is the only thing standing between
    // the class and a permanently frozen projector.
    if (this.latest !== null && serverTime < this.latest - 1) this.reset();
    if (this.latest !== null && serverTime <= this.latest) return;  // stale / reordered

    if (this.latest !== null) {
      const gap = serverTime - this.latest;
      if (gap > 0 && gap < 1) this.interval = this.interval * 0.85 + gap * 0.15;
    }
    this.latest = serverTime;
    this.latestSnap = snap;
    this.buf.push({ t: serverTime, s: snap });
    if (this.buf.length > this.opt.maxBuffer) this.buf.splice(0, this.buf.length - this.opt.maxBuffer);
  }

  /** A hard cut — a reset, a reconnect — where easing the clock would be wrong. */
  reset() {
    this.buf.length = 0;
    this.playback = null;
    this.latest = null;
    this.latestSnap = null;
  }

  /**
   * Advance the render clock by one frame and return the world to draw, or null
   * while there is not yet enough history to interpolate inside.
   */
  advance(dt) {
    if (this.buf.length === 0) return null;
    const o = this.opt;
    const target = this.latest - this.delay;

    if (this.playback === null) {
      if (this.buf.length < 2) return null;
      this.playback = target;
    } else {
      this.playback += dt;
      const err = target - this.playback;
      if (Math.abs(err) > o.resyncThreshold) this.playback = target;
      else this.playback += err * Math.min(1, dt * o.followRate);
    }

    // Never run off either end of the buffer. Past the newest snapshot the
    // honest thing to draw is the newest snapshot, held still: a frozen ball
    // reads as a hitch, a ball that keeps flying through a wall reads as a bug.
    const first = this.buf[0], last = this.buf[this.buf.length - 1];
    if (this.playback < first.t) this.playback = first.t;
    this.starved = this.playback >= last.t;
    if (this.starved) this.playback = last.t;

    // Drop history the clock has already passed, keeping the straddling pair.
    while (this.buf.length > 2 && this.buf[1].t <= this.playback) this.buf.shift();

    let i = 0;
    while (i < this.buf.length - 2 && this.buf[i + 1].t <= this.playback) i++;
    const a = this.buf[i], b = this.buf[i + 1];
    if (!b) return a.s;

    const span = b.t - a.t;
    const t = span > 1e-9 ? (this.playback - a.t) / span : 0;
    return blendSnapshots(a.s, b.s, t < 0 ? 0 : t > 1 ? 1 : t);
  }
}
