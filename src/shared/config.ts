// Every tuning constant in the project lives here. Nothing else defines a
// magic number that affects how the game feels.
//
// SPEC §11. Values marked "ported" came from the previous build, where they
// were tuned against real play; changing one is a gameplay decision, not a
// cleanup.

/** Injected randomness. `shared/` never calls Math.random directly (SPEC I12). */
export type Rng = () => number;

// ---------------------------------------------------------------- identity

// Saturation and lightness are pinned; hue is the only thing that varies per
// seat, so eight players read as one system instead of eight unrelated
// swatches. The hues are spaced unevenly — wider through green/cyan where the
// eye separates hue poorly, tighter through red/amber where it separates it
// well — and then ORDERED so no two seats on neighbouring walls land in the
// same colour band. The arena is a ring of the first N seats, so seat 3 sits
// beside seat 4 at every player count; this order keeps every such pair at
// least 60 degrees apart for every N from 2 to 8. (ported)
const HUES = [288, 92, 228, 50, 192, 352, 152, 24];
const SAT = 86;
const LIGHT = 62;

export const MAX_SEATS = 8;

export const COLORS: readonly string[] = HUES.map((h) => `hsl(${h}, ${SAT}%, ${LIGHT}%)`);

/** CRT vocabulary — reads better than "BOT 4" on a projector. (ported) */
export const BOT_NAMES: readonly string[] = [
  'CATHODE', 'PHOSPHOR', 'RASTER', 'TRACE',
  'BEAM', 'VECTOR', 'GLITCH', 'SCANLINE',
];

export const NAME_MAX_LEN = 10;

// ------------------------------------------------------------------ physics
// All lengths are fractions of the arena radius; all speeds are arena radii
// per second. The simulation runs in a fixed virtual space and never sees a
// pixel. (ported unless noted)

export const T = {
  ballRadius: 0.017,
  ballSpeed: 0.92,
  ballSpeedMax: 2.10,
  ballSpeedGain: 1.035,       // per paddle hit
  ballSpeedMin: 0.42,         // floor, so a grazing return cannot stall
  paddleFrac: 0.30,           // fraction of the edge it covers
  paddleFracMin: 0.16,
  paddleSpeed: 1.5,           // edge lengths per second
  paddleWidth: 0.020,
  botSpeed: 0.78,             // multiplier on paddle speed
  botError: 0.34,             // fraction of edge length of aim jitter
  botReact: 0.16,             // seconds of reaction lag
  spinTransfer: 0.22,         // how much paddle velocity carries into the ball
  spinOffsetGain: 0.62,       // how much off-centre contact curves the return
  spinMaxTangent: 0.86,       // clamp, so a return can never run along the wall
  hazardRadius: 0.45,         // field radius
  hazardMargin: 0.14,         // kept clear of the walls
  hazardCenterClear: 0.30,    // never on top of the serve point
  blackHolePull: 4.0,         // arena radii / s^2 at the core
  sunPush: 3.2,
  sunHeat: 6.0,               // seconds the ball stays hot
  hotCost: 2,                 // lives lost to a hot ball
  fieldGripMax: 2.6,          // anti-orbit: max seconds of continuous pull
  splitEvery: 3,              // rounds between splitter spawns
  splitAngle: 0.42,
  maxBalls: 7,
  stallTimeout: 10,           // seconds before the round starts speeding up
  stallAccel: 0.30,           // speed gain per second past the stall timeout
  subStepMaxTravel: 0.02,     // arena radii per sub-step; makes SPEC I7 true
  wallWidth: 0.0045,
  deadWallWidth: 0.0060,
} as const;

// -------------------------------------------------------------------- visual
// A CRT beam is the same stroke drawn a few times under `lighter`: wide and
// faint outside, thin and full-strength in the middle. Outermost first.
// There is no shadowBlur and no gradient anywhere — SPEC §9, constraint C2.

export const GLOW = {
  width: [4.6, 2.2, 1.0],   // lineWidth multipliers
  alpha: [0.10, 0.26, 1.0], // alpha multipliers
  radius: [2.4, 1.5, 1.0],  // radius multipliers, for dots
} as const;

// ------------------------------------------------------------------- timing
// SPEC §6.4 and §11. Every one of these is a server-owned deadline; none of
// them can be extended by a client. This is what makes SPEC I1 true.

export const TIMING = {
  tickHz: 60,
  snapHz: 30,
  startCountdown: 2.2,     // seconds before the first serve of a match
  resumeCountdown: 3.0,    // the 3-2-1 after a question
  resultHold: 3.0,         // showing the correct answer
  announceHold: 2.0,       // "RILEY IS OUT"
  serveDelay: 0.7,         // between a point and the next serve
  matchOverHold: 0,        // 0 = holds forever; the teacher advances it
} as const;

// ------------------------------------------------------------------ settings

export interface MatchSettings {
  /** Seats in play, 2..8. Bots fill whatever students have not claimed. */
  arenaSize: number;
  questionsEnabled: boolean;
  setId: string | null;
  questionTimerSec: number;
  /** Times one student may come back from the dead in one match, 0..3. */
  revivesPerStudent: number;
  lives: number;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  arenaSize: 4,
  questionsEnabled: true,
  setId: null,
  questionTimerSec: 30,
  revivesPerStudent: 1,
  lives: 3,
};

export const SETTING_RANGE = {
  arenaSize: [2, MAX_SEATS],
  questionTimerSec: [10, 120],
  revivesPerStudent: [0, 3],
  lives: [3, 5],
} as const;

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
};

/** Coerce anything off the wire into legal settings. Never throws. */
export function sanitizeSettings(
  patch: Partial<MatchSettings>,
  base: MatchSettings = DEFAULT_SETTINGS,
): MatchSettings {
  return {
    arenaSize: clampInt(patch.arenaSize ?? base.arenaSize, ...SETTING_RANGE.arenaSize, base.arenaSize),
    questionsEnabled: patch.questionsEnabled ?? base.questionsEnabled,
    setId: patch.setId === undefined ? base.setId : patch.setId,
    questionTimerSec: clampInt(
      patch.questionTimerSec ?? base.questionTimerSec,
      ...SETTING_RANGE.questionTimerSec,
      base.questionTimerSec,
    ),
    revivesPerStudent: clampInt(
      patch.revivesPerStudent ?? base.revivesPerStudent,
      ...SETTING_RANGE.revivesPerStudent,
      base.revivesPerStudent,
    ),
    lives: clampInt(patch.lives ?? base.lives, ...SETTING_RANGE.lives, base.lives),
  };
}

export const PORT = 5080;
