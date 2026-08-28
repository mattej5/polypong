export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a) => {
  const l = Math.hypot(a.x, a.y) || 1;
  return { x: a.x / l, y: a.y / l };
};
export const rot = (a, r) => {
  const c = Math.cos(r), s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function makeEdge(a, b, owner, center) {
  const d = sub(b, a);
  const length = len(d);
  const dir = mul(d, 1 / length);
  let n = { x: -dir.y, y: dir.x };
  const mid = lerp(a, b, 0.5);
  if (dot(sub(center, mid), n) < 0) n = mul(n, -1);
  // `dir` is a pure artifact of polygon winding — every edge shares one
  // rotational sense around the arena, so "+dir" is rightward on one edge and
  // leftward, upward, or downward on the next. A human's ArrowRight/D key
  // means only one thing: the direction their own right hand points while
  // facing the arena (facing along `n`, which already points inward — see
  // above). That's `n` rotated 90°; `rightSign` is whichever sign of `dir`
  // agrees with it, so `inputDir * edge.rightSign` always reads as "their
  // right" no matter which edge they hold. Bots ignore this — their AI steers
  // by targeting a point along `dir` directly, never through a keypress.
  const right = rot(n, Math.PI / 2);
  const rightSign = dot(dir, right) < 0 ? -1 : 1;
  return { a, b, dir, n, length, owner, mid, rightSign };
}

/**
 * Builds the arena for `n` active players.
 * n >= 3 -> regular n-gon, every edge is a goal.
 * n == 2 -> classic rectangle, left/right are goals, top/bottom are solid walls.
 * Edge k belongs to the k-th surviving player.
 */
export function buildArena(n, cx, cy, R) {
  const center = { x: cx, y: cy };
  const edges = [];
  const verts = [];

  if (n <= 2) {
    const hw = R * 1.02, hh = R * 0.70;
    const bl = { x: cx - hw, y: cy + hh };
    const tl = { x: cx - hw, y: cy - hh };
    const tr = { x: cx + hw, y: cy - hh };
    const br = { x: cx + hw, y: cy + hh };
    verts.push(tl, tr, br, bl);
    edges.push(makeEdge(bl, tl, 0, center));    // left goal, dir = up
    edges.push(makeEdge(br, tr, 1, center));    // right goal, dir = up
    edges.push(makeEdge(tl, tr, null, center)); // top wall
    edges.push(makeEdge(bl, br, null, center)); // bottom wall
    return { edges, verts, center, R, n: 2, inradius: hh };
  }

  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const ang = -Math.PI / 2 + (i + 0.5) * step;
    verts.push({ x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R });
  }
  for (let i = 0; i < n; i++) {
    edges.push(makeEdge(verts[i], verts[(i + 1) % n], i, center));
  }
  return { edges, verts, center, R, n, inradius: R * Math.cos(Math.PI / n) };
}

export function insideArena(arena, p, margin = 0) {
  for (const e of arena.edges) {
    if (dot(sub(p, e.a), e.n) < margin) return false;
  }
  return true;
}

/** Nearest point to `p` that sits at least `margin` inside every wall. */
export function clampInside(arena, p, margin) {
  let q = { x: p.x, y: p.y };
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
