// CRT beam primitives, ported from the previous build's render.js.
//
// ONE RULE holds this file together, and it is a hard performance constraint
// (SPEC constraint C2, §9), not a stylistic preference:
//
//   Glow is ADDITIVE, never blurred.
//
// Under `globalCompositeOperation = 'lighter'`, drawing the SAME path three
// times — wide and faint, then narrower, then thin and full strength — costs
// three ordinary strokes. The overlapping alpha sums, so the middle of the
// stroke saturates to white-hot while the edges stay in the seat hue. That is
// the entire effect.
//
// The canvas shadow-blur property produces a similar picture and costs a
// full-surface Gaussian blur PER DRAW. It is the single slowest thing a
// Chromebook can be asked to do in Canvas 2D, and at eight players with seven
// balls and particles it is the difference between 60fps and single digits.
// Canvas gradients are the same trade: an object allocated and rasterised per
// frame to fake a falloff that three strokes already give for free.
//
// Neither shadow blur nor any gradient constructor appears anywhere in
// `src/client/view/`. A grep for those API names is part of this lane's
// acceptance check, so they are not written out here either — a comment that
// names them would trip the gate that exists to catch a real one.
//
// Every function below assumes composite is ALREADY 'lighter'. None of them
// set or restore it: doing that per primitive would be dozens of state
// transitions a frame for a flag that is true for the whole world pass.

import { GLOW } from '../../shared/config';

const TAU = Math.PI * 2;
const LAYERS = GLOW.width.length;

/**
 * Strokes whatever path is currently built, once per glow layer.
 *
 * Canvas keeps the current path across `stroke()` calls, so a caller builds
 * geometry once and pays only for the rasterisation of each layer. Every
 * primitive here is a thin wrapper around that fact.
 *
 * `layers` counts inward from the thin core: 1 = core only (cheap, for the
 * many dim walls), 3 = full halo (for the few things that must shout).
 */
export function beamStroke(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
  alpha: number,
  layers: number = LAYERS,
): void {
  ctx.strokeStyle = color;
  for (let i = LAYERS - layers; i < LAYERS; i++) {
    ctx.globalAlpha = alpha * GLOW.alpha[i]!;
    ctx.lineWidth = width * GLOW.width[i]!;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function beamLine(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  color: string,
  width: number,
  alpha: number,
  layers?: number,
): void {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  beamStroke(ctx, color, width, alpha, layers);
}

/**
 * Polyline from a flat [x0,y0,x1,y1,...] buffer. Flat because the things that
 * use it — ball trails, particle streaks — are preallocated Float32Arrays that
 * never produce a `{x, y}` object in the per-frame path.
 */
export function beamPolyline(
  ctx: CanvasRenderingContext2D,
  pts: Float32Array | readonly number[],
  start: number,
  count: number,
  closed: boolean,
  color: string,
  width: number,
  alpha: number,
  layers?: number,
): void {
  if (count < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[start * 2]!, pts[start * 2 + 1]!);
  for (let i = 1; i < count; i++) {
    const k = (start + i) * 2;
    ctx.lineTo(pts[k]!, pts[k + 1]!);
  }
  if (closed) ctx.closePath();
  beamStroke(ctx, color, width, alpha, layers);
}

/** Builds a closed polygon path WITHOUT stroking it. For `ctx.clip()`. */
export function polygonPath(
  ctx: CanvasRenderingContext2D,
  pts: readonly { readonly x: number; readonly y: number }[],
): void {
  ctx.beginPath();
  const first = pts[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

/**
 * A filled dot with a halo. Unlike the stroke primitives this rebuilds the arc
 * per layer, because the halo comes from a larger RADIUS rather than a wider
 * line — `GLOW.radius` instead of `GLOW.width`.
 */
export function beamDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < LAYERS; i++) {
    ctx.globalAlpha = alpha * GLOW.alpha[i]!;
    ctx.beginPath();
    ctx.arc(x, y, r * GLOW.radius[i]!, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export function beamArc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  a0: number,
  a1: number,
  color: string,
  width: number,
  alpha: number,
  layers?: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, a0, a1);
  beamStroke(ctx, color, width, alpha, layers);
}

export function beamRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  width: number,
  alpha: number,
  layers?: number,
): void {
  beamArc(ctx, x, y, r, 0, TAU, color, width, alpha, layers);
}

// ----------------------------------------------------------------- text
// Setting ctx.font parses a CSS font shorthand every time, and the readability
// layer sets it for eight wall labels plus pips plus the HUD every frame. The
// cache below skips the assignment when the string has not changed; it is
// reset once per frame in case something outside this module touched the
// context.

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

let lastFont = '';

/**
 * Font shorthand strings, memoised.
 *
 * Label size is derived from the fit scale, which moves every frame while the
 * view rotation eases, so `${weight} ${size}px ${MONO}` would allocate a fresh
 * string per label per frame — exactly the per-frame garbage the C2 budget
 * forbids. Sizes are quantised to whole pixels (nobody can see half a pixel of
 * type) and the table is bounded, so a pathological run of sizes costs one
 * flush rather than unbounded growth.
 */
const FONT_W: number[] = [];
const FONT_S: number[] = [];
const FONT_STR: string[] = [];

export function monoFont(weight: number, sizePx: number): string {
  const s = Math.round(sizePx);
  for (let i = 0; i < FONT_STR.length; i++) {
    if (FONT_S[i] === s && FONT_W[i] === weight) return FONT_STR[i]!;
  }
  if (FONT_STR.length >= 64) {
    FONT_W.length = 0;
    FONT_S.length = 0;
    FONT_STR.length = 0;
  }
  const str = `${weight} ${s}px ${MONO}`;
  FONT_W.push(weight);
  FONT_S.push(s);
  FONT_STR.push(str);
  return str;
}

export function resetFontCache(): void {
  lastFont = '';
}

export function setFont(ctx: CanvasRenderingContext2D, font: string): void {
  if (font !== lastFont) {
    ctx.font = font;
    lastFont = font;
  }
}

/**
 * Glowing text. Two draws, not three: a wide faint `strokeText` for the halo
 * and one `fillText` for the core. Text rasterisation is the most expensive
 * thing in the readability layer, so it gets the cheapest glow that still
 * reads as part of the same CRT, and `halo = false` drops it to one draw for
 * anything small or numerous.
 */
export function beamText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  alpha: number,
  halo = true,
): void {
  setFont(ctx, font);
  if (halo) {
    ctx.globalAlpha = alpha * GLOW.alpha[1]!;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.strokeText(text, x, y);
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}
