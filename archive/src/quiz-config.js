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
  // TERMINATION. The arena freeze that comes with an open question is bounded,
  // even though the question itself is not. Once every student's clock has run
  // out this many seconds go by and then the ball resumes, while the question
  // stays open for anyone still working. Without this an unanswered question --
  // the normal case with autoAdvance off -- froze the match permanently.
  freezeGraceSec: 20,
  // FAIRNESS. When the arena comes back after a question the ball is frozen
  // where it stands for this long, with the count on the arena screen and on
  // every student pad, so nobody loses a life to a ball that moved while they
  // were reading. Frozen in place, never re-served: a fresh serve from the
  // centre would be a free reset for whoever was about to concede.
  resumeCountdownSec: 3,
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
  // TERMINATION. Simulated against the real game: an uncapped revive never
  // ends, and capping the *rate* does not fix it either -- a question fires
  // after every elimination, so rate-capped revives just track the
  // elimination rate and the match reaches equilibrium instead of finishing.
  // A lifetime budget bounds the total lives in play, so the match is
  // guaranteed to end and its length stops depending on how well the class
  // knows the material. 2 finishes in ~8 min at every accuracy tested.
  reviveMaxPerStudent: 2,    // lifetime revives per student. THIS is what terminates.
  reviveMaxPerQuestion: 1,   // stops one easy question mass-reviving the field
  reviveMinAlive: 4,         // no revives once the match is down to 3 -- clean endgame

  // ------------------------------------------------------------------ limits
  maxSets: 40,
  maxQuestionsPerSet: 300,
  maxFieldChars: 400,
};
