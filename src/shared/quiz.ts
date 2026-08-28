// CSV import/export and the question engine. Pure logic: no fs, no timers,
// no network, no global randomness (SPEC I12). The teacher's "paste a CSV" preview
// and the room's actual quiz run this exact same code, so they can never
// disagree about what a valid question is.
//
// This file's PUBLIC INTERFACE is used by src/server/ and (indirectly) by
// src/client/teacher/ for CSV preview. Do not import anything with a runtime
// API here — see SPEC I12 and the import-boundary test.

import type { Rng } from './config';
import type { QuestionMsg, RevealMsg } from './protocol';

// ------------------------------------------------------------------- types

export interface Question {
  readonly text: string;
  /** 2, 3, or 4 options. SPEC §6.5. */
  readonly options: readonly string[];
  /** Index into `options`. */
  readonly correct: number;
}

export interface CsvIssue {
  /** 1-based line number in the file the teacher uploaded. */
  readonly line: number;
  /** Written for a teacher, e.g. "correct answer 'E' is not one of the options". */
  readonly message: string;
}

export interface ParsedCsv {
  readonly questions: Question[];
  readonly issues: CsvIssue[];
}

// ---------------------------------------------------------------------- CSV
// Columns: question, optionA, optionB, optionC, optionD, correct.
// This comes out of Excel and Google Sheets, so the reader has to survive
// quoted fields, commas and newlines embedded inside quotes, doubled quotes
// as the escape for a literal quote, CRLF line endings, a leading UTF-8 BOM,
// an optional header row, and trailing blank lines.

const LETTERS = ['A', 'B', 'C', 'D'] as const;

export const CSV_HEADER = 'question,optionA,optionB,optionC,optionD,correct';

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface RawRow {
  readonly cells: string[];
  /** The line the row STARTED on, 1-based, counted before blank rows are
   *  dropped, so an error can point at the exact row in the spreadsheet. */
  readonly line: number;
}

/**
 * RFC4180-ish tokenizer. `charAt` is used throughout instead of index
 * access so every character read is a plain `string`, never `string |
 * undefined` — noUncheckedIndexedAccess would otherwise force a null check
 * on every single character of the input.
 */
