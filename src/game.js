import * as G from './geometry.js';
import { BOT_NAMES, COLORS, KEY_PAIRS, KEY_LABELS, T } from './config.js';
import { makeBall, makeHazard, makeSplitter, Paddle } from './entities.js';
import { botInput } from './ai.js';

export const STATE = {
  MENU: 'menu',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  PLACEMENT: 'placement',
  GAMEOVER: 'gameover',
};

export class Game {
  constructor() {
    this.state = STATE.MENU;
    this.replica = false;      // true on clients: render only, never simulate
    this.aim = null;           // { u, v } hazard aim in arena units
    this.placeRequested = false;
    this.players = [];
    this.balls = [];
    this.hazards = [];
    this.particles = [];
    this.splitter = null;
    this.shake = 0;
    this.round = 0;
    this.volleys = 0;          // completed rallies; the quiz cadence counts these
    this.eliminations = 0;
    this.serveTarget = null;   // player idx the next serve is aimed at, or null
    this.servedAt = null;      // who the live serve was actually aimed at
    this.pending = [];
    this.paused = false;
    this.winner = null;
    this.banner = '';
    this.viewport = { w: 800, h: 600, cx: 400, cy: 300, R: 260, dpr: 1 };
  }

  // ---------------------------------------------------------------- lifecycle

  setViewport(w, h, dpr = 1) {
    const prev = this.viewport;
    const R = Math.min(w, h) * 0.40;
    this.viewport = { w, h, cx: w / 2, cy: h / 2 + h * 0.02, R, dpr };
    if (this.state === STATE.MENU) return;
    const k = R / prev.R;
    for (const hz of this.hazards) {
      hz.p = {
        x: this.viewport.cx + (hz.p.x - prev.cx) * k,
        y: this.viewport.cy + (hz.p.y - prev.cy) * k,
      };
      hz.r = R * T.hazardRadius;
    }
    for (const b of this.balls) {
      b.p = {
        x: this.viewport.cx + (b.p.x - prev.cx) * k,
        y: this.viewport.cy + (b.p.y - prev.cy) * k,
      };
      b.v = G.mul(b.v, k);
      b.r = R * T.ballRadius;
      b.trail.length = 0;
    }
    if (this.splitter) {
      this.splitter.p = {
        x: this.viewport.cx + (this.splitter.p.x - prev.cx) * k,
        y: this.viewport.cy + (this.splitter.p.y - prev.cy) * k,
      };
    }
    this.rebuildArena(true);
  }

  start(totalPlayers, bots) {
    const humans = totalPlayers - bots;
    this.players = [];
    for (let i = 0; i < totalPlayers; i++) {
      const isBot = i >= humans;
      this.players.push({
        idx: i,
        name: isBot ? BOT_NAMES[i % BOT_NAMES.length] : `P${i + 1}`,
        color: COLORS[i],
        lives: T.lives,
        alive: true,
        isBot,
        keys: isBot ? null : KEY_PAIRS[i],
        keyLabel: isBot ? 'CPU' : KEY_LABELS[i],
        paddle: null,
        inputDir: 0,
        aiTarget: 0,
        aiTimer: 0,
      });
    }
    this.balls = [];
    this.hazards = [];
    this.particles = [];
    this.splitter = null;
    this.pending = [];
    this.round = 0;
    this.volleys = 0;
    this.eliminations = 0;
    this.serveTarget = null;
    this.servedAt = null;
    this.winner = null;
    this.paused = false;
    this.aim = null;
    this.placeRequested = false;
    this.rebuildArena();
    this.beginCountdown('GET READY');
  }

