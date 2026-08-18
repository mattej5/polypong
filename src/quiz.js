// Question sets and the live question machine. Pure logic: no DOM, no fs, no
// timers, no network. The admin page imports it to preview a paste, and Room
// imports it to run the real thing, so the teacher's preview and the room's
// parse can never disagree.

import { QUIZ } from './quiz-config.js';

export const LETTERS = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------------- CSV

/**
 * RFC4180-ish reader. Handles quoted fields, embedded commas, doubled quotes
 * and CRLF, because a teacher pasting out of Sheets will produce all four.
 * Returns an array of rows; each row is an array of raw cell strings.
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false;   // this cell has at least one character or quote

  const endCell = () => { row.push(cell); cell = ''; started = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  const src = String(text ?? '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && !started) { quoted = true; started = true; continue; }
    if (ch === ',') { endCell(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
    started = true;
  }
  if (cell !== '' || row.length) endRow();
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const trimField = (v) => String(v ?? '').trim().slice(0, QUIZ.maxFieldChars);

/**
 * question,a,b,c,d,correct,topic
 *
 * `correct` is a letter A-D (case-insensitive; a bare 1-4 is accepted too
 * because teachers type it). `topic` is optional. Leaving c and d blank gives
 * a 2-option question — that is the accessibility mode, not a degenerate row,
 * so it parses clean with no warning.
 *
 * Returns { questions, errors, skippedHeader }. Bad rows are reported with
 * their 1-based line number and never silently dropped.
 */
export function parseQuestionCsv(text) {
  const rows = parseCsvRows(text);
  const questions = [];
  const errors = [];
  let skippedHeader = false;

  rows.forEach((raw, idx) => {
    const line = idx + 1;
    const cells = raw.map(trimField);

    if (idx === 0 && /^question$/i.test(cells[0] || '')) { skippedHeader = true; return; }

    const [q, a, b, c, d, correctRaw, topic] = cells;
    if (!q) { errors.push({ line, msg: 'no question text' }); return; }
    if (!a || !b) { errors.push({ line, msg: 'needs at least two options (a and b)' }); return; }

    const options = [a, b];
    if (c && d) options.push(c, d);
    else if (c || d) {
      errors.push({ line, msg: 'for a 2-option question leave BOTH c and d blank' });
      return;
    }

    const key = String(correctRaw || '').trim().toUpperCase();
    let correct = LETTERS.indexOf(key);
    if (correct < 0 && /^[1-4]$/.test(key)) correct = Number(key) - 1;
    if (correct < 0) {
      errors.push({ line, msg: `correct answer must be a letter A-D, got "${correctRaw || ''}"` });
      return;
    }
    if (correct >= options.length) {
      errors.push({
        line,
        msg: `correct answer is ${LETTERS[correct]} but this question only has ${options.length} options`,
      });
      return;
    }

    questions.push({ q, options, correct, topic: topic || '' });
  });

  if (questions.length > QUIZ.maxQuestionsPerSet) {
    errors.push({ line: 0, msg: `set truncated to ${QUIZ.maxQuestionsPerSet} questions` });
    questions.length = QUIZ.maxQuestionsPerSet;
  }
  return { questions, errors, skippedHeader };
}

/** Round-trips a parsed set back to CSV so the admin page can re-edit it. */
export function questionsToCsv(questions) {
  const esc = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = 'question,a,b,c,d,correct,topic';
  const body = questions.map((q) => [
    q.q, q.options[0], q.options[1], q.options[2] || '', q.options[3] || '',
    LETTERS[q.correct], q.topic || '',
  ].map(esc).join(','));
  return [head, ...body].join('\n');
}

// ------------------------------------------------------------------- engine

/**
 * One live question at a time.
 *
 * Closing rules, in priority order:
 *   1. every participant has answered            -> close
 *   2. teacher pressed "close now"               -> close
 *   3. every deadline expired AND autoAdvance    -> close
 * With autoAdvance off (the default) an expired timer only marks the question
 * "overtime"; it stays open so nobody is cut off mid-thought. Participants who
 * disconnect are dropped, so a dead Chromebook cannot stall the room forever.
 */
export class QuizEngine {
  constructor({ rand = Math.random } = {}) {
    this.rand = rand;
    this.sets = [];                       // [{ id, name, questions:[...] }]
    this.activeSetId = null;
    this.timerSec = QUIZ.defaultTimerSec;
    this.autoAdvance = QUIZ.autoAdvanceDefault;
    this.projectResults = QUIZ.projectResultsDefault;
    this.extensions = {};                 // slot -> seconds granted, persists across questions
    this.order = [];                      // shuffled question indices for the active set
    this.cursor = 0;
    this.current = null;
    this.nextQid = 1;
    this.history = [];                    // [{ qid, reason, topic, right:[], wrong:[], missed:[] }]
  }

  // ------------------------------------------------------------------ sets

  loadSets(sets) {
    this.sets = (Array.isArray(sets) ? sets : []).slice(0, QUIZ.maxSets);
    if (!this.sets.some((s) => s.id === this.activeSetId)) {
      this.activeSetId = this.sets.length ? this.sets[0].id : null;
      this.reshuffle();
    }
  }

  get activeSet() {
    return this.sets.find((s) => s.id === this.activeSetId) || null;
  }

  setActiveSet(id) {
    if (id !== null && !this.sets.some((s) => s.id === id)) return false;
    this.activeSetId = id;
    this.reshuffle();
    return true;
  }

  reshuffle() {
    const set = this.activeSet;
    const n = set ? set.questions.length : 0;
    this.order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.cursor = 0;
  }

  get ready() {
    const set = this.activeSet;
    return !!(set && set.questions.length);
  }

  get open() { return this.current !== null; }

