// Paddle-direction regression suite. Headless: pure geometry + Game, no http,
// no ws, no server, no client/DOM.
//
//   node test/paddle-direction.mjs
//
// The bug: a paddle can only move along its own edge, and every edge shares
// one polygon-winding direction (`edge.dir`) — so "+dir" reads as rightward on
// one edge and leftward, upward, or downward on the next. A human's
// ArrowRight/D key means only one thing regardless of which edge they hold:
// the direction their own right hand points while facing into the arena.
// `edge.rightSign` (geometry.js's makeEdge) is the correction; play.js,
// arena.js, and main.js all multiply the raw key direction by it before the
// value reaches Game.setInput. This file is the oracle for that correction —
// it fails if `rightSign` is ever removed or miscomputed.
import { Game, STATE } from '../src/game.js';
import * as G from '../src/geometry.js';

let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `\n        ${note}` : ''}`);
  if (!ok) failed++;
};

console.log('\n-- every seat\'s "right" key must move its paddle toward its own local right --');
for (const n of [2, 3, 4, 5, 6, 7, 8]) {
  const g = new Game();
  g.setViewport(1000, 1000, 1);
  g.start(n, n);
  g.state = STATE.PLAYING;   // skip countdown; paddle updates apply immediately
  for (let slot = 0; slot < n; slot++) { g.players[slot].isBot = false; g.players[slot].inputDir = 0; }

  for (let slot = 0; slot < n; slot++) {
    const p = g.players[slot];
    const before = p.paddle.center(p.edge);
    // What every client (play.js/arena.js/main.js) now sends for "the right
    // key was pressed": the raw +1 corrected by this seat's edge.
    const corrected = 1 * p.edge.rightSign;
    p.inputDir = corrected;
    for (let i = 0; i < 10; i++) p.paddle.update(p.edge, p.inputDir, 1 / 60);
    const after = p.paddle.center(p.edge);
    const moveVec = G.sub(after, before);

    // "Local right" = facing into the arena (edge.n, already inward-pointing
    // — see makeEdge), rotated 90 degrees. This is independent of polygon
    // winding, so it's the correctness oracle the fix is checked against.
    const rightVec = G.rot(p.edge.n, Math.PI / 2);
    const alignment = G.dot(G.norm(moveVec), rightVec);
    check(`n=${n} slot=${slot}: right key moves paddle toward local right`,
      alignment > 0.99, `alignment=${alignment.toFixed(3)} (1.0 = perfectly aligned)`);
  }
}

console.log('\n-- the left key must be the exact opposite --');
{
  const g = new Game();
  g.setViewport(1000, 1000, 1);
  g.start(5, 5);
  g.state = STATE.PLAYING;
  const p = g.players[2];
  p.isBot = false;
  const before = p.paddle.center(p.edge);
  p.inputDir = -1 * p.edge.rightSign;
  for (let i = 0; i < 10; i++) p.paddle.update(p.edge, p.inputDir, 1 / 60);
  const after = p.paddle.center(p.edge);
  const moveVec = G.sub(after, before);
  const rightVec = G.rot(p.edge.n, Math.PI / 2);
  const alignment = G.dot(G.norm(moveVec), rightVec);
  check('left key moves paddle away from local right', alignment < -0.99,
    `alignment=${alignment.toFixed(3)} (-1.0 = perfectly opposite)`);
}

console.log('\n-- bots must be unaffected: they steer via edge.dir directly, not rightSign --');
{
  const g = new Game();
  g.setViewport(1000, 1000, 1);
  g.start(3, 3);
  g.state = STATE.PLAYING;
  const before = g.players.map((p) => p.paddle.s);
  for (let i = 0; i < 300; i++) g.update(1 / 60);
  const after = g.players.map((p) => p.paddle.s);
  const moved = before.some((s, i) => s !== after[i]);
  check('an all-bot match still moves paddles (AI targeting untouched)', moved);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exitCode = failed ? 1 : 0;
