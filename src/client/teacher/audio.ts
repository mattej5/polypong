// Audio, teacher screen only (SPEC §6, §9). Student devices stay silent on
// purpose: 25 beeping Chromebooks is a classroom hazard, and the spec lists
// audio on student devices as a non-goal.
//
// Everything is synthesised with WebAudio. There are no audio files, so
// nothing has to be embedded in the compiled binary and nothing is fetched at
// runtime from a machine that may have no route off the LAN.
//
// Browsers refuse to start an AudioContext until a user gesture. That refusal
// is normal, not an error: `arm()` is called from the first click anywhere on
// the page and every failure path here is swallowed, because a teacher
// standing in front of a class must never see a console full of red for a
// sound effect.

const MASTER = 0.32;

/** A paddle hit can happen several times in one snapshot interval when balls
 *  have split. Past this, extra blips are dropped rather than stacked. */
const HIT_MIN_GAP = 0.045;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private blocked = false;
  private lastHit = -1;

  muted = false;

  /** Call from a real user gesture. Safe to call repeatedly. */
  arm(): void {
    if (this.blocked) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        const g = this.ctx.createGain();
        g.gain.value = MASTER;
        g.connect(this.ctx.destination);
        this.master = g;
      } catch {
        // No WebAudio at all. Silence is a fine degradation; stop trying.
        this.blocked = true;
        return;
      }
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  get ready(): boolean {
    return this.ctx !== null && !this.blocked;
  }

  private voice(): { ctx: AudioContext; out: GainNode; t: number } | null {
    if (this.muted || this.blocked) return null;
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out || ctx.state !== 'running') return null;
    return { ctx, out, t: ctx.currentTime };
  }

  /**
   * One oscillator with a linear frequency sweep and an exponential amplitude
   * decay. Every sound on this page is this function with different numbers,
   * which keeps them recognisably one family.
   */
  private blip(
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    gain: number,
    delay = 0,
  ): void {
    const v = this.voice();
    if (!v) return;
    try {
      const t0 = v.t + delay;
      const osc = v.ctx.createOscillator();
      const amp = v.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, t0);
      osc.frequency.linearRampToValueAtTime(to, t0 + dur);
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
      amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(amp);
      amp.connect(v.out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      // A context torn down mid-call (tab suspend) throws here. Not worth a word.
    }
  }

  /** Paddle contact. Short, bright, and cheap enough to fire seven times. */
  hit(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastHit < HIT_MIN_GAP) return;
    this.lastHit = now;
    this.blip('square', 720, 400, 0.05, 0.18);
  }

  /** A life lost, but the player is still in. Deliberately duller than `out`. */
  concede(): void {
    this.blip('triangle', 300, 150, 0.16, 0.2);
  }

  /** Somebody is gone. The one sound in the room that falls all the way down. */
  out(): void {
    this.blip('sawtooth', 340, 62, 0.5, 0.22);
    this.blip('square', 170, 48, 0.42, 0.1, 0.02);
  }

  /** A question is on screen: two notes, so it reads as "look up", not "error". */
  chime(): void {
    this.blip('sine', 880, 880, 0.34, 0.24);
    this.blip('sine', 1318.5, 1318.5, 0.5, 0.2, 0.12);
  }
}
