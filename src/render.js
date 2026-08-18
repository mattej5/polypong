import * as G from './geometry.js';
import { T } from './config.js';
import { STATE } from './game.js';

// Vector-CRT renderer.
//
// Two rules hold the whole file together:
//   1. Glow is additive, never blurred. `globalCompositeOperation = 'lighter'`
//      plus the same path stroked two or three times — wide and faint, then
//      thin and full — costs a handful of ordinary strokes. `shadowBlur` costs
//      a full-surface blur per draw and is the single slowest thing a
//      Chromebook can be asked to do in Canvas 2D. There is no shadowBlur and
//      no gradient anywhere below.
//   2. The arena interior is pure black. Every pixel that is not black is a
//      thing you can hit, own, or die to.

const BG = '#000000';
const TAU = Math.PI * 2;
const MONO = 'ui-monospace, Menlo, monospace';

const DEAD_WALL = 'hsl(222, 18%, 62%)';   // solid, unownable, deliberately dull
const BALL_COLD = 'hsl(196, 86%, 62%)';
const BALL_HOT = 'hsl(24, 96%, 60%)';
const SPLIT = 'hsl(162, 86%, 62%)';
const HZ_COLOR = { blackhole: 'hsl(276, 86%, 62%)', sun: 'hsl(34, 92%, 60%)' };
const HUD_DIM = 'hsl(216, 34%, 74%)';

export function render(ctx, game, time) {
  const { w, h, R, dpr } = game.viewport;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  if (game.state === STATE.MENU) return;

  const sh = game.shake * R * 0.02;
  ctx.save();
  ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';

  drawWalls(ctx, game);
  drawCenterMark(ctx, game, time);

  // Hazard fields are clipped to the arena: a field that bled through a wall
  // would be reading as reach the ball does not actually have.
  if (game.hazards.length || game.state === STATE.PLACEMENT) {
    ctx.save();
    arenaPath(ctx, game.arena);
    ctx.clip();
    for (const hz of game.hazards) drawHazard(ctx, hz, time);
    if (game.state === STATE.PLACEMENT) drawGhost(ctx, game, time);
    ctx.restore();
  }

  if (game.splitter) drawSplitter(ctx, game.splitter, time);
  for (const b of game.balls) drawBall(ctx, b);
  drawPaddles(ctx, game, time);
  drawParticles(ctx, game);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.restore();

  drawHud(ctx, game);
  drawBanner(ctx, game);
}

// ----------------------------------------------------------------- beam prims
// Every one of these assumes composite is already 'lighter'. They stroke or
// fill the *same* geometry several times; Canvas keeps the current path across
// strokes, so the path is only built once no matter how many layers there are.

// Global dimmer. beam/beamDot own globalAlpha, so a caller that wants to fade a
// whole composite thing (the placement ghost) sets this instead.
let FADE = 1;

function beam(ctx, color, width, alpha, layers = 3) {
  ctx.strokeStyle = color;
  for (let i = 3 - layers; i < 3; i++) {
    ctx.globalAlpha = alpha * T.glowA[i] * FADE;
    ctx.lineWidth = width * T.glowW[i];
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function beamLine(ctx, a, b, color, width, alpha, layers) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  beam(ctx, color, width, alpha, layers);
}

function beamRing(ctx, x, y, r, color, width, alpha, layers) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  beam(ctx, color, width, alpha, layers);
}