  // ------------------------------------------------------------- questions

  /**
   * participants: [{ slot, name }] — every connected student, eliminated ones
   * very much included; being out is exactly when they need a way back in.
   */
  ask(participants, reason = 'manual') {
    if (this.open || !this.ready || !participants.length) return null;
    if (this.cursor >= this.order.length) this.reshuffle();

    const set = this.activeSet;
    const q = set.questions[this.order[this.cursor++]];
    const base = Math.max(QUIZ.minTimerSec, Math.min(QUIZ.maxTimerSec, this.timerSec));

    this.current = {
      qid: this.nextQid++,
      reason,
      setId: set.id,
      q: q.q,
      options: q.options.slice(),
      correct: q.correct,
      topic: q.topic || '',
      base,
      elapsed: 0,
      overtime: false,
      seats: new Map(participants.map((p) => [p.slot, {
        slot: p.slot,
        name: p.name,
        choice: null,
        correct: null,
        answeredAt: null,
        limit: base + (this.extensions[p.slot] || 0),
      }])),
    };
    return this.current;
  }

  /** The payload a student device may see: no answer key. */
  askPayload() {
    const c = this.current;
    if (!c) return null;
    return {
      qid: c.qid, q: c.q, options: c.options, topic: c.topic,
      reason: c.reason, timer: c.base, twoOption: c.options.length === 2,
    };
  }

  answer(slot, qid, choice) {
    const c = this.current;
    if (!c || c.qid !== qid) return null;
    const s = c.seats.get(slot);
    if (!s || s.choice !== null) return null;          // first answer is final
    const i = Number(choice);
    if (!Number.isInteger(i) || i < 0 || i >= c.options.length) return null;
    s.choice = i;
    s.correct = i === c.correct;
    s.answeredAt = c.elapsed;
    return s;
  }

  /** Grant one student more time on the current question and every later one. */
  extend(slot, seconds = QUIZ.extensionStepSec) {
    const add = Math.max(0, Math.min(QUIZ.maxExtensionSec, seconds));
    this.extensions[slot] = Math.min(QUIZ.maxExtensionSec, (this.extensions[slot] || 0) + add);
    const s = this.current && this.current.seats.get(slot);
    if (s) s.limit += add;
    return this.extensions[slot];
  }

  clearExtension(slot) { delete this.extensions[slot]; }

  /** A student who vanished mid-question must not hold the room hostage. */
  dropParticipant(slot) {
    const c = this.current;
    if (!c) return;
    const s = c.seats.get(slot);
    if (s && s.choice === null) c.seats.delete(slot);
  }

  get everyoneAnswered() {
    const c = this.current;
    if (!c) return false;
    for (const s of c.seats.values()) if (s.choice === null) return false;
    return true;
  }

  get allDeadlinesPassed() {
    const c = this.current;
    if (!c) return false;
    for (const s of c.seats.values()) if (s.choice === null && c.elapsed < s.limit) return false;
    return true;
  }

  /** Returns 'done' when the question should close, else null. */
  tick(dt) {
    const c = this.current;
    if (!c) return null;
    c.elapsed += dt;
    if (c.seats.size === 0) return 'done';
    if (this.everyoneAnswered) return 'done';
    if (this.allDeadlinesPassed) {
      c.overtime = true;
      if (this.autoAdvance) return 'done';
    }
    return null;
  }

  /** Seconds left for one student, floored at 0. */
  remainingFor(slot) {
    const c = this.current;
    if (!c) return 0;
    const s = c.seats.get(slot);
    if (!s) return 0;
    return Math.max(0, s.limit - c.elapsed);
  }

  /** Live board for the teacher console only — never for the projector. */
  liveRows() {
    const c = this.current;
    if (!c) return [];
    return [...c.seats.values()].map((s) => ({
      slot: s.slot, name: s.name,
      answered: s.choice !== null,
      choice: s.choice,
      correct: s.correct,
      remaining: Math.max(0, Math.round(s.limit - c.elapsed)),
      extension: this.extensions[s.slot] || 0,
    }));
  }

  answeredCount() {
    const c = this.current;
    if (!c) return { answered: 0, total: 0 };
    let n = 0;
    for (const s of c.seats.values()) if (s.choice !== null) n++;
    return { answered: n, total: c.seats.size };
  }

  /** Closes the question and returns the grading result. */
  close() {
    const c = this.current;
    if (!c) return null;
    const right = [], wrong = [], missed = [];
    for (const s of c.seats.values()) {
      if (s.choice === null) { missed.push(s.slot); wrong.push(s.slot); }
      else if (s.correct) right.push(s.slot);
      else wrong.push(s.slot);
    }
    const result = {
      qid: c.qid, reason: c.reason, topic: c.topic, q: c.q,
      options: c.options.slice(), correct: c.correct,
      right, wrong, missed,
      rows: [...c.seats.values()].map((s) => ({
        slot: s.slot, name: s.name, choice: s.choice, correct: !!s.correct,
      })),
    };
    this.history.push({
      qid: c.qid, reason: c.reason, topic: c.topic, q: c.q,
      right: right.slice(), wrong: wrong.slice(), missed: missed.slice(),
    });
    if (this.history.length > 200) this.history.shift();
    this.current = null;
    return result;
  }

  /** Per-topic tallies for the teacher's end-of-class glance. */
  topicReport() {
    const byTopic = new Map();
    for (const h of this.history) {
      const key = h.topic || '(no topic)';
      const t = byTopic.get(key) || { topic: key, asked: 0, right: 0, wrong: 0 };
      t.asked++;
      t.right += h.right.length;
      t.wrong += h.wrong.length;
      byTopic.set(key, t);
    }
    return [...byTopic.values()];
  }
}
