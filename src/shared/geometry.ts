// Vectors and arena construction. Pure maths, no runtime APIs (SPEC I12).
//
// EVERYTHING in this file — and everything downstream of it — is in ARENA
// UNITS: the arena centre is the origin and the circumradius is exactly 1.
// Pixels exist only inside the renderer. The previous build simulated in a
// virtual pixel space and converted at the wire; that conversion was a
// recurring source of bugs and is gone.

export interface Vec {
  readonly x: number;
  readonly y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const ORIGIN: Vec = { x: 0, y: 0 };

export const norm = (a: Vec): Vec => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};

export const rot = (a: Vec, r: number): Vec => {
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

export const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n;

export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export interface Edge {
  readonly a: Vec;
  readonly b: Vec;
  /** Unit vector from `a` to `b`. An artifact of polygon winding — see rightSign. */
  readonly dir: Vec;
  /** Unit normal, always pointing INTO the arena. */
  readonly n: Vec;
  readonly length: number;
  readonly mid: Vec;
  /**
   * Seat index that owns this wall, or null for a solid unownable wall.
   * Index into the arena's ring of LIVING players, not into the seat table —
   * the caller maps rank to seat.
   */
  readonly owner: number | null;
  /**
   * Converts a player's screen-frame input into arena space. SPEC §5.3, I5.
   *
   * `dir` shares one rotational sense around the whole polygon, so "+dir" is
   * rightward on one edge and leftward, upward, or downward on the next. A
   * student's `D` key means exactly one thing: the direction their own right
   * hand points while facing the arena. They face along `n` (which already
   * points inward), so their right is `n` rotated 90 degrees. `rightSign` is
   * whichever sign of `dir` agrees with that. Multiply screen input by it and
   * `D` reads as "their right" on every wall at every player count.
   *
   * This is the ONLY place that mapping exists. Bots never use it — they
   * steer by targeting a position along `dir` directly, never a keypress.
   */
  readonly rightSign: 1 | -1;
}

export interface Arena {
  readonly edges: readonly Edge[];
  /** Owned edges only, ordered by owner rank. */
  readonly goalEdges: readonly Edge[];
  readonly verts: readonly Vec[];
  readonly center: Vec;
  /** Number of living players this arena was built for (>= 2). */
  readonly n: number;
  /** Distance from the centre to the nearest wall. */
  readonly inradius: number;
}

function makeEdge(a: Vec, b: Vec, owner: number | null): Edge {
  const d = sub(b, a);
  const length = len(d);
  const dir = mul(d, 1 / length);
  let n = { x: -dir.y, y: dir.x };
  const mid = lerp(a, b, 0.5);
  // ORIGIN is the arena centre; flip the normal if it points outward.
  if (dot(sub(ORIGIN, mid), n) < 0) n = mul(n, -1);
  const right = rot(n, Math.PI / 2);
  const rightSign: 1 | -1 = dot(dir, right) < 0 ? -1 : 1;
  return { a, b, dir, n, length, mid, owner, rightSign };
}

/** 2-player court half-extents, in arena units. Wide enough to feel like Pong, */
/** square enough that rotating it 90 degrees does not waste the viewport.      */
const COURT_HALF_W = 1.02;
const COURT_HALF_H = 0.70;

/**
 * Builds the arena for `n` living players, centred on the origin with
 * circumradius 1.
 *
 *   n >= 3 -> regular n-gon, every edge is a goal
 *   n <= 2 -> rectangle: left/right are goals, top/bottom are solid walls
 *
 * Goal edge k belongs to the k-th living player.
 */
export function buildArena(n: number): Arena {
  const edges: Edge[] = [];
  const verts: Vec[] = [];

  if (n <= 2) {
    const bl = v(-COURT_HALF_W, COURT_HALF_H);
    const tl = v(-COURT_HALF_W, -COURT_HALF_H);
    const tr = v(COURT_HALF_W, -COURT_HALF_H);
    const br = v(COURT_HALF_W, COURT_HALF_H);
    verts.push(tl, tr, br, bl);
    edges.push(makeEdge(bl, tl, 0));      // left goal
    edges.push(makeEdge(br, tr, 1));      // right goal
    edges.push(makeEdge(tl, tr, null));   // top wall
    edges.push(makeEdge(bl, br, null));   // bottom wall
    return {
      edges,
      goalEdges: [edges[0]!, edges[1]!],
      verts,
      center: ORIGIN,
      n: 2,
      inradius: COURT_HALF_H,
    };
  }

  // Offset so that EDGE 0's midpoint lands at angle +pi/2 — the bottom of the
  // screen, since y grows downward. That makes the unrotated arena the
  // teacher's canonical view with seat 0 at the bottom (SPEC §5.2), and gives
  // every viewer the same reference frame to reason about. Vertex i therefore
  // sits half a step back from edge i's midpoint.
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const ang = Math.PI / 2 + (i - 0.5) * step;
    verts.push(v(Math.cos(ang), Math.sin(ang)));
  }
  for (let i = 0; i < n; i++) {
    edges.push(makeEdge(verts[i]!, verts[(i + 1) % n]!, i));
  }
  return {
    edges,
    goalEdges: edges.slice(),
    verts,
    center: ORIGIN,
    n,
    inradius: Math.cos(Math.PI / n),
  };
}

export function insideArena(arena: Arena, p: Vec, margin = 0): boolean {
  for (const e of arena.edges) {
    if (dot(sub(p, e.a), e.n) < margin) return false;
  }
  return true;
}

/** Nearest point to `p` that sits at least `margin` inside every wall. */
export function clampInside(arena: Arena, p: Vec, margin: number): Vec {
  let q: Vec = { x: p.x, y: p.y };
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const e of arena.edges) {
      const d = dot(sub(q, e.a), e.n);
      if (d < margin) {
        q = add(q, mul(e.n, margin - d));
        moved = true;
      }
    }
    if (!moved) break;
  }
  return q;
}

/**
 * Canvas rotation, in radians, that puts `edge` at the BOTTOM of the viewer's
 * screen with the arena interior above it (SPEC §5.2, I6).
 *
 * Screen y grows downward, so "bottom" is the +y direction, i.e. angle +pi/2.
 * A viewer with no wall of their own (the teacher, a spectator) passes null
 * and gets 0, the canonical unrotated arena: seat 0 at the bottom for a
 * polygon, and seat 0 on the left for the 2-player court, which stays
 * horizontal so the teacher's view of it reads as ordinary Pong.
 */
export function viewRotation(edge: Edge | null): number {
  if (!edge) return 0;
  return Math.PI / 2 - Math.atan2(edge.mid.y, edge.mid.x);
}
