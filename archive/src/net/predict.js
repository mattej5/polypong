// Client-side prediction for the local player's own paddle.
//
// Interpolation buys smoothness by rendering the world slightly in the past.
// That is the right trade for everything you only watch, and the wrong trade
// for the one thing you are holding: your own paddle has to answer the key the
// moment you press it. So the local paddle is drawn on a different clock from
// the rest of the arena — predicted forward to now, while the ball and everyone
// else stay on the interpolated clock.
//
// This paddle is unusually friendly to prediction. It is one-dimensional, it
// moves at a fixed speed, it is clamped to a fixed span, and it depends on
// nothing in the world except this player's own input. There is no other actor
// that can push it, so the client and the server can only disagree about input
// timing, never about outcome — prediction here cannot fight the server the way
// a predicted physics body would.
//
// Reconciliation is exact rather than approximate: rather than smoothing toward
// the server, every frame re-derives the paddle from the newest authoritative
// value by replaying the local input log forward from the instant that value
// arrived. Anchoring on the newest server state every frame means prediction
// error cannot accumulate — a dropped input costs one snapshot of divergence,
// not a permanent offset.
//
// Positions here are edge fractions (0..1 along the player's own wall), the
// same unit the wire uses, so nothing in this file depends on screen size.

export class PaddlePredictor {
  constructor() {
    this.dir = 0;
    this.log = [];        // [{ t, dir }] local seconds, "dir became this at t"
    this.auth = null;     // { frac, t } newest server value + local arrival time
    this.enabled = true;
  }

  /** Record an input change. `now` is local seconds (performance.now()/1000). */
  setDir(dir, now) {
    const d = dir < 0 ? -1 : dir > 0 ? 1 : 0;
    if (d === this.dir) return false;
    this.dir = d;
    this.log.push({ t: now, dir: d });
    if (this.log.length > 256) this.log.splice(0, this.log.length - 256);
    return true;
  }

  /**
   * Adopt a new authoritative paddle fraction. Call this with the value from
   * the newest *raw* snapshot, not the interpolated one: the anchor has to be
   * as fresh as possible, since everything after it is replayed locally.
   */
  onAuthoritative(frac, now) {
    this.auth = { frac, t: now };
    // Keep the entry that defines dir at the anchor, drop everything older.
    let keep = 0;
    for (let i = 0; i < this.log.length; i++) if (this.log[i].t <= now) keep = i;
    if (keep > 0) this.log.splice(0, keep);
  }

  /** Forget the anchor without forgetting which key is currently held. */
  reset() {
    this.auth = null;
    this.log = this.dir === 0 ? [] : [{ t: 0, dir: this.dir }];
  }

  /**
   * The fraction to draw this frame: the anchor, replayed forward through the
   * input log. `speed` is edge-lengths per second, matching T.paddleSpeed, so
   * the integral is in the same units as the anchor.
   */
  predict(now, { speed, min = 0, max = 1 }) {
    if (!this.auth) return null;
    let f = this.auth.frac;
    let t = this.auth.t;
    if (now <= t) return Math.min(max, Math.max(min, f));

    // dir in force at the anchor: the last entry at or before it, else current.
    let dir = this.dir;
    for (let i = 0; i < this.log.length; i++) {
      if (this.log[i].t <= t) dir = this.log[i].dir;
      else break;
    }

    for (const e of this.log) {
      if (e.t <= t) continue;
      const until = Math.min(e.t, now);
      f = Math.min(max, Math.max(min, f + dir * speed * (until - t)));
      t = until;
      dir = e.dir;
      if (t >= now) break;
    }
    if (t < now) f = Math.min(max, Math.max(min, f + dir * speed * (now - t)));
    return f;
  }
}
