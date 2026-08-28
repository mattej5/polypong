// Client-side prediction for the local player's own paddle. SPEC §10.2.
//
// Interpolation (interp.ts) buys smoothness by rendering the world slightly
// in the past. That is the right trade for everything you only watch, and
// the wrong trade for the one thing you are holding: your own paddle has to
// answer the key the moment you press it. So the local paddle is drawn on a
// different clock from the rest of the arena — predicted forward to now,
// while the ball and everyone else stay on the interpolated clock.
//
// This paddle is unusually friendly to prediction. It is one-dimensional, it
// moves at a fixed speed, it is clamped to a fixed span, and it depends on
// nothing in the world except this player's own input. There is no other
// actor that can push it, so the client and the server can only disagree
// about input timing, never about outcome.
//
// The replayed part is exact, not smoothed: every frame re-derives the
// paddle from the newest RAW authoritative snapshot (never the interpolated
// one — the anchor wants to be as fresh as possible) by replaying the local
// input log forward from the instant that value arrived. Anchoring on the
// newest server state every frame means prediction error cannot accumulate —
// a dropped input costs one snapshot of divergence, not a permanent offset.
//
// On top of that exact replay sits one more thing: a small decaying
// correction, captured the instant a new anchor arrives, equal to the gap
// between what was on screen and what the fresh replay now says. It decays
// to zero over a fraction of a second. That is the "ease onto the server
// value" behaviour: the numbers you replay from are exact immediately (so a
// keypress still moves the paddle on the very next frame), but a visible
// jump caused by the anchor itself updating is smoothed out instead of
// snapping every time a snapshot lands. A correction bigger than the resync
// threshold is not eased — same reasoning as interp.ts's playback clock: a
// gap that big is a reconnect or a reseat, not jitter, and crawling toward it
// would just be visibly wrong for longer.
//
// Positions here are edge fractions (0..1 along the player's own wall), the
// same unit the wire uses (SnapPlayer.s), so nothing in this file depends on
// screen size. Pure arithmetic: no DOM, no timers, no Date.now, no
// performance.now — the caller supplies `now`, in local seconds.

export type Dir = -1 | 0 | 1;

export interface PredictRange {
  speed: number; // edge-lengths per second, matches T.paddleSpeed
  min?: number;
  max?: number;
}

export interface PaddlePredictorOptions {
  /** Correction decay rate, per second (time constant = 1 / reconcileRate). */
  reconcileRate: number;
  /** A correction bigger than this (edge fraction) snaps instead of easing. */
  resyncThreshold: number;
  /** Cap on retained input log entries, so a long session can't leak memory. */
  maxLog: number;
}

const DEFAULTS: PaddlePredictorOptions = {
  reconcileRate: 10,
  resyncThreshold: 0.2,
  maxLog: 256,
};

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

interface LogEntry {
  t: number;
  dir: Dir;
}

export class PaddlePredictor {
  private readonly opt: PaddlePredictorOptions;
  private dir: Dir = 0;
  private log: LogEntry[] = [];
  private auth: { frac: number; t: number } | null = null;
  private correction = 0;
  private correctionAt = 0;

  constructor(opts: Partial<PaddlePredictorOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opts };
  }

  /** Record an input direction change. `now` is local seconds. Returns whether it changed. */
  setDir(dir: Dir, now: number): boolean {
    if (dir === this.dir) return false;
    this.dir = dir;
    this.log.push({ t: now, dir });
    if (this.log.length > this.opt.maxLog) this.log.splice(0, this.log.length - this.opt.maxLog);
    return true;
  }

  /**
   * Adopt a new authoritative paddle fraction. Call this with the value from
   * the newest *raw* snapshot, not the interpolated one.
   */
  onAuthoritative(frac: number, now: number, range: PredictRange): void {
    const min = range.min ?? 0;
    const max = range.max ?? 1;
    const clampedFrac = clamp(frac, min, max);

    // What we were showing, under the OLD anchor, at the instant the new one
    // arrives — this is the baseline the correction is measured against.
    const prevDisplayed = this.auth ? (this.predict(now, range) ?? clampedFrac) : clampedFrac;

    this.auth = { frac: clampedFrac, t: now };
    // Keep the entry that defines dir at the anchor, drop everything older:
    // it can no longer affect any future replay.
    let keep = 0;
    for (let i = 0; i < this.log.length; i++) {
      const e = this.log[i];
      if (e && e.t <= now) keep = i;
    }
    if (keep > 0) this.log.splice(0, keep);

    const gap = prevDisplayed - clampedFrac;
    this.correction = Math.abs(gap) > this.opt.resyncThreshold ? 0 : gap;
    this.correctionAt = now;
  }

  /** Forget the anchor without forgetting which key is currently held. */
  reset(): void {
    this.auth = null;
    this.log = this.dir === 0 ? [] : [{ t: 0, dir: this.dir }];
    this.correction = 0;
    this.correctionAt = 0;
  }

  /** Exact anchor-plus-replay value, with no correction easing applied. */
  private rawPredict(now: number, range: PredictRange): number | null {
    const min = range.min ?? 0;
    const max = range.max ?? 1;
    if (!this.auth) return null;
    let f = this.auth.frac;
    let t = this.auth.t;
    if (now <= t) return clamp(f, min, max);

    // dir in force at the anchor: the last log entry at or before it, else
    // whatever is currently held.
    let dir: Dir = this.dir;
    for (const e of this.log) {
      if (e.t <= t) dir = e.dir;
      else break;
    }

    for (const e of this.log) {
      if (e.t <= t) continue;
      const until = Math.min(e.t, now);
      f = clamp(f + dir * range.speed * (until - t), min, max);
      t = until;
      dir = e.dir;
      if (t >= now) break;
    }
    if (t < now) f = clamp(f + dir * range.speed * (now - t), min, max);
    return f;
  }

  /**
   * The fraction to draw this frame: the exact replay, plus whatever is left
   * of the decaying correction from the last anchor update. `range.speed`
   * must match T.paddleSpeed so the integral is in the same units as the
   * anchor.
   */
  predict(now: number, range: PredictRange): number | null {
    const raw = this.rawPredict(now, range);
    if (raw === null) return null;
    if (this.correction === 0) return raw;
    const min = range.min ?? 0;
    const max = range.max ?? 1;
    const elapsed = Math.max(0, now - this.correctionAt);
    const decayed = this.correction * Math.exp(-this.opt.reconcileRate * elapsed);
    return clamp(raw + decayed, min, max);
  }
}