  get alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  rebuildArena(keepPaddles = false) {
    const alive = this.alivePlayers;
    const { cx, cy, R } = this.viewport;
    this.arena = G.buildArena(Math.max(2, alive.length), cx, cy, R);
    this.arena.goalEdges = this.arena.edges
      .filter((e) => e.owner !== null)
      .sort((a, b) => a.owner - b.owner);

    alive.forEach((p, rank) => {
      const edge = this.arena.goalEdges[rank];
      p.edge = edge;
      if (!p.paddle) p.paddle = new Paddle(edge);
      else {
        const frac = keepPaddles && p.paddle.max > p.paddle.min
          ? (p.paddle.s - p.paddle.min) / (p.paddle.max - p.paddle.min)
          : 0.5;
        p.paddle.attach(edge);
        p.paddle.s = p.paddle.min + (p.paddle.max - p.paddle.min) * frac;
      }
    });

    const margin = R * T.hazardMargin;
    const clear = R * T.hazardCenterClear;
    this.hazards = this.hazards.map((h) => {
      let p = G.clampInside(this.arena, h.p, margin);
      const d = G.dist(p, this.arena.center);
      if (d < clear) {
        const away = d < 1 ? { x: 1, y: 0 } : G.norm(G.sub(p, this.arena.center));
        p = G.clampInside(this.arena, G.add(this.arena.center, G.mul(away, clear)), margin);
      }
      return { ...h, p };
    });
    if (this.splitter && !G.insideArena(this.arena, this.splitter.p, margin)) {
      this.splitter = null;
    }
  }

  beginCountdown(text) {
    this.state = STATE.COUNTDOWN;
    this.timer = T.countdown;
    this.banner = text || '';
  }

  serve() {
    this.round++;
    this.roundTime = 0;

    // A serve is normally a random angle. When the room has nominated a target
    // (a student who missed the last question) the ball is aimed straight down
    // the middle of that student's own wall instead. The room owns the fairness
    // rules for who may be nominated; the game only honours one nomination and
    // then forgets it, so a stale target can never repeat by itself.
    const target = this.serveTarget;
    this.serveTarget = null;
    this.servedAt = null;

    let ang = null;
    if (target !== null && target !== undefined) {
      const p = this.players[target];
      if (p && p.alive && p.edge) {
        const d = G.sub(p.edge.mid, this.arena.center);
        ang = Math.atan2(d.y, d.x);
        this.servedAt = target;
      }
    }
    if (ang === null) ang = Math.random() * Math.PI * 2;

    this.balls = [makeBall(this.arena.center, this.viewport.R, ang)];
    if (this.round % T.splitEvery === 0) this.spawnSplitter();
  }

  /**
   * Nominate the player whose wall the next serve is aimed at. Transport
   * agnostic, like setInput: the room calls it, nothing else does. Returns
   * false if the player cannot be aimed at (gone, eliminated, no wall yet).
   */
  setServeTarget(playerIdx) {
    const p = this.players[playerIdx];
    if (!p || !p.alive) return false;
    this.serveTarget = playerIdx;
    return true;
  }

  /**
   * Put an eliminated student back in the arena. Their route back is answering
   * a question correctly, so this is driven by the room, never by physics.
   */
  revive(playerIdx, lives = 1) {
    const p = this.players[playerIdx];
    if (!p || p.alive) return false;
    if (this.state === STATE.MENU || this.state === STATE.GAMEOVER) return false;
    p.alive = true;
    p.lives = Math.max(1, lives | 0);
    p.paddle = null;
    // They are back in play, so they no longer get the consolation hazard.
    const hadHead = this.pending.length && this.pending[0].player.idx === playerIdx;
    this.pending = this.pending.filter((j) => j.player.idx !== playerIdx);
    if (hadHead) { this.aim = null; this.ghost = null; this.placeRequested = false; }
    this.rebuildArena();
    return true;
  }

