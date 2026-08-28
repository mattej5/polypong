// The authoritative simulation.
//
// SPEC I13: this file knows nothing about questions, sockets, student names,
// revive budgets, or the phase machine. It owns balls, paddles, walls, hazards
// and lives, and nothing else. It exposes commands, it emits events, and
// `match.ts` orchestrates. If questions were deleted tomorrow, not a line here
// would change.
//
// SPEC I12: no runtime APIs. Randomness is injected as an Rng and threaded
// through every decision that needs it — serve angle, bot jitter, hazard
// placement, spark directions — so two Games with the same seed and the same
// inputs produce byte-identical snapshots.
//
// Everything is in ARENA UNITS. The centre is the origin and the circumradius
// is exactly 1, so T.ballRadius IS the ball's radius. The previous build
// simulated in a virtual 1000x1000 pixel space and converted at the wire; that
// conversion, its viewport, and its rescale-on-resize are gone.

import {
  add, clamp, dist, dot, len, mul, rot, sub,
  buildArena, type Arena, type Edge, type Vec,
} from '../geometry';
import { BOT_NAMES, COLORS, T, TIMING, type Rng } from '../config';
import type { Snapshot, SnapBall, SnapHazard, SnapPlayer, Phase } from '../protocol';
import { Paddle } from './paddle';
import { makeBall, pushTrail, type Ball } from './ball';
import { botInput, makeBotState, type BotState } from './ai';
import {
  applyFields, makeHazard, makeSplitter, randomHazardSpot, randomSplitterSpot,
  repositionHazards, splitterSurvives, type Hazard, type HazardKind, type Splitter,
} from './hazards';

// ------------------------------------------------------------------ tuning
// Constants with no gameplay meaning outside this file. Anything a designer
// would want to change lives in config.ts.

/** Extra push-out after a paddle hit so the same contact cannot register
 *  twice on consecutive sub-steps. ~0.5px at the old build's arena scale. */
const CONTACT_NUDGE = 0.002;

/** How far past the wall plane a ball must travel before it counts as a goal.
 *  Generous, so a graze that clips the paddle edge is a return, not a point. */
const GOAL_DEPTH = 2.5;

/** The speed clamp is applied a little above the nominal cap: spin and hazard
 *  pushes are allowed to overshoot momentarily rather than being ground down
 *  to the cap every sub-step, which flattened every return. */
const CAP_SLACK = 1.15;

/** Sub-step ceiling. Purely a runaway guard — at the stall-breaker's top speed
 *  the honest count is around ten. The old build capped this at 8, which meant
 *  a long rally quietly stopped honouring T.subStepMaxTravel, and SPEC I7 with
 *  it. */
const MAX_SUBSTEPS = 256;

/** Particles are cosmetic and unbounded input is not: a long match with many
 *  splits would otherwise grow this array forever. */
const MAX_PARTICLES = 500;

/** Ball centre must stay this far past the failsafe circle to be written off.
 *  A ball outside the arena entirely is a bug somewhere; charge it to the
 *  nearest goal rather than letting it vanish and stall the round. */
const ESCAPE_RADIUS = 1.8;

// ------------------------------------------------------------------- state

/** Seat hue. COLORS is shared tuning, not presentation code, so the sim may
 *  stamp a spark with its colour at the moment it is spawned — which is the
 *  only moment that knows whose collision it was. */
const seatColor = (seat: number): string => COLORS[seat % COLORS.length] ?? '#ffffff';

export interface Particle {
  p: Vec;
  v: Vec;
  life: number;
  max: number;
  color: string;
}

export interface GamePlayer {
  readonly seat: number;
  /** Opaque display string, passed through to the snapshot and never read by
   *  the sim. Match overrides it with the student's real name. */
  label: string;
  lives: number;
  alive: boolean;
  isBot: boolean;
  /** Wall this player defends, or null while eliminated. */
  edge: Edge | null;
  paddle: Paddle | null;
  /**
   * Last input, in the PLAYER'S OWN SCREEN FRAME. It is stored unconverted and
   * multiplied by edge.rightSign every tick (see updatePaddles). Storing the
   * converted value instead would go stale the moment the arena is rebuilt
   * under a held key, because the new wall can have the opposite sign.
   */
  screenDir: -1 | 0 | 1;
  bot: BotState;
}

