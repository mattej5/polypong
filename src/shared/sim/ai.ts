// Bot paddles. Deliberately beatable — these fill empty seats in a classroom,
// and a bot that never misses turns a 4-player match into a 2-player one that
// nobody can win.
//
// Bots steer by targeting a position along their own edge. They never go
// through Edge.rightSign, because they have no screen: the screen-frame
// conversion exists only for keypresses from a human.

import { add, clamp, dot, mul, sub, type Edge } from '../geometry';
import { T, type Rng } from '../config';
import type { Ball } from './ball';
import type { Paddle } from './paddle';

export interface BotState {
  /** Seconds until the bot is allowed to look at the ball again. */
  timer: number;
  /** Arc length along the edge the bot is currently steering toward. */
  target: number;
}

export const makeBotState = (): BotState => ({ timer: 0, target: 0 });

/**
 * Which way this bot wants its paddle to travel: -1, 0 or +1 in ARENA sense
 * (+1 is toward edge.b), ready to hand straight to Paddle.update.
 *
 * Two things keep it human: it only re-reads the world every T.botReact
 * seconds, and its aim carries jitter that never fully decays. A bot that
 * re-aimed every frame would track the ball perfectly no matter how large the
 * jitter, because the errors average out over the flight.
 */
export function botInput(
  bot: BotState,
  edge: Edge,
  paddle: Paddle,
  balls: readonly Ball[],
  dt: number,
  rng: Rng,
): -1 | 0 | 1 {
  bot.timer -= dt;

  // The most threatening ball is the one arriving soonest, not the nearest:
  // a slow ball two arena-widths away is not the problem.
  let best: Ball | null = null;
  let bestT = Infinity;
  for (const b of balls) {
    const perp = dot(sub(b.p, edge.a), edge.n);
    const vperp = dot(b.v, edge.n);
    if (vperp >= -1e-3) continue; // moving away, or sliding parallel
    const t = (perp - b.r) / -vperp;
    if (t < 0 || t > bestT) continue;
    bestT = t;
    best = b;
  }

  if (bot.timer <= 0) {
    bot.timer = T.botReact;
    if (best) {
      // Straight-line prediction on purpose. Solving for wall bounces and
      // hazard fields would make bots unbeatable, and being wrong about a
      // deflected ball is exactly the mistake a person makes.
      const hit = add(best.p, mul(best.v, bestT));
      const along = dot(sub(hit, edge.a), edge.dir);
      // Error shrinks as the ball closes, but bottoms out at 45% rather than
      // zero. Without the floor, every bot nails every short-range return.
      const decay = 0.45 + 0.55 * Math.min(1, bestT);
      const jitter = (rng() * 2 - 1) * edge.length * T.botError * decay;
      bot.target = clamp(along + jitter, paddle.min, paddle.max);
    } else {
      bot.target = edge.length / 2;
    }
  }

  const gap = bot.target - paddle.s;
  // Deadband, or the paddle judders across its target every frame and the
  // resulting paddle velocity feeds garbage spin into every return.
  if (Math.abs(gap) < paddle.half * 0.18) return 0;
  return gap > 0 ? 1 : -1;
}
