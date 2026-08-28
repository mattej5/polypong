// The overlay. Screen space, NEVER rotated.
//
// Everything in `render.ts` lives in arena units under a rotated transform.
// Everything here is drawn in CSS pixels against the viewport, so it is
// unaffected by the view rotation, by the fit scale, and by screen shake.
// That is the point: when the arena is shaking and the world has just eased
// through 40 degrees because someone was eliminated, the one thing on screen
// that says who you are and how many lives you have must sit perfectly still.

import type { Scene } from './render';
import { drawPips } from './render';
import { beamText, monoFont, resetFontCache, setFont } from './beam';

const HUD_DIM = 'hsl(216, 34%, 74%)';

/** Countdown digits, preallocated. `String(n)` every frame is free garbage. */
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** `name + " - WATCHING"` memoised on the name, for the same reason. */
let watchName = '';
let watchLine = '';

/**
 * `render` calls this last, with composite already back to 'source-over'.
 * Text here is deliberately NOT additive: the banner and the countdown have to
 * be legible over whatever the arena is doing behind them, and 'lighter' text
 * over a bright hazard field washes out.
 */
export function drawHud(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { w, h } = scene.viewport;
  resetFontCache();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  drawBanner(ctx, scene, w, h);
  drawCountdown(ctx, scene, w, h);
  drawSelf(ctx, scene, w, h);
}

/** Plain classroom English, straight from the server. SPEC §6.4 step 4. */
function drawBanner(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number): void {
  if (!scene.banner) return;
  const size = Math.max(14, Math.min(w, h) * 0.05);
  beamText(ctx, scene.banner, w / 2, h * 0.075, monoFont(800, size), '#ffffff', 0.95);
}

/**
 * The count is the whole message. The phase timer already says "wait", and the
 * arena you are about to play in is on screen behind it, so the number is
 * drawn large and nothing else is drawn with it.
 */
function drawCountdown(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  w: number,
  h: number,
): void {
  if (scene.phase !== 'countdown' && scene.phase !== 'resume') return;
  const n = Math.ceil(scene.timer);
  if (n <= 0) return;
  const size = Math.min(w, h) * 0.34;
  setFont(ctx, monoFont(800, size));
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(n < 10 ? DIGITS[n]! : String(n), w / 2, h / 2);
  ctx.globalAlpha = 1;
}

/**
 * The viewer's own name, colour, and life pips, bottom-centre against their
 * own wall (SPEC §8). This sits inside the bottom margin that
 * `camera.defaultMargins` reserved, so it never covers the arena.
 *
 * A spectator has no seat and no lives; they get the name line only, plus the
 * reason they are watching, because a blank strip reads as a broken page.
 */
function drawSelf(ctx: CanvasRenderingContext2D, scene: Scene, w: number, h: number): void {
  const me = scene.me;
  if (!me) return;

  const size = Math.max(12, Math.min(w, h) * 0.038);
  const baseY = h - size * 1.5;

  if (me.seat === null) {
    if (watchName !== me.name) {
      watchName = me.name;
      watchLine = `${me.name} - WATCHING`;
    }
    beamText(ctx, watchLine, w / 2, baseY, monoFont(700, size), HUD_DIM, 0.8, false);
    return;
  }

  const pipR = size * 0.24;
  const gap = pipR * 2.9;
  const pipsW = (me.maxLives - 1) * gap;
  const font = monoFont(800, size);
  setFont(ctx, font);
  const nameW = ctx.measureText(me.name).width;
  const total = nameW + size * 0.8 + pipsW + pipR * 2;

  const nameX = w / 2 - total / 2 + nameW / 2;
  const pipsX = w / 2 + total / 2 - pipsW / 2 - pipR;

  beamText(ctx, me.name, nameX, baseY, font, me.color, 1, false);
  drawPips(ctx, pipsX, baseY, pipR, gap, me.lives, me.maxLives, me.color);
}