function beamDot(ctx, x, y, r, color, alpha) {
  ctx.fillStyle = color;
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = alpha * T.glowA[i] * FADE;
    ctx.beginPath();
    ctx.arc(x, y, r * T.glowR[i], 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function arenaPath(ctx, arena) {
  ctx.beginPath();
  const v = arena.verts;
  ctx.moveTo(v[0].x, v[0].y);
  for (let i = 1; i < v.length; i++) ctx.lineTo(v[i].x, v[i].y);
  ctx.closePath();
}

// --------------------------------------------------------------------- arena

function drawWalls(ctx, game) {
  const { R } = game.viewport;
  const alive = game.alivePlayers;

  for (const e of game.arena.edges) {
    if (e.owner === null) {
      // 2-player mode only. Solid and unscoreable, so it stays quiet — the two
      // things on screen that can end your round are the paddles, not this.
      beamLine(ctx, e.a, e.b, DEAD_WALL, Math.max(2, R * T.deadWallWidth), 0.36, 2);
      continue;
    }
    const p = alive[e.owner];
    if (!p) continue;
    beamLine(ctx, e.a, e.b, p.color, Math.max(1.5, R * T.wallWidth), 0.32, 1);
  }
}

/**
 * Serve point. A crosshair, not a ring: circles are now the language of hazard
 * fields, and a dim ring in the middle of the arena reads as one more field.
 */
function drawCenterMark(ctx, game, time) {
  const { center } = game.arena;
  const R = game.viewport.R;
  const i0 = R * 0.045, i1 = R * 0.10;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const cs = Math.cos((i * TAU) / 4), sn = Math.sin((i * TAU) / 4);
    ctx.moveTo(center.x + cs * i0, center.y + sn * i0);
    ctx.lineTo(center.x + cs * i1, center.y + sn * i1);
  }
  beam(ctx, HUD_DIM, Math.max(1, R * 0.003), 0.30 + 0.10 * Math.sin(time * 1.7), 2);
}

function drawPaddles(ctx, game, time) {
  const { R } = game.viewport;
  const width = Math.max(4, R * T.paddleWidth);

  for (const p of game.alivePlayers) {
    const e = p.edge;
    if (!e || !p.paddle) continue;
    const c = p.paddle.center(e);
    const half = p.paddle.half;
    const inset = G.mul(e.n, R * 0.008);
    const a = G.add(G.add(c, G.mul(e.dir, -half)), inset);
    const b = G.add(G.add(c, G.mul(e.dir, half)), inset);

    const pulse = 0.86 + 0.14 * Math.sin(time * 3 + p.idx);
    beamLine(ctx, a, b, p.color, width, pulse);
    // Hot filament. White additive over the hue keeps the core bright without
    // washing the halo out, so the seat colour still reads from the back row.
    beamLine(ctx, a, b, '#ffffff', width * 0.30, 0.34, 1);
  }
}

// -------------------------------------------------------------------- hazards

// Force falls off linearly to zero at exactly `hz.r`, so these rings are not
// decoration: the outer one is the edge of the field, and the inner ones sit at
// 25 / 50 / 75 percent of full pull. Crisp thin line for the boundary,
// brightening inward for the strength.
const RING_F = [1.0, 0.75, 0.5, 0.25];
const RING_A = [0.60, 0.16, 0.24, 0.40];

function drawHazard(ctx, hz, time) {
  const { p, r } = hz;
  const color = HZ_COLOR[hz.kind] || HZ_COLOR.blackhole;
  const thin = Math.max(1, r * 0.006);

  for (let i = 0; i < RING_F.length; i++) {
    beamRing(ctx, p.x, p.y, r * RING_F[i], color, thin, RING_A[i], i === 0 ? 3 : 2);
  }

  // Static ticks on the boundary. They do not rotate: the edge of the field is
  // a fixed fact about the arena, and only the core is allowed to look alive.
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i * TAU) / 12;
    const cs = Math.cos(a), sn = Math.sin(a);
    ctx.moveTo(p.x + cs * r * 0.93, p.y + sn * r * 0.93);
    ctx.lineTo(p.x + cs * r, p.y + sn * r);
  }
  beam(ctx, color, thin * 1.4, 0.5, 2);

  if (hz.kind === 'blackhole') {
    for (let i = 0; i < 2; i++) {
      const rr = r * (0.22 + i * 0.10);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * 0.40, time * (1.6 + i * 0.7), 0, TAU);
      beam(ctx, color, thin, 0.45 - i * 0.12, 2);
    }
    // The only genuinely black thing inside an additive frame. Its rim stays in
    // the hazard hue rather than white: a white disc here reads as a ball.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 0.13, 0, TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    beamRing(ctx, p.x, p.y, r * 0.13, color, thin * 1.6, 0.95);
  } else {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = time * 0.6 + (i * TAU) / 10;
      const cs = Math.cos(a), sn = Math.sin(a);
      const r0 = r * (0.15 + 0.02 * Math.sin(time * 4 + i));
      const r1 = r * (0.26 + 0.05 * Math.sin(time * 3 + i * 2));
      ctx.moveTo(p.x + cs * r0, p.y + sn * r0);
      ctx.lineTo(p.x + cs * r1, p.y + sn * r1);
    }
    beam(ctx, color, thin, 0.7, 2);
    // Warm, not white, for the same reason the black hole's rim is not white.
    beamDot(ctx, p.x, p.y, r * 0.075, 'hsl(38, 100%, 66%)', 1);
  }
}

function drawGhost(ctx, game, time) {
  const job = game.pending[0];
  if (!job || !game.ghost) return;
  const r = game.viewport.R * T.hazardRadius;
  const preview = { kind: job.kind, p: game.ghost, r };

  FADE = 0.45 + 0.15 * Math.sin(time * 5);
  drawHazard(ctx, preview, time);
  FADE = 1;

  // Dashed while it is still provisional; it goes solid the moment it lands.
  ctx.setLineDash([10, 8]);
  beamRing(ctx, game.ghost.x, game.ghost.y, r, job.player.color,
    Math.max(1.5, r * 0.008), 0.9, 2);
  ctx.setLineDash([]);
}

// ---------------------------------------------------------------- ball, bits

