export const COLORS = [
  '#ff4d6d', '#4dd2ff', '#7cff4d', '#ffd24d',
  '#b44dff', '#ff8f4d', '#4dffd2', '#ff4de0',
];

// Key pairs: [counter-clockwise, clockwise]. In 2-player mode they read as [up, down].
export const KEY_PAIRS = [
  ['KeyA', 'KeyD'],
  ['ArrowLeft', 'ArrowRight'],
  ['KeyJ', 'KeyL'],
  ['Digit4', 'Digit6'],
  ['KeyZ', 'KeyC'],
  ['KeyN', 'KeyM'],
  ['KeyT', 'KeyU'],
  ['Digit7', 'Digit9'],
];

export const KEY_LABELS = [
  'A / D', '← / →', 'J / L', '4 / 6',
  'Z / C', 'N / M', 'T / U', '7 / 9',
];

// CRT vocabulary — reads better than "BOT 4" on a projector.
export const BOT_NAMES = [
  'CATHODE', 'PHOSPHOR', 'RASTER', 'TRACE',
  'BEAM', 'VECTOR', 'GLITCH', 'SCANLINE',
];

export const T = {
  lives: 3,
  ballRadius: 0.017,          // fraction of arena radius
  ballSpeed: 0.92,            // arena radii per second
  ballSpeedMax: 2.10,
  ballSpeedGain: 1.035,       // per paddle hit
  paddleFrac: 0.30,           // fraction of the edge it covers
  paddleFracMin: 0.16,
  paddleSpeed: 1.5,           // edge lengths per second
  botSpeed: 0.78,             // multiplier on paddle speed
  botError: 0.34,             // fraction of edge length of aim jitter
  botReact: 0.16,             // seconds of lag
  deflect: 0.75,              // radians of english at the paddle tip
  spinTransfer: 0.22,
  countdown: 2.2,
  serveDelay: 0.7,
  hazardRadius: 0.45,         // fraction of arena radius
  blackHolePull: 4.0,        // arena radii / s^2 at the core
  sunPush: 3.2,
  sunHeat: 6.0,               // seconds the ball stays hot
  hotCost: 2,                 // lives lost by a hot ball
  fieldGripMax: 2.6,          // anti-orbit: seconds a ball can be pulled continuously
  splitEvery: 3,              // rounds between splitter spawns
  splitAngle: 0.42,
  maxBalls: 7,
  hazardMargin: 0.14,        // fraction of arena radius kept clear of the walls
  hazardCenterClear: 0.30,   // hazards never sit on top of the serve point
  stallTimeout: 10,           // seconds before the round starts speeding up
};
