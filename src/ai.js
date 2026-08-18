import * as G from './geometry.js';
import { T } from './config.js';

/**
 * Returns -1, 0 or 1: which way the bot wants its paddle to travel this frame.
 * Predicts the straight-line arrival of the most threatening ball, with jitter
 * and a reaction delay so bots stay beatable.
 */
export function botInput(player, edge, paddle, balls, dt) {
  player.aiTimer = (player.aiTimer || 0) - dt;

  let best = null;
  let bestT = Infinity;
  for (const b of balls) {
    const perp = G.dot(G.sub(b.p, edge.a), edge.n);
    const vperp = G.dot(b.v, edge.n);
    if (vperp >= -1e-3) continue;
    const t = (perp - b.r) / -vperp;
    if (t < 0 || t > bestT) continue;
    bestT = t;
    best = b;
  }

  if (player.aiTimer <= 0) {
    player.aiTimer = T.botReact;
    if (best) {
      const hit = G.add(best.p, G.mul(best.v, bestT));
      const along = G.dot(G.sub(hit, edge.a), edge.dir);
      // The aim error never fully decays, otherwise bots become unbeatable.
      const decay = 0.45 + 0.55 * Math.min(1, bestT);
      const jitter = (Math.random() * 2 - 1) * edge.length * T.botError * decay;
      player.aiTarget = G.clamp(along + jitter, paddle.min, paddle.max);
    } else {
      player.aiTarget = edge.length / 2;
    }
  }

  const target = player.aiTarget ?? edge.length / 2;
  const gap = target - paddle.s;
  if (Math.abs(gap) < paddle.half * 0.18) return 0;
  return gap > 0 ? 1 : -1;
}
