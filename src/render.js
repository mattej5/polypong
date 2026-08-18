import * as G from './geometry.js';
import { T } from './config.js';
import { STATE } from './game.js';

const BG = '#070911';

export function render(ctx, game, time) {
  const { w, h, R, dpr } = game.viewport;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  if (game.state === STATE.MENU) return;

  const sh = game.shake * R * 0.02;
  ctx.save();
  ctx.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);

  drawFloor(ctx, game, time);
  for (const hz of game.hazards) drawHazard(ctx, hz, time);
  drawWalls(ctx, game, time);
  if (game.splitter) drawSplitter(ctx, game.splitter, time);
  for (const b of game.balls) drawBall(ctx, b, R);
  drawParticles(ctx, game);
  if (game.state === STATE.PLACEMENT) drawGhost(ctx, game, time);

  ctx.restore();

  drawHud(ctx, game);
  drawBanner(ctx, game);
}

function drawFloor(ctx, game, time) {
  const { center, verts, R } = game.arena;
  ctx.save();
  ctx.beginPath();
  verts.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)));
  ctx.closePath();
  const g = ctx.createRadialGradient(center.x, center.y, R * 0.05, center.x, center.y, R * 1.1);
  g.addColorStop(0, 'rgba(30,40,70,0.55)');
  g.addColorStop(1, 'rgba(10,12,24,0.15)');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.clip();
  ctx.strokeStyle = 'rgba(120,160,255,0.06)';
  ctx.lineWidth = 1;
  const step = R * 0.12;
  for (let x = center.x - R * 1.6; x < center.x + R * 1.6; x += step) {
    ctx.beginPath(); ctx.moveTo(x, center.y - R * 1.6); ctx.lineTo(x, center.y + R * 1.6); ctx.stroke();
  }
  for (let y = center.y - R * 1.6; y < center.y + R * 1.6; y += step) {
    ctx.beginPath(); ctx.moveTo(center.x - R * 1.6, y); ctx.lineTo(center.x + R * 1.6, y); ctx.stroke();
  }
  const pulse = 0.25 + 0.1 * Math.sin(time * 2);
  ctx.strokeStyle = `rgba(120,160,255,${pulse * 0.25})`;
  ctx.beginPath();
  ctx.arc(center.x, center.y, R * 0.16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawWalls(ctx, game, time) {
  const alive = game.alivePlayers;
  ctx.lineCap = 'round';

  for (const e of game.arena.edges) {
    if (e.owner === null) {
      ctx.strokeStyle = 'rgba(150,170,210,0.55)';
      ctx.lineWidth = Math.max(3, game.viewport.R * 0.012);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
      continue;
    }
    const p = alive[e.owner];
    if (!p) continue;

    ctx.strokeStyle = hexA(p.color, 0.18);
    ctx.lineWidth = Math.max(2, game.viewport.R * 0.008);
    ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();

    const c = p.paddle.center(e);
    const half = p.paddle.half;
    const a = G.add(c, G.mul(e.dir, -half));
    const b = G.add(c, G.mul(e.dir, half));
    const inset = G.mul(e.n, game.viewport.R * 0.008);

    ctx.save();
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 18 + 6 * Math.sin(time * 3 + e.owner);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(5, game.viewport.R * 0.022);
    ctx.beginPath();
    ctx.moveTo(a.x + inset.x, a.y + inset.y);
    ctx.lineTo(b.x + inset.x, b.y + inset.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBall(ctx, b, R) {
  const hot = b.hot > 0;
  const core = hot ? '#fff3d6' : '#ffffff';
  const glow = hot ? '#ff7a1a' : '#9fd8ff';

  ctx.save();
  for (let i = 0; i < b.trail.length; i++) {
    const t = i / b.trail.length;
    ctx.globalAlpha = t * 0.35;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(b.trail[i].x, b.trail[i].y, b.r * (0.25 + t * 0.85), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = glow;
  ctx.shadowBlur = hot ? 32 : 16;
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(b.p.x, b.p.y, b.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHazard(ctx, hz, time) {
  const { p, r } = hz;
  ctx.save();
  if (hz.kind === 'blackhole') {
    const g = ctx.createRadialGradient(p.x, p.y, r * 0.04, p.x, p.y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.28, 'rgba(60,20,110,0.75)');
    g.addColorStop(1, 'rgba(60,20,110,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(190,120,255,0.55)';
    for (let i = 0; i < 3; i++) {
      const rr = r * (0.16 + i * 0.09);
      const a = time * (1.6 + i * 0.7);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rr, rr * 0.42, a, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.11, 0, Math.PI * 2); ctx.fill();
  } else {
    const g = ctx.createRadialGradient(p.x, p.y, r * 0.04, p.x, p.y, r);
    g.addColorStop(0, 'rgba(255,245,200,0.95)');
    g.addColorStop(0.2, 'rgba(255,150,40,0.55)');
    g.addColorStop(1, 'rgba(255,90,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(255,190,90,0.7)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = time * 0.6 + (i * Math.PI * 2) / 12;
      const r0 = r * (0.15 + 0.02 * Math.sin(time * 4 + i));
      const r1 = r * (0.26 + 0.05 * Math.sin(time * 3 + i * 2));
      ctx.beginPath();
      ctx.moveTo(p.x + Math.cos(a) * r0, p.y + Math.sin(a) * r0);
      ctx.lineTo(p.x + Math.cos(a) * r1, p.y + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.shadowColor = '#ffb347';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#fff0c0';
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.12, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawSplitter(ctx, s, time) {
  ctx.save();
  const pulse = 1 + 0.28 * Math.sin(time * 6);
  ctx.shadowColor = '#7cffe0';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#eafff8';
  ctx.beginPath(); ctx.arc(s.p.x, s.p.y, s.r * pulse, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(124,255,224,0.85)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const a = time * 2 + (i * Math.PI * 2) / 3;
    const rr = s.r * 3.2;
    ctx.beginPath();
    ctx.arc(s.p.x, s.p.y, rr, a, a + 0.9);
    ctx.stroke();
  }
  ctx.restore();
}

function drawParticles(ctx, game) {
  ctx.save();
  for (const q of game.particles) {
    ctx.globalAlpha = Math.max(0, q.life / q.max);
    ctx.fillStyle = q.color;
    ctx.beginPath();
    ctx.arc(q.p.x, q.p.y, game.viewport.R * 0.006, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGhost(ctx, game, time) {
  const job = game.pending[0];
  if (!job || !game.ghost) return;
  const preview = { kind: job.kind, p: game.ghost, r: game.viewport.R * T.hazardRadius };
  ctx.save();
  ctx.globalAlpha = 0.55 + 0.15 * Math.sin(time * 5);
  drawHazard(ctx, preview, time);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = job.player.color;
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(game.ghost.x, game.ghost.y, preview.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

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
    ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;
    ctx.fillText(p.name, out.x, out.y - size * 0.55);

    const pipR = size * 0.24;
    const gap = pipR * 3.1;
    const start = out.x - ((p.lives - 1) * gap) / 2;
    for (let i = 0; i < T.lives; i++) {
      const x = out.x - ((T.lives - 1) * gap) / 2 + i * gap;
      ctx.beginPath();
      ctx.arc(x, out.y + size * 0.55, pipR, 0, Math.PI * 2);
      if (i < p.lives) { ctx.fillStyle = p.color; ctx.fill(); }
      else { ctx.strokeStyle = hexA(p.color, 0.35); ctx.lineWidth = 1.5; ctx.stroke(); }
    }
    void start;

    ctx.fillStyle = hexA(p.color, 0.5);
    ctx.font = `500 ${size * 0.6}px ui-monospace, Menlo, monospace`;
    ctx.fillText(p.keyLabel, out.x, out.y + size * 1.35);
  }
  ctx.restore();
}

function drawBanner(ctx, game) {
  const { w, h, R } = game.viewport;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (game.state === STATE.COUNTDOWN) {
    const n = Math.ceil(game.timer);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `800 ${R * 0.34}px ui-monospace, Menlo, monospace`;
    ctx.fillText(String(n), w / 2, h / 2);
    if (game.banner) {
      ctx.fillStyle = 'rgba(160,190,255,0.75)';
      ctx.font = `700 ${R * 0.07}px ui-monospace, Menlo, monospace`;
      ctx.fillText(game.banner, w / 2, h / 2 + R * 0.26);
    }
  }

  if (game.state === STATE.PLACEMENT) {
    const job = game.pending[0];
    if (job) {
      const label = job.kind === 'sun' ? 'SUN' : 'BLACK HOLE';
      ctx.fillStyle = job.player.color;
      ctx.font = `800 ${R * 0.085}px ui-monospace, Menlo, monospace`;
      ctx.fillText(`${job.player.name} ELIMINATED`, w / 2, h * 0.085);
      ctx.fillStyle = 'rgba(230,240,255,0.9)';
      ctx.font = `600 ${R * 0.055}px ui-monospace, Menlo, monospace`;
      ctx.fillText(`CLICK TO PLACE YOUR ${label}`, w / 2, h * 0.085 + R * 0.10);
      ctx.fillStyle = 'rgba(160,180,220,0.6)';
      ctx.font = `500 ${R * 0.04}px ui-monospace, Menlo, monospace`;
      ctx.fillText(
        job.kind === 'sun'
          ? 'repels the ball, superheats it — a hot goal costs 2 lives'
          : 'pulls the ball in when it drifts close',
        w / 2, h * 0.085 + R * 0.175
      );
    }
  }

  if (game.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${R * 0.14}px ui-monospace, Menlo, monospace`;
    ctx.fillText('PAUSED', w / 2, h / 2);
  }
  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