export type GameEvent =
  /** A ball crossed this seat's wall. `cost` is 1, or T.hotCost for a hot ball. */
  | { t: 'conceded'; seat: number; cost: number; hot: boolean }
  /** Hit zero lives. The arena has already been rebuilt and a hazard placed. */
  | { t: 'eliminated'; seat: number }
  /** Every ball is off the table and an auto-serve is armed. Not emitted for
   *  an elimination — the owner gets `eliminated` and drives the restart. */
  | { t: 'roundEnded' }
  /** One or zero players left. `winner` is null on a draw. */
  | { t: 'matchOver'; winner: number | null };

/** Fields of the wire snapshot that belong to the phase machine, not the sim.
 *  Match passes them straight through; Game never interprets them. */
export interface SnapshotView {
  ph?: Phase;
  tm?: number;
  bn?: string;
}

const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const r3 = (n: number): number => Math.round(n * 1e3) / 1e3;

export class Game {
  readonly rng: Rng;

  players: GamePlayer[] = [];
  balls: Ball[] = [];
  hazards: Hazard[] = [];
  particles: Particle[] = [];
  splitter: Splitter | null = null;
  arena: Arena = buildArena(2);

  /** Increments on every serve. Two snapshots with different rounds are never
   *  blended by a client, because the ball teleports to the centre. */
  round = 0;
  eliminations = 0;
  /** 0..1, decaying. The renderer reads it; Game never draws. */
  shake = 0;
  winner: number | null = null;
  over = false;

  /** True on clients. A replica renders what it is told and never simulates. */
  replica = false;

  private started = false;
  private running = false;
  private roundTime = 0;
  /** > 0 while counting down to an automatic serve after a conceded point. */
  private serveTimer = 0;
  /**
   * Set when an elimination clears the table. The arena has changed shape, so
   * the next ball is not the sim's to decide: the owner runs its 3-2-1 and
   * calls serve(). This is the whole of Game's "waiting" behaviour and it
   * waits on a command, never on a clock it does not own.
   */
  private serveHeld = false;
  private nextId = 1;
  private events: GameEvent[] = [];

  constructor(rng: Rng) {
    this.rng = rng;
  }

  // ---------------------------------------------------------------- lifecycle

  start(playerCount: number, lives: number, isBot: readonly boolean[]): void {
    const n = Math.max(2, Math.min(playerCount, 8));
    this.players = [];
    for (let i = 0; i < n; i++) {
      const bot = isBot[i] ?? true;
      this.players.push({
        seat: i,
        label: bot ? (BOT_NAMES[i % BOT_NAMES.length] ?? `BOT${i}`) : `P${i + 1}`,
        lives: Math.max(1, Math.round(lives)),
        alive: true,
        isBot: bot,
        edge: null,
        paddle: null,
        screenDir: 0,
        bot: makeBotState(),
      });
    }
    this.balls = [];
    this.hazards = [];
    this.particles = [];
    this.splitter = null;
    this.round = 0;
    this.eliminations = 0;
    this.roundTime = 0;
    // A rematch must not inherit the last match's serve clock.
    this.serveTimer = 0;
    this.serveHeld = true;
    this.shake = 0;
    this.winner = null;
    this.over = false;
    this.started = true;
    this.running = false;
    this.replica = false;
    this.events = [];
    this.rebuildArena();
  }

