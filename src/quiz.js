// Question sets and the live question machine. Pure logic: no DOM, no fs, no
// timers, no network. The admin page imports it to preview a paste, and Room
// imports it to run the real thing, so the teacher's preview and the room's
// parse can never disagree.

import { QUIZ } from './quiz-config.js';

export const LETTERS = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------------- CSV
// One reader for every way a question can arrive: pasted text, an uploaded
// .csv, an uploaded .tsv, and the hand-written form. admin.js does the file
// reading and hands the text in here, so the teacher's preview and Room's
// parse always run the same code.

/** Drops a leading UTF-8 BOM. Sheets and Excel both like to add one. */
export function normaliseText(text) {
  const s = String(text ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Tabs or commas? "Download as TSV" is one menu item away in Sheets, and
 * Excel's "Unicode Text" export is tab separated too. Decided on the first
 * non-empty line: whichever separator shows up more often outside quotes
 * wins, and a tie goes to the comma.
 */
export function sniffDelimiter(text) {
  const src = normaliseText(text);
  let commas = 0;
  let tabs = 0;
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') i++; else quoted = false; }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') commas++;
    else if (ch === '\t') tabs++;
    else if (ch === '\n' && (commas || tabs)) break;
  }
  return tabs > commas ? '\t' : ',';
}

/**
 * RFC4180-ish reader. Handles quoted fields, embedded separators, doubled
 * quotes, CRLF, trailing blank lines and a BOM, because a teacher exporting
 * from Sheets or Excel will produce all of them.
 *
 * Returns [{ cells, line }]. `line` is the real 1-based line number in the
 * teacher's file, counted before blank rows are dropped, so an error message
 * can point at the row they are actually looking at in the spreadsheet.
 */
export function readDelimited(text, delimiter) {
  const src = normaliseText(text);
  const delim = delimiter || sniffDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let started = false;   // this cell has at least one character or quote
  let line = 1;          // the line this row started on
  let nextLine = 1;      // the line the cursor is on

  const endCell = () => { row.push(cell); cell = ''; started = false; };
  const endRow = () => { endCell(); rows.push({ cells: row, line }); row = []; line = nextLine; };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else {
        if (ch === '\n') nextLine++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !started) { quoted = true; started = true; continue; }
    if (ch === delim) { endCell(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { nextLine++; endRow(); continue; }
    cell += ch;
    started = true;
  }
  if (cell !== '' || row.length) endRow();
  return rows.filter((r) => r.cells.some((c) => String(c).trim() !== ''));
}

/** Older shape: rows as plain arrays of cells, blank rows already dropped. */
export function parseCsvRows(text, delimiter) {
  return readDelimited(text, delimiter).map((r) => r.cells);
}

const trimField = (v) => String(v ?? '').trim().slice(0, QUIZ.maxFieldChars);

export const CSV_HEADER = 'question,a,b,c,d,correct,topic';

/**
 * The one place that decides what a valid question is. The CSV reader calls
 * it per row and the hand-written form calls it per question, so an uploaded
 * row and a typed row can never be judged by different rules.
 *
 * fields: { q, a, b, c, d, correct, topic }.
 * Returns { question } or { error: { line, field, msg } }. `msg` is written
 * for a teacher, not a developer: it names the column and says what to do.
 *
 * Leaving BOTH c and d blank gives a 2-option question. That is the
 * accessibility mode, not a degenerate row, so it passes with no complaint.
 * Filling in only one of them is the mistake, and it is reported.
 */
export function buildQuestion(fields, line = 0) {
  const q = trimField(fields.q);
  const a = trimField(fields.a);
  const b = trimField(fields.b);
  const c = trimField(fields.c);
  const d = trimField(fields.d);
  const topic = trimField(fields.topic);
  const correctRaw = String(fields.correct ?? '').trim();
  const bad = (field, msg) => ({ error: { line, field, msg } });

  if (!q) return bad('q', 'the question column is empty — type the question a student will read');
  if (!a && !b) return bad('a', 'options a and b are both empty — every question needs at least two options');
  if (!a) return bad('a', 'option a is empty — fill it in, or move option b up into a');
  if (!b) return bad('b', 'option b is empty — a question needs at least two options');

  const options = [a, b];
  if (c && d) options.push(c, d);
  else if (c || d) {
    const filled = c ? 'c' : 'd';
    const blank = c ? 'd' : 'c';
    return bad(blank, `option ${filled} is filled in but option ${blank} is blank — ` +
      `either fill in ${blank} as well, or clear ${filled} to make this a two-option question`);
  }

  const key = correctRaw.toUpperCase();
  let correct = LETTERS.indexOf(key);
  if (correct < 0 && /^[1-4]$/.test(key)) correct = Number(key) - 1;
  if (correct < 0) {
    return bad('correct', correctRaw
      ? `the correct answer says "${correctRaw}" — it has to be the letter A, B, C or D`
      : 'the correct answer is blank — put in the letter A, B, C or D of the right option');
  }
  if (correct >= options.length) {
    return bad('correct', `the correct answer is ${LETTERS[correct]}, but this question only has ` +
      `${options.length} options (${LETTERS.slice(0, options.length).join(' and ')})`);
  }

  return { question: { q, options, correct, topic } };
}

/**
 * question,a,b,c,d,correct,topic — comma or tab separated, sniffed.
 *
 * `correct` is a letter A-D (case-insensitive; a bare 1-4 is accepted too
 * because teachers type it). `topic` is optional.
 *
 * Returns { questions, errors, skippedHeader }. Bad rows are reported with
 * their 1-based line number and never silently dropped.
 */
export function parseQuestionCsv(text, delimiter) {
  const rows = readDelimited(text, delimiter);
  const questions = [];
  const errors = [];
  let skippedHeader = false;

  rows.forEach((raw, idx) => {
    const cells = raw.cells.map(trimField);
    if (idx === 0 && /^question$/i.test(cells[0] || '')) { skippedHeader = true; return; }

    const [q, a, b, c, d, correct, topic] = cells;
    const { question, error } = buildQuestion({ q, a, b, c, d, correct, topic }, raw.line);
    if (error) errors.push(error);
    else questions.push(question);
  });

  if (questions.length > QUIZ.maxQuestionsPerSet) {
    errors.push({ line: 0, field: '', msg: `set truncated to ${QUIZ.maxQuestionsPerSet} questions` });
    questions.length = QUIZ.maxQuestionsPerSet;
  }
  return { questions, errors, skippedHeader };
}

/** Round-trips a parsed set back to CSV so the admin page can re-edit it. */
export function questionsToCsv(questions) {
  const esc = (v) => (/[",\t\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = (questions || []).map((q) => [
    q.q, q.options[0], q.options[1], q.options[2] || '', q.options[3] || '',
    LETTERS[q.correct], q.topic || '',
  ].map(esc).join(','));
  return [CSV_HEADER, ...body].join('\n');
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
