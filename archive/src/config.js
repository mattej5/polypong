// Vector-CRT palette. Saturation and lightness are pinned and hue is the only
// thing that changes per seat, so eight players read as one system instead of
// eight unrelated swatches. The eight hues are spaced unevenly around the
// wheel — wider through green/cyan, where the eye separates hue poorly, tighter
// through red/amber, where it separates it well — and then ORDERED so that no
// two seats sitting on neighbouring walls land in the same colour band. The
// arena is a ring of the first N seats, so seat 3 sits next to seat 4 at every
// player count; this order keeps every such pair at least 60 degrees apart for
// every N from 2 to 8.
const HUES = [288, 92, 228, 50, 192, 352, 152, 24];
const SAT = 86;
const LIGHT = 62;

export const COLORS = HUES.map((h) => `hsl(${h}, ${SAT}%, ${LIGHT}%)`);

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

  // --- visual only, no gameplay effect ---------------------------------
  // A CRT beam is the same stroke drawn a few times under `lighter`: wide and
  // faint on the outside, thin and full-strength in the middle. Outermost first.
  glowW: [4.6, 2.2, 1.0],     // lineWidth multipliers
  glowA: [0.10, 0.26, 1.0],   // alpha multipliers
  glowR: [2.4, 1.5, 1.0],     // radius multipliers, for dots
  paddleWidth: 0.020,         // fraction of arena radius
  wallWidth: 0.0045,
  deadWallWidth: 0.0060,
};
