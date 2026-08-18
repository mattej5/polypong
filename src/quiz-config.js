// Tunables for the classroom quiz layer. Kept out of config.js on purpose:
// config.js is owned by the render lane. Nothing here is runtime-specific, so
// Room can import it under Node, a Durable Object, or a browser alike.

export const QUIZ = {
  // ---------------------------------------------------------------- cadence
  volleysPerQuestion: 3,     // a question after every Nth completed volley
  askOnElimination: true,    // ...and after every elimination

  // ------------------------------------------------------------------ timer
  defaultTimerSec: 30,       // teacher-set at runtime; this is only the boot value
  minTimerSec: 5,
  maxTimerSec: 600,
  extensionStepSec: 15,      // one tap of "+15s" for a single student
  maxExtensionSec: 900,

  // ------------------------------------------------------------- teacher UX
  // Auto-advance OFF by default: a question never closes while a student is
  // still working unless the teacher flips this on or presses "close now".
  autoAdvanceDefault: false,
  // Live correct/incorrect goes to the teacher console only. The projector
  // shows the question and a bare answered-count until the teacher opts in.
  projectResultsDefault: false,

  // ------------------------------------------------------- serve targeting
  // GUARDRAIL. A wrong answer *may* buy you the next serve, but a given
  // student cannot be aimed at again until this many rounds have gone by, and
  // the victim is drawn at random from everyone who missed. Without both of
  // these the weakest student in the room gets the ball every single volley in
  // front of the class.
  targetCooldownRounds: 4,
  targetProbability: 1.0,    // 0..1 chance the room aims at all after a miss

  // ---------------------------------------------------------------- revival
  // Eliminated students still answer; a correct answer is their way back in.
  reviveOnCorrect: true,
  reviveLives: 1,

  // ------------------------------------------------------------------ limits
  maxSets: 40,
  maxQuestionsPerSet: 300,
  maxFieldChars: 400,
};