  spawnSplitter() {
    const { R } = this.viewport;
    const margin = R * (T.hazardMargin + 0.10);
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = R * (0.25 + Math.random() * 0.5);
      const p = {
        x: this.arena.center.x + Math.cos(a) * d,
        y: this.arena.center.y + Math.sin(a) * d,
      };
      if (!G.insideArena(this.arena, p, margin)) continue;
      if (G.dist(p, this.arena.center) < R * 0.18) continue;
      if (this.hazards.some((h) => G.dist(p, h.p) < h.r * 0.5)) continue;
      this.splitter = makeSplitter(p, R);
      return;
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    if (this.replica) {
      this.shake = Math.max(0, this.shake - dt * 4);
      this.updateParticles(dt);
      return;
    }
    if (this.state === STATE.MENU || this.state === STATE.GAMEOVER) return;
    if (this.paused) return;

    this.shake = Math.max(0, this.shake - dt * 4);
    this.updateParticles(dt);

    if (this.state === STATE.PLACEMENT) {
      this.updatePlacement(dt);
      return;
    }

    this.updatePaddles(dt);

    if (this.state === STATE.COUNTDOWN) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = STATE.PLAYING;
        this.banner = '';
        this.serve();
      }
      return;
    }

    this.roundTime += dt;
    if (this.serveTimer > 0) {
      this.serveTimer -= dt;
      if (this.serveTimer <= 0 && this.balls.length === 0) this.serve();
    }

    // Sub-step so fast balls cannot tunnel through a paddle.
    const fastest = this.balls.reduce((m, b) => Math.max(m, G.len(b.v)), 0);
    const steps = Math.min(8, Math.max(1, Math.ceil((fastest * dt) / (this.viewport.R * 0.02))));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this.stepBalls(h);

    if (this.splitter) this.splitter.age += dt;
  }

  updatePaddles(dt) {
    for (const p of this.alivePlayers) {
      let dir = 0;
      if (p.isBot) {
        dir = this.state === STATE.PLAYING ? botInput(p, p.edge, p.paddle, this.balls, dt) : 0;
      } else {
        dir = G.clamp(p.inputDir || 0, -1, 1);
      }
      p.paddle.update(p.edge, dir, dt, p.isBot ? T.botSpeed : 1);
    }
  }

  /** Max ball speed, which creeps upward once a round drags on so rallies end. */
  speedCap() {
    const overtime = Math.max(0, (this.roundTime || 0) - T.stallTimeout);
    return this.viewport.R * T.ballSpeedMax * (1 + overtime * 0.05);
  }

  stepBalls(dt) {
    if (this.state !== STATE.PLAYING) return;
    const { R } = this.viewport;

    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      if (!b) continue;

      this.applyHazards(b, dt);

      if (b.hot > 0) b.hot -= dt;
      if (this.roundTime > T.stallTimeout) b.v = G.mul(b.v, 1 + 0.30 * dt);

      let sp = G.len(b.v);
      const cap = this.speedCap() * 1.15;
      if (sp > cap) { b.v = G.mul(b.v, cap / sp); sp = cap; }
      if (sp < R * 0.42) { b.v = G.mul(b.v, (R * 0.42) / (sp || 1)); }

      b.p = G.add(b.p, G.mul(b.v, dt));

      b.trail.push({ x: b.p.x, y: b.p.y });
      if (b.trail.length > 14) b.trail.shift();

      if (this.splitter && G.dist(b.p, this.splitter.p) < b.r + this.splitter.r) {
        this.doSplit(b);
      }

      const outcome = this.collide(b);
      if (outcome === 'goal') {
        // An elimination clears the field, so bail out of the sweep entirely.
        if (this.state !== STATE.PLAYING) return;
        this.balls.splice(i, 1);
      }
    }

    if (this.balls.length === 0 && this.state === STATE.PLAYING && !(this.serveTimer > 0)) {
      this.serveTimer = T.serveDelay;
      this.volleys++;   // a rally just ended; the quiz cadence watches this
    }
  }

  applyHazards(b, dt) {
    const { R } = this.viewport;
    for (const hz of this.hazards) {
      const d = G.dist(b.p, hz.p);
      if (d > hz.r) { b.grip[hz.id] = 0; continue; }

      b.grip[hz.id] = (b.grip[hz.id] || 0) + dt;
      if (b.grip[hz.id] > T.fieldGripMax) continue; // anti-orbit release

      const falloff = 1 - d / hz.r;
      const toward = G.norm(G.sub(hz.p, b.p));
      if (hz.kind === 'blackhole') {
        b.v = G.add(b.v, G.mul(toward, R * T.blackHolePull * falloff * dt));
      } else {
        b.v = G.add(b.v, G.mul(toward, -R * T.sunPush * falloff * dt));
        b.v = G.mul(b.v, 1 + 0.45 * falloff * dt);
        b.hot = T.sunHeat;
      }
    }
  }

  collide(b) {
    for (const e of this.arena.edges) {
      const perp = G.dot(G.sub(b.p, e.a), e.n);
      const approaching = G.dot(b.v, e.n) < 0;

      if (e.owner === null) {
        if (perp < b.r && approaching) {
          b.p = G.add(b.p, G.mul(e.n, b.r - perp));
          b.v = G.sub(b.v, G.mul(e.n, 2 * G.dot(b.v, e.n)));
          this.sparks(b.p, '#8899aa', 5);
        }
        continue;
      }

      const owner = this.alivePlayers[e.owner];
      if (!owner) continue;

      if (perp < b.r && approaching) {
        const along = G.dot(G.sub(b.p, e.a), e.dir);
        if (Math.abs(along - owner.paddle.s) <= owner.paddle.half + b.r * 0.6) {
          this.bounceOffPaddle(b, e, owner, along);
          continue;
        }
      }

      if (perp < -b.r * 2.5) {
        this.scoreOn(owner, b);
        return 'goal';
      }
    }

    // Failsafe: a ball that somehow left the arena entirely is charged to the
    // nearest goal wall rather than vanishing.
    if (G.dist(b.p, this.arena.center) > this.viewport.R * 1.8) {
      let best = null, bestD = Infinity;
      for (const e of this.arena.goalEdges) {
        const d = G.dist(b.p, e.mid);
        if (d < bestD) { bestD = d; best = e; }
      }
      const owner = best && this.alivePlayers[best.owner];
      if (owner) this.scoreOn(owner, b);
      return 'goal';
    }
    return null;
  }

  bounceOffPaddle(b, e, owner, along) {
    const perp = G.dot(G.sub(b.p, e.a), e.n);
    b.p = G.add(b.p, G.mul(e.n, b.r - perp + 0.5));

    const speed = Math.min(G.len(b.v) * T.ballSpeedGain, this.speedCap());
    const offset = G.clamp((along - owner.paddle.s) / owner.paddle.half, -1, 1);

    let vt = G.dot(b.v, e.dir) * (1 - T.spinTransfer)
      + offset * speed * 0.62
      + owner.paddle.vel * T.spinTransfer;

    const maxT = speed * 0.86;
    vt = G.clamp(vt, -maxT, maxT);
    const vn = Math.sqrt(Math.max(speed * speed - vt * vt, (speed * 0.35) ** 2));

    b.v = G.add(G.mul(e.n, vn), G.mul(e.dir, vt));
    b.v = G.mul(b.v, speed / (G.len(b.v) || 1));
    b.lastHit = owner.idx;
    this.sparks(b.p, owner.color, 8);
    this.shake = Math.min(1, this.shake + 0.12);
  }

  doSplit(b) {
    const room = T.maxBalls - this.balls.length;
    if (room <= 0) { this.splitter = null; return; }
    const clones = Math.min(2, room);
    for (let i = 0; i < clones; i++) {
      const ang = i === 0 ? T.splitAngle : -T.splitAngle;
      const nb = makeBall(b.p, this.viewport.R, 0);
      nb.v = G.rot(b.v, ang);
      nb.p = { x: b.p.x, y: b.p.y };
      nb.hot = b.hot;
      nb.lastHit = b.lastHit;
      this.balls.push(nb);
    }
    this.sparks(this.splitter.p, '#ffffff', 26);
    this.shake = Math.min(1, this.shake + 0.35);
    this.splitter = null;
  }

  scoreOn(player, ball) {
    const cost = ball.hot > 0 ? T.hotCost : 1;
    player.lives = Math.max(0, player.lives - cost);
    this.sparks(ball.p, player.color, 24);
    this.shake = Math.min(1, this.shake + (ball.hot > 0 ? 0.7 : 0.4));
    if (player.lives === 0) this.eliminate(player);
  }

  eliminate(player) {
    player.alive = false;
    player.paddle = null;
    this.eliminations++;
    const kind = this.eliminations % 3 === 0 ? 'sun' : 'blackhole';

    const remaining = this.alivePlayers;
    if (remaining.length <= 1) {
      this.winner = remaining[0] || null;
      this.state = STATE.GAMEOVER;
      this.balls = [];
      return;
    }

    this.balls = [];
    this.serveTimer = 0;
    this.rebuildArena();
    this.pending.push({ player, kind });
    this.state = STATE.PLACEMENT;
    this.aim = null;
    this.placeRequested = false;
  }

  updatePlacement(dt) {
    const job = this.pending[0];
    if (!job) {
      this.state = STATE.COUNTDOWN;
      this.timer = T.countdown;
      return;
    }

    // Bots aim for themselves after a beat, so an AI elimination never stalls the game.
    if (job.player.isBot) {
      job.wait = (job.wait ?? 1.1) - dt;
      if (!this.aim || job.wait <= 0) {
        const a = Math.random() * Math.PI * 2;
        const d = 0.35 + Math.random() * 0.4;
        this.aim = { u: Math.cos(a) * d, v: Math.sin(a) * d };
      }
      if (job.wait <= 0) this.placeRequested = true;
    }

    this.ghost = this.resolveAim();

    if (this.ghost && this.consumePlaceRequest()) {
      const hz = makeHazard(job.kind, this.ghost, this.viewport.R, job.player.idx);
      hz.color = job.player.color;
      this.hazards.push(hz);
      this.sparks(this.ghost, job.kind === 'sun' ? '#ffb347' : '#a86bff', 30);
      this.pending.shift();
      this.aim = null;
      if (this.pending.length === 0) {
        this.beginCountdown(`${this.alivePlayers.length}-PLAYER ARENA`);
      }
    }
  }


  // ------------------------------------------------------- transport-facing API
  // Every driver (local keyboard, websocket, test harness) talks to the game
  // only through these. Nothing below here knows what a keyboard is.

  /** dir is -1, 0 or 1 along the player's own wall. */
  setInput(playerIdx, dir) {
    const p = this.players[playerIdx];
    if (p) p.inputDir = G.clamp(Math.sign(dir) || 0, -1, 1);
  }

  /**
   * Aim the pending hazard, in arena units: (0,0) is the centre and 1.0 is the
   * arena radius. Resolution-independent, so a Chromebook and a projector agree.
   */
  aimHazard(playerIdx, u, v) {
    const job = this.pending[0];
    if (!job || job.player.idx !== playerIdx) return false;
    this.aim = { u, v };
    return true;
  }

  placeHazard(playerIdx) {
    const job = this.pending[0];
    if (!job || job.player.idx !== playerIdx || !this.aim) return false;
    this.placeRequested = true;
    return true;
  }

  consumePlaceRequest() {
    const r = this.placeRequested;
    this.placeRequested = false;
    return r;
  }

  /** Arena-unit aim -> a legal world position, clamped off the walls and centre. */
  resolveAim() {
    const { R } = this.viewport;
    const c = this.arena.center;
    if (!this.aim) return null;
    let want = { x: c.x + this.aim.u * R, y: c.y + this.aim.v * R };
    const clear = R * T.hazardCenterClear;
    const d = G.dist(want, c);
    if (d < clear) {
      const away = d < 1 ? { x: 1, y: 0 } : G.norm(G.sub(want, c));
      want = G.add(c, G.mul(away, clear));
    }
    return G.clampInside(this.arena, want, R * T.hazardMargin);
  }

  // -------------------------------------------------------------- replication

  toArena(p) {
    const c = this.arena.center, R = this.viewport.R;
    return [+((p.x - c.x) / R).toFixed(4), +((p.y - c.y) / R).toFixed(4)];
  }

  fromArena(a) {
    const c = this.arena.center, R = this.viewport.R;
    return { x: c.x + a[0] * R, y: c.y + a[1] * R };
  }

  /** Full authoritative state, in arena units. ~40 floats, safe to send at 20Hz. */
  snapshot() {
    return {
      st: this.state,
      tm: +(this.timer ?? 0).toFixed(3),
      rd: this.round,
      bn: this.banner,
      pl: this.players.map((p) => ({
        i: p.idx,
        l: p.lives,
        a: p.alive ? 1 : 0,
        b: p.isBot ? 1 : 0,
        n: p.name,
        s: p.paddle && p.edge ? +(p.paddle.s / p.edge.length).toFixed(4) : 0.5,
      })),
      bl: this.balls.map((b) => ({
        p: this.toArena(b.p),
        v: [+(b.v.x / this.viewport.R).toFixed(3), +(b.v.y / this.viewport.R).toFixed(3)],
        h: b.hot > 0 ? 1 : 0,
      })),
      hz: this.hazards.map((h) => ({ k: h.kind, p: this.toArena(h.p), o: h.owner })),
      sp: this.splitter ? this.toArena(this.splitter.p) : null,
      pd: this.pending.map((j) => ({ i: j.player.idx, k: j.kind })),
      gh: this.ghost ? this.toArena(this.ghost) : null,
      wn: this.winner ? this.winner.idx : null,
    };
  }

  /** Rebuild a render-ready replica from a snapshot. Never simulates. */
  applySnapshot(s) {
    this.replica = true;
    const { R } = this.viewport;

    if (this.players.length !== s.pl.length) {
      this.players = s.pl.map((q) => ({
        idx: q.i, name: q.n, color: COLORS[q.i], isBot: !!q.b,
        keys: KEY_PAIRS[q.i], keyLabel: q.b ? 'CPU' : KEY_LABELS[q.i],
        lives: q.l, alive: !!q.a, paddle: null, inputDir: 0,
      }));
    }
    s.pl.forEach((q) => {
      const p = this.players[q.i];
      p.lives = q.l;
      p.alive = !!q.a;
      p.name = q.n;
    });

    this.rebuildArena(true);
    s.pl.forEach((q) => {
      const p = this.players[q.i];
      if (p.alive && p.paddle && p.edge) {
        p.paddle.s = G.clamp(q.s * p.edge.length, p.paddle.min, p.paddle.max);
      }
    });

    this.balls = s.bl.map((b, i) => {
      const prev = this.balls[i];
      return {
        id: i,
        p: this.fromArena(b.p),
        v: { x: b.v[0] * R, y: b.v[1] * R },
        r: R * T.ballRadius,
        hot: b.h ? 1 : 0,
        grip: {},
        trail: prev ? prev.trail : [],
        lastHit: null,
      };
    });

    this.hazards = s.hz.map((h, i) => ({
      id: 1000 + i, kind: h.k, p: this.fromArena(h.p),
      r: R * T.hazardRadius, owner: h.o, color: COLORS[h.o],
    }));

    this.splitter = s.sp ? { p: this.fromArena(s.sp), r: R * 0.028, age: 0 } : null;
    this.pending = s.pd.map((j) => ({ player: this.players[j.i], kind: j.k }));
    this.ghost = s.gh ? this.fromArena(s.gh) : null;
    this.winner = s.wn === null ? null : this.players[s.wn];
    this.state = s.st;
    this.timer = s.tm;
    this.round = s.rd;
    this.banner = s.bn;
  }

  // --------------------------------------------------------------- particles

  sparks(p, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = this.viewport.R * (0.1 + Math.random() * 0.5);
      this.particles.push({
        p: { x: p.x, y: p.y },
        v: { x: Math.cos(a) * s, y: Math.sin(a) * s },
        life: 0.35 + Math.random() * 0.4,
        max: 0.75,
        color,
      });
    }
    if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      if (q.life <= 0) { this.particles.splice(i, 1); continue; }
      q.p = G.add(q.p, G.mul(q.v, dt));
      q.v = G.mul(q.v, 1 - 2.2 * dt);
    }
  }
}
