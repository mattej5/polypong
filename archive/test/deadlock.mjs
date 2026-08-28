// Deadlock and termination regression suite. Headless: no http, no ws, no
// server — it drives Room directly with a fixed dt, so it runs far faster than
// real time and is deterministic in structure if not in seed.
//
//   node test/deadlock.mjs
//
// Every case below FAILS on the code as it stood before the placement/pause
// fix, which is the only reason to keep them: they are the oracle, not decor.
import { readFile } from 'node:fs/promises';
import { Room } from '../src/net/room.js';
import { Game } from '../src/game.js';
import { QUIZ } from '../src/quiz-config.js';

const raw = JSON.parse(await readFile(new URL('../server/question-sets.json', import.meta.url), 'utf8'));
const SETS = Array.isArray(raw) ? raw : raw.sets;
const DT = 1 / 60;
const BUDGET = 1200;          // sim seconds; a real match runs 50-250

let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `\n        ${note}` : ''}`);
  if (!ok) failed++;
};

function room({ humans = 0, bots = 3, sets = SETS, teacher = false } = {}) {
  const r = new Room({ send: () => {}, broadcast: () => {}, sets });
  r.join(1, true); r.message(1, { t: 'hello', role: 'display' });
  if (teacher) { r.join(2); r.message(2, { t: 'hello', role: 'teacher' }); }
  for (let i = 0; i < humans; i++) {
    const id = 10 + i;
    r.join(id); r.message(id, { t: 'hello', role: 'player', name: `S${i}` });
  }
  r.message(1, { t: 'cfg', bots });
  r.message(1, { t: 'start' });
  return r;
}
const until = (r, pred, budget = BUDGET) => {
  let t = 0;
  while (t < budget && !pred(r)) { r.tick(DT); t += DT; }
  return +t.toFixed(2);
};

// ---------------------------------------------------------------- termination
// The load-bearing property. A question fires after every elimination, which is
// exactly when PLACEMENT begins, and with autoAdvance off (the default) an
// unanswered question never closes — so "nobody answers" is the normal
// classroom case, not an edge case, and it must still reach gameover.
function playOut(cfg, answerMode) {
  const r = room(cfg);
  const seenQ = new Set();
  const ids = Array.from({ length: cfg.humans || 0 }, (_, i) => 10 + i);
  let t = 0;
  while (t < BUDGET && r.game.state !== 'gameover') {
    r.tick(DT); t += DT;
    if (r.quiz.open && answerMode !== 'never' && !seenQ.has(r.quiz.current.qid)) {
      const q = r.quiz.current;
      seenQ.add(q.qid);
      ids.forEach((id, i) => {
        if (answerMode === 'half' && i % 2) return;
        const c = answerMode === 'wrong' ? (q.correct + 1) % q.options.length : q.correct;
        r.message(id, { t: 'ans', qid: q.qid, c });
      });
    }
  }
  return { r, t: +t.toFixed(1), done: r.game.state === 'gameover' };
}

console.log('\n-- matches always terminate --');
for (const [name, cfg, mode] of [
  ['3 bots, no students',                { humans: 0, bots: 3 }, 'never'],
  ['3 bots + 1 student who never answers', { humans: 1, bots: 3 }, 'never'],
  ['3 bots + 1 student, all correct',      { humans: 1, bots: 3 }, 'always'],
  ['3 bots + 1 student, all wrong',        { humans: 1, bots: 3 }, 'wrong'],
  ['2 bots + 4 students, nobody answers',  { humans: 4, bots: 2 }, 'never'],
  ['2 bots + 4 students, half answer',     { humans: 4, bots: 2 }, 'half'],
  ['6 students, no bots, all correct',     { humans: 6, bots: 0 }, 'always'],
  ['8 students, nobody answers',           { humans: 8, bots: 0 }, 'never'],
  ['no question sets loaded at all',       { humans: 1, bots: 3, sets: [] }, 'never'],
]) {
  const runs = Array.from({ length: 4 }, () => playOut(cfg, mode));
  const stuck = runs.find((x) => !x.done);
  check(name, !stuck,
    stuck ? `stuck in ${stuck.r.game.state} paused=${stuck.r.game.paused} quizOpen=${stuck.r.quiz.open} pending=${stuck.r.game.pending.length}`
          : `${Math.min(...runs.map((x) => x.t))}-${Math.max(...runs.map((x) => x.t))}s`);
}

console.log('\n-- placement is never starved --');
{
  // No quiz anywhere: an eliminated student who never presses DROP must not be
  // able to freeze the match on their own.
  const r = room({ humans: 1, bots: 3, sets: [] });
  const t = until(r, (x) => x.game.state === 'gameover');
  check('a student who never places their hazard cannot stall the match',
    r.game.state === 'gameover', `${t}s`);
}
{
  // The intersection of the two bugs: a question closing while a hazard
  // placement is still pending.
  const r = room({ humans: 1, bots: 3, teacher: true });
  until(r, (x) => x.game.state === 'placement' && x.quiz.open);
  const setup = r.game.state === 'placement' && r.quiz.open && r.game.pending.length === 1;
  r.message(10, { t: 'ans', qid: r.quiz.current.qid, c: r.quiz.current.correct });
  const noStack = r.game.state === 'placement' && r.game.countdownServes === true;
  const seen = [];
  let last = r.game.state, t = 0;
  while (t < 120 && !(r.game.state === 'playing' && r.game.balls.length > 0)) {
    r.tick(DT); t += DT;
    if (r.game.state !== last) { seen.push(r.game.state); last = r.game.state; }
  }
  check('question open during PLACEMENT (setup reached)', setup);
  check('closing it arms no resume hold, so countdowns cannot stack', noStack);
  check('placement still resolves and the match serves',
    r.game.state === 'playing' && seen.filter((s) => s === 'countdown').length === 1,
    `path ${seen.join(' -> ')} in ${t.toFixed(1)}s, hazards=${r.game.hazards.length}`);
}

{
  // A teacher pause must not burn a student's hazard, but must not stall a
  // bot's either — bots are what keep PLACEMENT moving at all.
  const r = room({ humans: 1, bots: 3 });
  until(r, (x) => x.game.state === 'placement' && !x.game.pending[0].player.isBot);
  r.message(1, { t: 'pause', on: true });
  const before = r.game.pending.length;
  for (let i = 0; i < 60 * 40; i++) r.tick(DT);
  const heldForStudent = r.game.pending.length === before && r.game.state === 'placement';
  r.message(1, { t: 'pause', on: false });
  const t = until(r, (x) => x.game.state === 'gameover');
  check('a teacher pause holds a student\'s placement clock, not the match',
    heldForStudent && r.game.state === 'gameover', `resumed and finished in ${t}s`);
}
{
  // ...and a bot at the head of the queue is never held by anything.
  const r = room({ humans: 0, bots: 4 });
  until(r, (x) => x.game.state === 'placement');
  r.message(1, { t: 'pause', on: true });
  const t = until(r, (x) => x.game.state !== 'placement', 30);
  check('a bot placement resolves even while the room is paused',
    r.game.state !== 'placement', `resolved in ${t}s while paused=${r.game.paused}`);
}

console.log('\n-- resume countdown after a question --');
{
  const r = room({ humans: 1, bots: 3, teacher: true });
  until(r, (x) => x.game.state === 'playing' && x.game.balls.length === 1 && x.game.round > 1);
  const b = r.game.balls[0];
  const p0 = { ...b.p }, v0 = { ...b.v }, id0 = b.id, round0 = r.game.round;
  r.message(2, { t: 'qask' });                       // teacher asks mid-rally
  const froze = r.game.paused === true && r.quiz.open;
  r.tick(DT);
  r.message(10, { t: 'ans', qid: r.quiz.current.qid, c: r.quiz.current.correct });
  const held = r.game.state === 'countdown' && r.game.countdownServes === false;
  const timer = r.game.timer;
  const bf = r.game.balls[0];
  const inPlace = bf && bf.p.x === p0.x && bf.p.y === p0.y && bf.v.x === v0.x && bf.v.y === v0.y;
  const dur = until(r, (x) => x.game.state !== 'countdown', 30);
  check('a question mid-rally freezes the arena', froze);
  check('closing it holds the ball for resumeCountdownSec',
    held && Math.abs(timer - QUIZ.resumeCountdownSec) < 0.05, `timer=${timer.toFixed(2)}s`);
  check('the ball is frozen in place, never re-served',
    inPlace && r.game.balls[0].id === id0 && r.game.round === round0);
  check('play resumes when the hold expires',
    r.game.state === 'playing' && Math.abs(dur - QUIZ.resumeCountdownSec) < 0.1, `held ${dur}s`);
}
{
  // A cadence question fires at a rally end, where a serve countdown is already
  // coming. Two stacked countdowns there would look broken.
  const r = room({ humans: 1, bots: 3 });
  until(r, (x) => x.quiz.open);
  const ballsAtAsk = r.game.balls.length;
  until(r, (x) => !x.game.paused, BUDGET);
  check('a question at a natural break stacks no second countdown',
    ballsAtAsk === 0 && r.game.countdownServes === true);
}

console.log('\n-- invariants --');
{
  const r = room({ humans: 2, bots: 2, teacher: true });
  until(r, (x) => x.game.state === 'playing' && x.game.balls.length > 0 && x.game.round > 1);
  r.message(2, { t: 'qask' }); r.tick(DT);
  r.message(10, { t: 'ans', qid: r.quiz.current.qid, c: 0 });
  r.message(11, { t: 'ans', qid: r.quiz.current.qid, c: 0 });
  const snap = JSON.parse(JSON.stringify(r.game.snapshot()));
  const rep = new Game(); rep.setViewport(1000, 1000, 1); rep.applySnapshot(snap);
  const s2 = rep.snapshot();
  const same = (k) => JSON.stringify(s2[k]) === JSON.stringify(snap[k]);
  const dPaddle = Math.max(...s2.pl.map((q, i) => Math.abs(q.s - snap.pl[i].s)));
  check('snapshot round-trips, including during a resume hold',
    s2.st === snap.st && s2.tm === snap.tm && s2.rd === snap.rd &&
    same('bl') && same('hz') && same('pd') && same('gh') && dPaddle < 1e-4,
    `state=${snap.st} paddle delta=${dPaddle.toExponential(2)} (4dp quantization)`);
}
{
  const src = await readFile(new URL('../src/net/room.js', import.meta.url), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hits = [...new Set([...bare.matchAll(
    /\b(require|setTimeout|setInterval|setImmediate|Date\.now|fetch|process|window|document|WebSocket)\b/g,
  )].map((m) => m[0]))];
  check('Room still owns zero runtime APIs', hits.length === 0, hits.join(', '));
}
{
  let worst = 0, unfinished = 0;
  for (let n = 0; n < 8; n++) {
    const { r, done } = playOut({ humans: 6, bots: 2 }, 'always');
    if (!done) unfinished++;
    worst = Math.max(worst, ...r.reviveUsed);
  }
  check('the revive budget still bounds the match',
    unfinished === 0 && worst <= QUIZ.reviveMaxPerStudent,
    `worst=${worst} cap=${QUIZ.reviveMaxPerStudent} unfinished=${unfinished}`);
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