  /**
   * The single freeze concept (SPEC §10.3). The old build had a pause flag, a
   * placement hold and a quiz freeze that could each stop the world
   * independently, and they collided. Here the owner sets exactly one bool.
   *
   * While not running: balls, hazard fields, the round clock, the serve timer
   * and the splitter are all stopped, and bots hold still. HUMAN paddles still
   * move, so a student can reposition during the 3-2-1 instead of watching a
   * ball get served past a paddle they were not allowed to touch. Cosmetic
   * decay (shake, particles) also continues, because freezing it makes the
   * screen look crashed.
   */
  setRunning(running: boolean): void {
    this.running = running;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get alivePlayers(): GamePlayer[] {
    return this.players.filter((p) => p.alive);
  }

  /** Display label passthrough. The sim never reads this. */
  setLabel(seat: number, label: string): void {
    const p = this.players[seat];
    if (p) p.label = label;
  }

  /** A dropped student is driven by AI without losing their seat (SPEC I4). */
  setBot(seat: number, isBot: boolean): void {
    const p = this.players[seat];
    if (!p || p.isBot === isBot) return;
    p.isBot = isBot;
    p.screenDir = 0;
    p.bot = makeBotState();
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  // ------------------------------------------------------------------- arena

  /**
   * The arena is a pure function of the living set: n living players give a
   * regular n-gon (or the 2-player rectangle), and goal edge k belongs to the
   * k-th living player. Rebuilt whenever that set changes and never otherwise.
   *
   * Paddles keep their FRACTIONAL position across a rebuild rather than their
   * arc length, so a player on a shrinking wall stays where they were relative
   * to it instead of snapping to an end.
   */
  private rebuildArena(): void {
    const alive = this.alivePlayers;
    this.arena = buildArena(Math.max(2, alive.length));

    for (const p of this.players) {
      if (!p.alive) {
        p.edge = null;
        p.paddle = null;
      }
    }

    alive.forEach((p, rank) => {
      const edge = this.arena.goalEdges[rank];
      if (!edge) return; // unreachable: goalEdges.length >= alive.length
      const prev = p.paddle;
      const frac =
        prev && prev.max > prev.min ? (prev.s - prev.min) / (prev.max - prev.min) : 0.5;
      p.edge = edge;
      const paddle = prev ?? new Paddle(edge);
      paddle.attach(edge);
      paddle.s = paddle.min + (paddle.max - paddle.min) * frac;
      paddle.vel = 0;
      p.paddle = paddle;
    });

    this.hazards = repositionHazards(this.arena, this.hazards);
    if (this.splitter && !splitterSurvives(this.arena, this.splitter)) this.splitter = null;
  }

  // ------------------------------------------------------------------ serving

  /** Fresh ball from the centre at a random angle. The owner calls this; the
   *  sim only auto-serves after an ordinary conceded point. */
  serve(): void {
    if (!this.started || this.over) return;
    this.round++;
    this.roundTime = 0;
    this.serveHeld = false;
    this.serveTimer = 0;
    this.balls = [makeBall(this.nextId++, this.arena.center, this.rng() * Math.PI * 2)];
    if (this.round % T.splitEvery === 0) this.spawnSplitter();
  }

  private spawnSplitter(): void {
    const p = randomSplitterSpot(this.arena, this.rng, this.hazards);
    this.splitter = p ? makeSplitter(p) : null;
  }

  // ------------------------------------------------------------------- input

  /**
   * `screenDir` is what the student's keyboard produced, in THEIR OWN screen
   * frame: +1 for D, -1 for A. It is stored raw and converted with the owning
   * edge's rightSign once per tick in updatePaddles — that multiply is the only
   * place in the entire project where the screen frame meets arena space, and
   * SPEC I5 tests it on every seat of every arena size.
   *
   * The conversion is deliberately deferred rather than applied here: a player
   * holding D through an elimination gets a new wall with possibly the opposite
   * rightSign, and a pre-converted value would have them sprinting the wrong
   * way until they let go of the key.
   */
  setInput(seat: number, screenDir: -1 | 0 | 1): void {
    const p = this.players[seat];
    if (!p) return;
    p.screenDir = screenDir > 0 ? 1 : screenDir < 0 ? -1 : 0;
  }

  // -------------------------------------------------------------- life events

  /**
   * Take lives from a seat without a ball being involved — the quiz path.
   * Returns true if this call eliminated them.
   */
  loseLife(seat: number, amount: number): boolean {
    const p = this.players[seat];
    if (!p || !p.alive) return false;
    const cost = Math.max(0, Math.round(amount));
    if (cost === 0) return false;
    p.lives = Math.max(0, p.lives - cost);
    if (p.lives > 0) return false;
    this.eliminate(p);
    return true;
  }

  /**
   * Put an eliminated player back in the arena. Driven by the owner (a correct
   * answer), never by physics.
   *
   * Legal even after the sim has declared the match over, because that is
   * exactly the case the revive question exists for: the class question knocks
   * the last challenger out, and answering correctly puts them back. `over` is
   * derived from the living set, so restoring a player un-declares it.
   */
  revive(seat: number, lives: number): boolean {
    const p = this.players[seat];
    if (!p || p.alive || !this.started) return false;
    p.alive = true;
    p.lives = Math.max(1, Math.round(lives));
    p.paddle = null;
    p.screenDir = 0;
    p.bot = makeBotState();
    // The arena grew a wall. Whatever was in flight belongs to a different
    // shape, so the table is cleared and the owner restarts play.
    this.balls = [];
    this.serveHeld = true;
    this.serveTimer = 0;
    this.rebuildArena();
    this.settleOutcome();
    return true;
  }

  private concede(p: GamePlayer, b: Ball): void {
    const hot = b.hot > 0;
    const cost = hot ? T.hotCost : 1;
    p.lives = Math.max(0, p.lives - cost);
    this.sparks(b.p, seatColor(p.seat), 24);
    this.shake = Math.min(1, this.shake + (hot ? 0.7 : 0.4));
    this.emit({ t: 'conceded', seat: p.seat, cost, hot });
    if (p.lives === 0) this.eliminate(p);
  }

  /**
   * Remove a wall, shrink the arena, and drop a hazard as the survivors' prize
   * (SPEC §5.5). Every third elimination is a sun; the rest are black holes,
   * so a long match ends up with a mixed field rather than four of a kind.
   */
  private eliminate(p: GamePlayer): void {
    p.alive = false;
    p.paddle = null;
    p.edge = null;
    p.screenDir = 0;
    this.eliminations++;

    // Clear before rebuilding: a ball mid-flight is aimed at a wall that is
    // about to stop existing.
    this.balls = [];
    this.serveTimer = 0;
    this.serveHeld = true;
    this.rebuildArena();

    if (this.settleOutcome()) {
      this.emit({ t: 'eliminated', seat: p.seat });
      return;
    }

    const kind: HazardKind = this.eliminations % 3 === 0 ? 'sun' : 'blackhole';
    const spot = randomHazardSpot(this.arena, this.rng, this.hazards);
    this.hazards.push(makeHazard(this.nextId++, kind, spot, p.seat));
    this.sparks(spot, kind === 'sun' ? '#ffb347' : '#a86bff', 30);
    this.emit({ t: 'eliminated', seat: p.seat });
  }

  /** `over` and `winner` are derived from the living set, never latched, so a
   *  revive can undo a match-over. Returns the new value of `over`. */
  private settleOutcome(): boolean {
    const alive = this.alivePlayers;
    const wasOver = this.over;
    this.over = this.started && alive.length <= 1;
    this.winner = this.over && alive.length === 1 ? (alive[0]?.seat ?? null) : null;
    if (this.over) {
      this.balls = [];
      this.running = false;
      if (!wasOver) this.emit({ t: 'matchOver', winner: this.winner });
    }
    return this.over;
  }

  // ------------------------------------------------------------------ update

  /**
   * Step the world by `dt` seconds. The owner supplies the clock; there is no
   * wall clock anywhere below this line (SPEC I12).
   */
  update(dt: number): void {
    if (this.replica) {
      // A replica has no sim. It still decays what it was told, so trails and
      // sparks keep moving between the 30 Hz snapshots.
      this.shake = Math.max(0, this.shake - dt * 4);
      this.updateParticles(dt);
      return;
    }
    if (!this.started) return;

    this.shake = Math.max(0, this.shake - dt * 4);
    this.updateParticles(dt);
    this.updatePaddles(dt);

    if (!this.running || this.over) return;

    this.roundTime += dt;
    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0 && this.balls.length === 0) this.serve();
    }

    // Sub-step so no ball travels more than T.subStepMaxTravel between
    // collision checks. This, and nothing else, is what makes SPEC I7 true on
    // the server: a ball can never cross the paddle's whole thickness inside a
    // single step, so there is no state in which it was in front of the paddle
    // and the next state has it behind.
    let fastest = 0;
    for (const b of this.balls) fastest = Math.max(fastest, len(b.v));
    const steps = Math.min(
      MAX_SUBSTEPS,
      Math.max(1, Math.ceil((fastest * dt) / T.subStepMaxTravel)),
    );
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.stepBalls(h);

    if (this.splitter) this.splitter.age += dt;
    for (const hz of this.hazards) hz.age += dt;
  }