function readRows(text: string): RawRow[] {
  const src = stripBom(text);
  const rows: RawRow[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false; // this cell has at least one character or an opening quote
  let line = 1; // the line the current row started on
  let nextLine = 1; // the line the cursor is on right now

  const endCell = (): void => {
    row.push(cell);
    cell = '';
    started = false;
  };
  const endRow = (): void => {
    endCell();
    rows.push({ cells: row, line });
    row = [];
    line = nextLine;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (src.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') nextLine++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ',') {
      endCell();
      continue;
    }
    if (ch === '\r') continue; // CRLF: the \n right after does the line break
    if (ch === '\n') {
      nextLine++;
      endRow();
      continue;
    }
    cell += ch;
    started = true;
  }
  if (cell !== '' || row.length) endRow();

  // Trailing blank lines (and any wholly-empty row) are not errors — they
  // are just not rows.
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

function cellAt(cells: readonly string[], i: number): string {
  return (cells[i] ?? '').trim();
}

/**
 * The one place that decides what a valid question row is. Returns either a
 * `Question` or a `CsvIssue` for that line — never both, never neither, and
 * never a thrown error, so a bad row is reported and skipped instead of
 * killing the whole import.
 */
function buildQuestion(cells: readonly string[], line: number): { question: Question } | { issue: CsvIssue } {
  const text = cellAt(cells, 0);
  const a = cellAt(cells, 1);
  const b = cellAt(cells, 2);
  const c = cellAt(cells, 3);
  const d = cellAt(cells, 4);
  const correctRaw = cellAt(cells, 5);

  const bad = (message: string): { issue: CsvIssue } => ({ issue: { line, message } });

  if (!text) return bad('the question column is empty');
  if (!a) return bad('option A is empty — a question needs at least two options');
  if (!b) return bad('option B is empty — a question needs at least two options');

  // C and D must be both blank (a two-option question) or both filled (a
  // four-option question). One filled and the other blank is almost always
  // a typo, so it is reported rather than silently treated as three options.
  if ((c !== '') !== (d !== '')) {
    const filled = c !== '' ? 'C' : 'D';
    const blank = c !== '' ? 'D' : 'C';
    return bad(
      `option ${filled} is filled in but option ${blank} is blank — fill in both, or clear ${filled} to make this a two-option question`,
    );
  }

  const options = c !== '' && d !== '' ? [a, b, c, d] : [a, b];
  const key = correctRaw.toUpperCase();
  const idx = (LETTERS as readonly string[]).indexOf(key);

  if (idx < 0) {
    return bad(
      correctRaw
        ? `correct answer '${correctRaw}' is not one of the options`
        : 'the correct answer column is empty — put the letter A-D of the right option',
    );
  }
  if (idx >= options.length) {
    return bad(
      `correct answer '${key}' is not one of the options — this question only has ${options.length} options (${LETTERS.slice(0, options.length).join(', ')})`,
    );
  }

  return { question: { text, options, correct: idx } };
}

/**
 * Parses a full CSV file. Never throws. A malformed row is reported by its
 * 1-based line number in `issues` and skipped; it never disappears silently
 * and never aborts the rest of the import.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows = readRows(text);
  const questions: Question[] = [];
  const issues: CsvIssue[] = [];

  rows.forEach((row, idx) => {
    // A header row may or may not be present. Only the first row can be one,
    // and only if its first cell reads "question".
    if (idx === 0 && cellAt(row.cells, 0).toLowerCase() === 'question') return;
    const result = buildQuestion(row.cells, row.line);
    if ('issue' in result) issues.push(result.issue);
    else questions.push(result.question);
  });

  return { questions, issues };
}

function escapeCsvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Round-trips a parsed set back to CSV, in the same column order it was read. */
export function questionsToCsv(questions: readonly Question[]): string {
  const lines = questions.map((q) => {
    const a = q.options[0] ?? '';
    const b = q.options[1] ?? '';
    const c = q.options[2] ?? '';
    const d = q.options[3] ?? '';
    const correct = LETTERS[q.correct] ?? '';
    return [q.text, a, b, c, d, correct].map(escapeCsvField).join(',');
  });
  return [CSV_HEADER, ...lines].join('\r\n');
}

/** A blank downloadable template: header row only. */
export function blankCsvTemplate(): string {
  return `${CSV_HEADER}\r\n`;
}

// -------------------------------------------------------------- selection
// Draw without replacement within a match; reshuffle once the set is
// exhausted. Shuffling is driven entirely by the injected Rng (SPEC I12) —
// this class never reaches for global randomness, so it is deterministic
// under a seeded Rng and can be replayed exactly in a test.

export class QuestionDeck {
  private order: number[];
  private cursor = 0;

  constructor(
    private readonly questions: readonly Question[],
    private readonly rng: Rng,
  ) {
    this.order = QuestionDeck.shuffledIndices(questions.length, rng);
  }

  private static shuffledIndices(n: number, rng: Rng): number[] {
    const order: number[] = [];
    for (let i = 0; i < n; i++) order.push(i);
    // Fisher-Yates, driven by the injected Rng only.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const a = order[i];
      const b = order[j];
      if (a === undefined || b === undefined) continue; // unreachable: i, j < order.length
      order[i] = b;
      order[j] = a;
    }
    return order;
  }

  /** Draws the next question without replacement; reshuffles once exhausted. */
  draw(): Question {
    if (this.questions.length === 0) {
      throw new Error('QuestionDeck.draw: no questions in set');
    }
    if (this.cursor >= this.order.length) {
      this.order = QuestionDeck.shuffledIndices(this.questions.length, this.rng);
      this.cursor = 0;
    }
    const idx = this.order[this.cursor];
    this.cursor += 1;
    if (idx === undefined) throw new Error('QuestionDeck.draw: internal index out of range');
    const q = this.questions[idx];
    if (q === undefined) throw new Error('QuestionDeck.draw: internal question out of range');
    return q;
  }
}

// ------------------------------------------------------------------ engine
// SPEC §6.2, the exact table. Two kinds of eligible participant:
//
//   'atRisk'   — an alive player. Correct: nothing. Wrong / no answer: -1
//                life. Only a CLASS question ever has 'atRisk' participants.
//   'reviving' — a player sitting at zero lives with a revive chance.
//                Correct: revived to 1 life. Wrong / no answer: permanently
//                out. This is the ONLY kind a revive question ever has.
//
// A permanently-out player or a spectator is simply never put in the
// eligible list — the caller (Match) decides that, because it is the one
// that knows revive budgets and roster status. This engine only knows the
// two kinds above.

export type ParticipantKind = 'atRisk' | 'reviving';

export type Participant =
  | { readonly pid: string; readonly name: string; readonly kind: 'atRisk'; readonly livesBefore: number }
  | { readonly pid: string; readonly name: string; readonly kind: 'reviving' };

export type QuestionKind = 'class' | 'revive';

/** What happened to one participant as a direct result of this question —
 *  not their final roster status, which also depends on revive budget the
 *  engine does not track (that is Match's job). */
export type OutcomeStatus = 'unaffected' | 'lostLife' | 'revived' | 'eliminated';

export interface OutcomeEntry {
  readonly pid: string;
  readonly name: string;
  readonly kind: ParticipantKind;
  readonly choice: number | null;
  /** null when they did not answer (timeout, disconnect, or never asked). */
  readonly correct: boolean | null;
  readonly delta: number;
  readonly status: OutcomeStatus;
}

export interface ReviveCandidate {
  readonly pid: string;
  readonly name: string;
}

export interface Outcome {
  readonly qid: string;
  readonly kind: QuestionKind;
  readonly correctIndex: number;
  readonly entries: OutcomeEntry[];
  /** Players who just hit zero lives and are owed a revive question. Always
   *  empty when `kind === 'revive'` — see the comment in `close()`. This is
   *  what makes SPEC I3 (chain depth bounded at 2) structural. */
  readonly triggersRevive: ReviveCandidate[];
}

interface Seat {
  readonly participant: Participant;
  choice: number | null;
  dropped: boolean;
}

interface OpenQuestion {
  readonly qid: string;
  readonly kind: QuestionKind;
  readonly question: Question;
  readonly seats: Map<string, Seat>;
  remaining: number;
}

/**
 * A pure state machine for exactly one question at a time. The caller
 * drives it with `open` / `answer` / `tick` / `dropParticipant`, polls
 * `shouldClose`, and calls `close` to get the graded result. The engine
 * never mutates game state (lives, roster, sockets) itself — it only ever
 * reports what should happen; applying it is the caller's job.
 */
export class QuestionEngine {
  private nextId = 1;
  private current: OpenQuestion | null = null;

  isOpen(): boolean {
    return this.current !== null;
  }

  /** The open question's id, or null. Used to address live teacher updates. */
  currentQid(): string | null {
    return this.current?.qid ?? null;
  }

  /**
   * Counters for the ticking display every client sees. Deliberately carries
   * no per-student detail and no answer key — this goes to the whole class.
   */
  tickState(): { qid: string; answered: number; total: number; remaining: number } | null {
    const c = this.current;
    if (!c) return null;
    let answered = 0;
    let total = 0;
    for (const seat of c.seats.values()) {
      if (seat.dropped) continue;
      total++;
      if (seat.choice !== null) answered++;
    }
    return { qid: c.qid, answered, total, remaining: Math.max(0, c.remaining) };
  }

  /**
   * Per-student progress for the TEACHER console only: who has answered and
   * who is being waited on. Still carries no answer key and no choices —
   * the teacher learns what a student picked at reveal, like everyone else,
   * so a shoulder-surfing student gains nothing from this message either.
   */
  liveRows(): { pid: string; name: string; answered: boolean; eligible: boolean }[] {
    const c = this.current;
    if (!c) return [];
    const rows: { pid: string; name: string; answered: boolean; eligible: boolean }[] = [];
    for (const seat of c.seats.values()) {
      rows.push({
        pid: seat.participant.pid,
        name: seat.participant.name,
        answered: seat.choice !== null,
        eligible: !seat.dropped,
      });
    }
    return rows;
  }

  /**
   * Throw the open question away ungraded. The teacher ended the match
   * mid-question: nobody should lose a life over a game that no longer
   * exists, so this is deliberately NOT `close()`.
   */
  abandon(): void {
    this.current = null;
  }

  /** Starts a question. Returns its qid. */
  open(kind: QuestionKind, question: Question, eligible: readonly Participant[], timerSec: number): string {
    const qid = `q${this.nextId}`;
    this.nextId += 1;
    const seats = new Map<string, Seat>();
    for (const p of eligible) {
      seats.set(p.pid, { participant: p, choice: null, dropped: false });
    }
    this.current = { qid, kind, question, seats, remaining: timerSec };
    return qid;
  }

  /** Records an answer. Silently ignores: no question open, a stale qid, an
   *  ineligible/dropped pid, a second answer from the same pid, or an
   *  out-of-range choice. Never throws — the wire cannot be trusted. */
  answer(pid: string, qid: string, choice: number): void {
    const cur = this.current;
    if (!cur || cur.qid !== qid) return;
    const seat = cur.seats.get(pid);
    if (!seat || seat.dropped || seat.choice !== null) return;
    if (!Number.isInteger(choice) || choice < 0 || choice >= cur.question.options.length) return;
    seat.choice = choice;
  }

  tick(dt: number): void {
    if (!this.current) return;
    this.current.remaining = Math.max(0, this.current.remaining - dt);
  }

  /** A Chromebook slept or the tab closed. Removes them from the pending set
   *  so "everyone has answered" can still become true (SPEC I4) — it does
   *  not delete their seat, so they still receive a graded (no-answer)
   *  outcome at close(), same as anyone else the deadline caught. */
  dropParticipant(pid: string): void {
    if (!this.current) return;
    const seat = this.current.seats.get(pid);
    if (seat && seat.choice === null) seat.dropped = true;
  }

  /** True once every eligible, non-dropped participant has answered, or the
   *  timer has expired. Vacuously true if every participant has dropped. */
  shouldClose(): boolean {
    const cur = this.current;
    if (!cur) return false;
    if (cur.remaining <= 0) return true;
    for (const seat of cur.seats.values()) {
      if (seat.choice === null && !seat.dropped) return false;
    }
    return true;
  }

  /** Grades every seat and closes the question. Throws if none is open —
   *  that is a caller bug (calling close before shouldClose is ever true is
   *  meaningless), not bad input from the wire. */
  close(): Outcome {
    const cur = this.current;
    if (!cur) throw new Error('QuestionEngine.close: no question is open');
    const correctIndex = cur.question.correct;

    const entries: OutcomeEntry[] = [];
    const triggersRevive: ReviveCandidate[] = [];

    for (const seat of cur.seats.values()) {
      const { participant, choice } = seat;
      const wasCorrect = choice === null ? null : choice === correctIndex;

      if (participant.kind === 'atRisk') {
        if (wasCorrect === true) {
          entries.push({
            pid: participant.pid,
            name: participant.name,
            kind: 'atRisk',
            choice,
            correct: true,
            delta: 0,
            status: 'unaffected',
          });
        } else {
          entries.push({
            pid: participant.pid,
            name: participant.name,
            kind: 'atRisk',
            choice,
            correct: wasCorrect,
            delta: -1,
            status: 'lostLife',
          });
          // SPEC I3: this branch can only add to triggersRevive when the
          // question that is closing is a CLASS question. A revive
          // question's eligible list is constructed by the caller from
          // ONLY 'reviving' participants (nobody living is ever put at
          // risk in a revive question — SPEC §6.2), so 'atRisk' seats
          // structurally cannot exist while kind === 'revive'. The
          // `cur.kind === 'class'` guard below is a second, independent
          // belt-and-suspenders check: even if a caller mistakenly opened
          // a revive question with an 'atRisk' participant in it, this
          // still could not produce a third question.
          if (cur.kind === 'class' && participant.livesBefore - 1 <= 0) {
            triggersRevive.push({ pid: participant.pid, name: participant.name });
          }
        }
      } else {
        if (wasCorrect === true) {
          entries.push({
            pid: participant.pid,
            name: participant.name,
            kind: 'reviving',
            choice,
            correct: true,
            delta: 1,
            status: 'revived',
          });
        } else {
          entries.push({
            pid: participant.pid,
            name: participant.name,
            kind: 'reviving',
            choice,
            correct: wasCorrect,
            delta: 0,
            status: 'eliminated',
          });
        }
      }
    }

    this.current = null;
    return { qid: cur.qid, kind: cur.kind, correctIndex, entries, triggersRevive };
  }

  /**
   * Builds the message one specific recipient should receive while the
   * question is open. Returns null if no question is open.
   *
   * The return type is annotated as the literal `QuestionMsg` — which has
   * no field for the correct answer — and built as an object literal.
   * TypeScript's excess-property checking on object literals means adding
   * a `correct` key here is a COMPILE ERROR, not a runtime discipline. That
   * is the mechanism behind SPEC I11, not a promise to be careful.
   */
  toClientMsg(pid: string): QuestionMsg | null {
    const cur = this.current;
    if (!cur) return null;

    const waitingOn = [...cur.seats.values()]
      .filter((s) => !s.dropped && s.choice === null)
      .map((s) => s.participant.name);

    const seat = cur.seats.get(pid);
    const eligible = seat !== undefined && !seat.dropped;

    const msg: QuestionMsg = {
      t: 'question',
      qid: cur.qid,
      kind: cur.kind,
      text: cur.question.text,
      options: [...cur.question.options],
      timer: cur.remaining,
      eligible,
      waitingOn: eligible ? [] : waitingOn,
    };
    return msg;
  }
}

/**
 * Builds the reveal message for one recipient from an already-closed
 * `Outcome`. Used only after `close()` — SPEC I11 only forbids the key
 * while the question is open, and by the time an `Outcome` exists the
 * question is, by construction, closed.
 */
export function buildRevealMsg(outcome: Outcome, pid: string): RevealMsg {
  const mine = outcome.entries.find((e) => e.pid === pid);
  const msg: RevealMsg = {
    t: 'reveal',
    qid: outcome.qid,
    correct: outcome.correctIndex,
    yourChoice: mine ? mine.choice : null,
    yourDelta: mine ? mine.delta : 0,
    outcomes: outcome.entries.map((e) => ({ pid: e.pid, name: e.name, choice: e.choice, delta: e.delta })),
  };
  return msg;
}