function drawBall(ctx, b) {
  const hot = b.hot > 0;
  const glow = hot ? BALL_HOT : BALL_COLD;
  const n = b.trail.length;

  if (n > 1) {
    // A thin vector line, not a chain of soft blobs. Two passes: the whole tail
    // faint, then the recent third brighter, which gives the taper for the cost
    // of four strokes total.
    ctx.beginPath();
    ctx.moveTo(b.trail[0].x, b.trail[0].y);
    for (let i = 1; i < n; i++) ctx.lineTo(b.trail[i].x, b.trail[i].y);
    ctx.lineTo(b.p.x, b.p.y);
    beam(ctx, glow, b.r * 0.55, 0.30, 2);

    const cut = Math.max(0, n - Math.ceil(n / 3));
    ctx.beginPath();
    ctx.moveTo(b.trail[cut].x, b.trail[cut].y);
    for (let i = cut + 1; i < n; i++) ctx.lineTo(b.trail[i].x, b.trail[i].y);
    ctx.lineTo(b.p.x, b.p.y);
    beam(ctx, glow, b.r * 0.75, 0.55, 2);
  }

  beamDot(ctx, b.p.x, b.p.y, b.r, glow, hot ? 1 : 0.85);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(b.p.x, b.p.y, b.r * 0.62, 0, TAU);
  ctx.fill();
}

function drawSplitter(ctx, s, time) {
  const pulse = 1 + 0.28 * Math.sin(time * 6);
  beamDot(ctx, s.p.x, s.p.y, s.r * pulse, SPLIT, 0.9);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = time * 2 + (i * TAU) / 3;
    ctx.moveTo(s.p.x + Math.cos(a) * s.r * 3.2, s.p.y + Math.sin(a) * s.r * 3.2);
    ctx.arc(s.p.x, s.p.y, s.r * 3.2, a, a + 0.9);
  }
  beam(ctx, SPLIT, Math.max(1.5, s.r * 0.5), 0.8, 2);
}

function drawParticles(ctx, game) {
  const r = game.viewport.R * 0.005;
  for (const q of game.particles) {
    ctx.globalAlpha = Math.max(0, q.life / q.max) * 0.9;
    ctx.fillStyle = q.color;
    ctx.beginPath();
    ctx.arc(q.p.x, q.p.y, r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ overlays

function drawHud(ctx, game) {
  const { R } = game.viewport;
  const alive = game.alivePlayers;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const e of game.arena.goalEdges) {
    const p = alive[e.owner];
    if (!p) continue;
    const out = G.add(e.mid, G.mul(e.n, -R * 0.10));
    const size = Math.max(11, R * 0.048);

    ctx.fillStyle = p.color;
    ctx.font = `700 ${size}px ${MONO}`;
    ctx.fillText(p.name, out.x, out.y - size * 0.55);

    const pipR = size * 0.24;
    const gap = pipR * 3.1;
    for (let i = 0; i < T.lives; i++) {
      const x = out.x - ((T.lives - 1) * gap) / 2 + i * gap;
      ctx.beginPath();
      ctx.arc(x, out.y + size * 0.55, pipR, 0, TAU);
      if (i < p.lives) {
        ctx.fillStyle = p.color;
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = p.color;
    ctx.font = `500 ${size * 0.6}px ${MONO}`;
    ctx.fillText(p.keyLabel, out.x, out.y + size * 1.35);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawBanner(ctx, game) {
  const { w, h, R } = game.viewport;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (game.state === STATE.COUNTDOWN) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `800 ${R * 0.34}px ${MONO}`;
    ctx.fillText(String(Math.ceil(game.timer)), w / 2, h / 2);
    if (game.banner) {
      ctx.fillStyle = HUD_DIM;
      ctx.font = `700 ${R * 0.07}px ${MONO}`;
      ctx.fillText(game.banner, w / 2, h / 2 + R * 0.26);
    }
  }

  if (game.state === STATE.PLACEMENT) {
    const job = game.pending[0];
    if (job) {
      const label = job.kind === 'sun' ? 'SUN' : 'BLACK HOLE';
      ctx.fillStyle = job.player.color;
      ctx.font = `800 ${R * 0.085}px ${MONO}`;
      ctx.fillText(`${job.player.name} ELIMINATED`, w / 2, h * 0.085);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `600 ${R * 0.055}px ${MONO}`;
      ctx.fillText(`CLICK TO PLACE YOUR ${label}`, w / 2, h * 0.085 + R * 0.10);
      ctx.fillStyle = HUD_DIM;
      ctx.globalAlpha = 0.75;
      ctx.font = `500 ${R * 0.04}px ${MONO}`;
      ctx.fillText(
        job.kind === 'sun'
          ? 'repels the ball, superheats it — a hot goal costs 2 lives'
          : 'pulls the ball in when it drifts close',
        w / 2, h * 0.085 + R * 0.175
      );
      ctx.globalAlpha = 1;
    }
  }

  if (game.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${R * 0.14}px ${MONO}`;
    ctx.fillText('PAUSED', w / 2, h / 2);
  }
  ctx.restore();
}