  private updatePaddles(dt: number): void {
    const live = this.running && !this.over;
    for (const p of this.players) {
      const edge = p.edge;
      const paddle = p.paddle;
      if (!p.alive || !edge || !paddle) continue;

      let dir = 0;
      if (p.isBot) {
        // A frozen bot holds still. It has nothing to look at and jittering
        // through a question modal looks like the game is still running.
        dir = live ? botInput(p.bot, edge, paddle, this.balls, dt, this.rng) : 0;
      } else {
        // SPEC I5, the one and only conversion: the player's screen-right is
        // their inward normal rotated 90 degrees, and rightSign is whichever
        // sign of edge.dir agrees with it.
        dir = p.screenDir * edge.rightSign;
      }
      paddle.update(edge, dir, dt, p.isBot ? T.botSpeed : 1);
    }
  }

  /**
   * The stall breaker (SPEC §5.6). Once a round runs past T.stallTimeout the
   * ball accelerates and the cap rises with it, so no rally can outlast a
   * class period. Two evenly matched bots on a 2-player court will otherwise
   * volley literally forever, which is how the old build discovered this.
   */
  private speedCap(): number {
    const overtime = Math.max(0, this.roundTime - T.stallTimeout);
    return T.ballSpeedMax * (1 + overtime * 0.05);
  }

