// A seeded PRNG for tests. src/shared/ may never call Math.random (SPEC I12),
// so every test that needs randomness injects one of these — which also makes
// the determinism test possible at all: same seed, same match, every time.
//
// mulberry32: 32-bit state, uniform enough for jitter and serve angles, and
// short enough to read.

import type { Rng } from '../../src/shared/config';

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic and boring: useful when a test wants no jitter at all. */
export const constantRng = (v: number): Rng => () => v;
