import * as G from './geometry.js';
import { T } from './config.js';

let nextId = 1;

export function makeBall(center, R, angle) {
  const speed = R * T.ballSpeed;
  return {
    id: nextId++,
    p: { x: center.x, y: center.y },
    v: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    r: R * T.ballRadius,
    hot: 0,
    grip: {},          // hazardId -> seconds spent inside its field
    trail: [],
    lastHit: null,     // player index of the last paddle that touched it
  };
}

export function makeHazard(kind, p, R, ownerIdx) {
  return { id: nextId++, kind, p, r: R * T.hazardRadius, owner: ownerIdx, born: 0 };
}

export function makeSplitter(p, R) {
  return { p, r: R * 0.028, age: 0 };
}

export class Paddle {
  constructor(edge) {
    this.attach(edge);
  }
  attach(edge) {
    const frac = Math.max(T.paddleFracMin, T.paddleFrac);
    this.half = (edge.length * frac) / 2;
    this.min = this.half;
    this.max = edge.length - this.half;
    this.s = edge.length / 2;
    this.vel = 0;
  }
  update(edge, dir, dt, speedMul = 1) {
    const before = this.s;
    this.s = G.clamp(
      this.s + dir * edge.length * T.paddleSpeed * speedMul * dt,
      this.min,
      this.max
    );
    this.vel = dt > 0 ? (this.s - before) / dt : 0;
  }
  center(edge) {
    return G.add(edge.a, G.mul(edge.dir, this.s));
  }
}