  private stepBalls(dt: number): void {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if (!b) continue;

      applyFields(b, this.hazards, dt);

      if (b.hot > 0) b.hot -= dt;
      if (this.roundTime > T.stallTimeout) b.v = mul(b.v, 1 + T.stallAccel * dt);

      let sp = len(b.v);
      const cap = this.speedCap() * CAP_SLACK;
      if (sp > cap) {
        b.v = mul(b.v, cap / sp);
        sp = cap;
      }
      // Floor as well as cap: a black hole braking a ball head-on, or a very
      // shallow return, can otherwise leave it drifting and the round hangs.
      if (sp < T.ballSpeedMin) b.v = mul(b.v, T.ballSpeedMin / (sp || 1));

      b.p = add(b.p, mul(b.v, dt));
      pushTrail(b);

      const sp2 = this.splitter;
      if (sp2 && dist(b.p, sp2.p) < b.r + sp2.r) this.doSplit(b, sp2);

      if (this.collide(b) === 'goal') {
        // An elimination clears the whole table mid-sweep. If this ball is no
        // longer where it was, the array underneath us is gone; abandon the
        // sweep rather than splicing an index into a different array.
        if (this.balls[i] !== b) return;
        this.balls.splice(i, 1);
      }
    }

    if (this.balls.length === 0 && !this.serveHeld && this.serveTimer <= 0) {
      this.serveTimer = TIMING.serveDelay;
      this.emit({ t: 'roundEnded' });
    }
  }

  private collide(b: Ball): 'goal' | null {
    const alive = this.alivePlayers;

    for (const e of this.arena.edges) {
      const perp = dot(sub(b.p, e.a), e.n);
      const approaching = dot(b.v, e.n) < 0;

      if (e.owner === null) {
        // Solid unownable wall: the two long sides of the 2-player court.
        if (perp < b.r && approaching) {
          b.p = add(b.p, mul(e.n, b.r - perp));
          b.v = sub(b.v, mul(e.n, 2 * dot(b.v, e.n)));
          this.sparks(b.p, '#8899aa', 5);
        }
        continue;
      }

      const owner = alive[e.owner];
      if (!owner || !owner.paddle) continue;

      if (perp < b.r && approaching) {
        const along = dot(sub(b.p, e.a), e.dir);
        // The 0.6 slop makes the paddle's ends slightly forgiving. Without it,
        // a return off the very tip reads as a miss even though the ball
        // visibly touched, which players read as the game cheating.
        if (Math.abs(along - owner.paddle.s) <= owner.paddle.half + b.r * 0.6) {
          this.bounceOffPaddle(b, e, owner, along);
          continue;
        }
      }

      if (perp < -b.r * GOAL_DEPTH) {
        this.concede(owner, b);
        return 'goal';
      }
    }

    // Failsafe. A ball this far out escaped through a seam that should not
    // exist; charging it to the nearest goal keeps the round terminating
    // instead of leaving an invisible ball nobody can score against.
    if (dist(b.p, this.arena.center) > ESCAPE_RADIUS) {
      let best: Edge | null = null;
      let bestD = Infinity;
      for (const e of this.arena.goalEdges) {
        const d = dist(b.p, e.mid);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      const owner = best && best.owner !== null ? alive[best.owner] : undefined;
      if (owner) this.concede(owner, b);
      return 'goal';
    }
    return null;
  }

  /**
   * Paddle spin, ported unchanged (SPEC §5.6). Two things curve the return:
   * where on the paddle it landed, and how fast the paddle was moving. Both
   * feed the TANGENTIAL component only; the normal component is then whatever
   * is left of the speed budget, which is what keeps a return from ever
   * running along the wall no matter how the two inputs stack up.
   */
  private bounceOffPaddle(b: Ball, e: Edge, owner: GamePlayer, along: number): void {
    const paddle = owner.paddle;
    if (!paddle) return;

    const perp = dot(sub(b.p, e.a), e.n);
    b.p = add(b.p, mul(e.n, b.r - perp + CONTACT_NUDGE));

    const speed = Math.min(len(b.v) * T.ballSpeedGain, this.speedCap());
    const offset = clamp((along - paddle.s) / paddle.half, -1, 1);

    let vt =
      dot(b.v, e.dir) * (1 - T.spinTransfer) +
      offset * speed * T.spinOffsetGain +
      paddle.vel * T.spinTransfer;

    // Hard tangential clamp. This is the line that stops a corner hit turning
    // into a ball that skims the wall for five seconds looking for a gap.
    const maxT = speed * T.spinMaxTangent;
    vt = clamp(vt, -maxT, maxT);
    // Whatever the clamp left over goes into the outward component, with a
    // floor so the return always visibly leaves the wall.
    const vn = Math.sqrt(Math.max(speed * speed - vt * vt, (speed * 0.35) ** 2));

    b.v = add(mul(e.n, vn), mul(e.dir, vt));
    b.v = mul(b.v, speed / (len(b.v) || 1));
    b.lastHit = owner.seat;
    this.sparks(b.p, seatColor(owner.seat), 8);
    this.shake = Math.min(1, this.shake + 0.12);
  }

  /** A splitter is consumed by the first ball to touch it. Clones inherit heat
   *  and the last hitter, so splitting a hot ball costs the loser twice over. */
  private doSplit(b: Ball, sp: Splitter): void {
    const room = T.maxBalls - this.balls.length;
    if (room <= 0) {
      this.splitter = null;
      return;
    }
    const clones = Math.min(2, room);
    for (let i = 0; i < clones; i++) {
      const ang = i === 0 ? T.splitAngle : -T.splitAngle;
      const nb = makeBall(this.nextId++, b.p, 0);
      nb.v = rot(b.v, ang);
      nb.hot = b.hot;
      nb.lastHit = b.lastHit;
      this.balls.push(nb);
    }
    this.sparks(sp.p, '#ffffff', 26);
    this.shake = Math.min(1, this.shake + 0.35);
    this.splitter = null;
  }

  // --------------------------------------------------------------- particles
  // Pure state. Game never draws — the renderer walks this array. Kept in the
  // sim because sparks are spawned at collision time, which is the only moment
  // that knows where and what colour.

  sparks(p: Vec, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2;
      const s = 0.1 + this.rng() * 0.5;
      this.particles.push({
        p: { x: p.x, y: p.y },
        v: { x: Math.cos(a) * s, y: Math.sin(a) * s },
        life: 0.35 + this.rng() * 0.4,
        max: 0.75,
        color,
      });
    }
    if (this.particles.length > MAX_PARTICLES) {
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      if (!q) continue;
      q.life -= dt;
      if (q.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      q.p = add(q.p, mul(q.v, dt));
      q.v = mul(q.v, 1 - 2.2 * dt);
    }
  }

  // -------------------------------------------------------------- replication

  /**
   * Wire state, in arena units. `view` carries the three fields that belong to
   * the phase machine rather than to physics; Game passes them straight
   * through and never reads them, which is what keeps SPEC I13 true while
   * still producing a complete Snapshot.
   */
  snapshot(view: SnapshotView = {}): Snapshot {
    const pl: SnapPlayer[] = this.players.map((p) => ({
      i: p.seat,
      l: p.lives,
      a: p.alive ? 1 : 0,
      b: p.isBot ? 1 : 0,
      n: p.label,
      s: p.paddle && p.edge ? r4(p.paddle.fraction(p.edge)) : 0.5,
    }));

    const bl: SnapBall[] = this.balls.map((b) => ({
      i: b.id,
      p: [r4(b.p.x), r4(b.p.y)],
      v: [r3(b.v.x), r3(b.v.y)],
      h: b.hot > 0 ? 1 : 0,
    }));

    const hz: SnapHazard[] = this.hazards.map((h) => ({
      k: h.kind,
      p: [r4(h.p.x), r4(h.p.y)],
      o: h.owner,
    }));

    return {
      ph: view.ph ?? (this.over ? 'matchover' : this.running ? 'playing' : 'lobby'),
      tm: r3(view.tm ?? 0),
      rd: this.round,
      bn: view.bn ?? '',
      pl,
      bl,
      hz,
      sp: this.splitter ? [r4(this.splitter.p.x), r4(this.splitter.p.y)] : null,
      wn: this.winner,
    };
  }

  /**
   * Rebuild render state from a snapshot. A replica NEVER simulates (SPEC I8):
   * every collision in the game happened on the server, and a client that
   * re-ran the physics would disagree with it somewhere and put a ball on the
   * wrong side of a paddle.
   */
  applySnapshot(s: Snapshot): void {
    this.replica = true;
    this.started = true;

    if (this.players.length !== s.pl.length) {
      this.players = s.pl.map((q) => ({
        seat: q.i,
        label: q.n,
        lives: q.l,
        alive: q.a === 1,
        isBot: q.b === 1,
        edge: null,
        paddle: null,
        screenDir: 0 as -1 | 0 | 1,
        bot: makeBotState(),
      }));
    }
    for (const q of s.pl) {
      const p = this.players[q.i];
      if (!p) continue;
      p.label = q.n;
      p.lives = q.l;
      p.alive = q.a === 1;
      p.isBot = q.b === 1;
    }

    // An interpolating client applies a snapshot every animation frame, not
    // every 33 ms, so only rebuild when the SHAPE actually changed. The arena
    // is a function of the living set and nothing else.
    const shape = s.pl.map((q) => q.a).join('');
    if (shape !== this.shapeKey) {
      this.rebuildArena();
      this.shapeKey = shape;
    }
    for (const q of s.pl) {
      const p = this.players[q.i];
      if (!p || !p.alive || !p.paddle || !p.edge) continue;
      p.paddle.s = clamp(q.s * p.edge.length, p.paddle.min, p.paddle.max);
    }

    // Carry trails across BY ID, for the same reason the wire sends one: ball
    // index 0 after a goal or a split is a different ball, and inheriting its
    // predecessor's tail draws a streak across the arena.
    const prev = new Map<number, Vec[]>();
    for (const b of this.balls) prev.set(b.id, b.trail);
    this.balls = s.bl.map((q) => {
      const b = makeBall(q.i, { x: q.p[0], y: q.p[1] }, 0);
      b.v = { x: q.v[0], y: q.v[1] };
      b.hot = q.h ? 1 : 0;
      b.trail = prev.get(q.i) ?? [];
      return b;
    });

    this.hazards = s.hz.map((h, i) =>
      makeHazard(-(i + 1), h.k, { x: h.p[0], y: h.p[1] }, h.o),
    );
    this.splitter = s.sp ? makeSplitter({ x: s.sp[0], y: s.sp[1] }) : null;
    this.round = s.rd;
    this.winner = s.wn;
    this.over = s.ph === 'matchover';
    this.running = s.ph === 'playing';
  }

  private shapeKey = '';

  /**
   * Replica-side trail growth. The authoritative sim grows trails inside
   * stepBalls; a replica has no sim, so the client calls this once per RENDERED
   * frame. That way the tail follows the interpolated path, which is the only
   * path the viewer ever actually sees.
   */
  pushTrails(limit = 14): void {
    for (const b of this.balls) {
      const last = b.trail[b.trail.length - 1];
      if (last && Math.abs(last.x - b.p.x) < 1e-4 && Math.abs(last.y - b.p.y) < 1e-4) continue;
      pushTrail(b, limit);
    }
  }
}
