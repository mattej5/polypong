// The question modal. SPEC §6.4.
//
// DOM, NEVER CANVAS, and that is not a convenience. Twenty-five students look
// at this at once and some of them have IEPs: the text has to be selectable,
// zoomable, focusable, and reachable by a screen reader, and canvas text is
// none of those. It costs a handful of DOM writes per question — three or four
// a minute — against a render path that must not allocate. Different budgets,
// different tools.
//
// Three states, and the third one is the one that matters:
//   1. ELIGIBLE   — options are buttons, keys 1-4 and A-D select, one answer.
//   2. WATCHING   — an ineligible student (SPEC §6.2) sees the same question
//      and who is answering, with the options visibly locked. They are NOT
//      given a blank freeze: a screen that stops responding with no
//      explanation reads as a crash, and a student who thinks it crashed puts
//      their hand up.
//   3. REVEAL     — the correct answer, what they chose, and what it cost.
//
// Nothing here is ever written with innerHTML. Question text and option text
// come off the wire from a teacher's CSV, and student names come from students.

import type { QuestionMsg, RevealMsg } from '../../shared/protocol';
import { safeName } from './guards';

const KEYS = ['A', 'B', 'C', 'D'];
/** Seconds before a keypress can answer. See QuestionModal.sinceOpen. */
const KEY_GRACE = 0.4;
const MAX_OPTIONS = KEYS.length;

interface OptionRow {
  btn: HTMLButtonElement;
  key: HTMLSpanElement;
  text: HTMLSpanElement;
  tag: HTMLSpanElement;
}

export type AnswerFn = (qid: string, choice: number) => void;

export class QuestionModal {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly kindEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly optionsEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private readonly rows: OptionRow[] = [];
  private readonly onAnswer: AnswerFn;

  private qid: string | null = null;
  private eligible = false;
  private answered = false;
  private choice: number | null = null;
  private optionCount = 0;
  private revealed = false;
  private remaining = 0;
  private shownCount = -1;
  private shownAnswered = '';
  private restoreFocus: HTMLElement | null = null;
  /**
   * Seconds this question has been on screen. Answer KEYS are ignored for the
   * first `KEY_GRACE` of that, because A and D are the paddle controls: a
   * student steering when a question appears would otherwise have an answer
   * locked in — irreversibly, since there is only one — before the question
   * had finished rendering. Observed in testing: pressing D as the modal
   * opened committed "D. Methane" instantly.
   *
   * Clicks are exempt. A click is aimed at a specific option and cannot be
   * left over from driving a paddle.
   */
  private sinceOpen = 0;

  constructor(root: HTMLElement, onAnswer: AnswerFn) {
    this.root = root;
    this.onAnswer = onAnswer;

    this.card = root.querySelector('.modal-card') as HTMLElement;
    this.kindEl = root.querySelector('#q-kind') as HTMLElement;
    this.textEl = root.querySelector('#q-text') as HTMLElement;
    this.optionsEl = root.querySelector('#q-options') as HTMLElement;
    this.countEl = root.querySelector('#q-count') as HTMLElement;
    this.statusEl = root.querySelector('#q-status') as HTMLElement;
    this.resultEl = root.querySelector('#q-result') as HTMLElement;

    // Four buttons, built once and reused for every question of the lesson.
    for (let i = 0; i < MAX_OPTIONS; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt';
      const key = document.createElement('span');
      key.className = 'opt-key';
      key.textContent = KEYS[i]!;
      const text = document.createElement('span');
      text.className = 'opt-text';
      const tag = document.createElement('span');
      tag.className = 'opt-tag';
      btn.append(key, text, tag);
      btn.addEventListener('click', () => this.choose(i));
      this.optionsEl.append(btn);
      this.rows.push({ btn, key, text, tag });
    }

    // A modal that can be tabbed out of is not a modal. There is no close
    // button by design — the server owns when this goes away (SPEC I1) — so
    // Tab cycles inside and Escape does nothing.
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Tab') return;
      const focusable = this.rows.filter((r) => !r.btn.disabled).map((r) => r.btn);
      if (focusable.length === 0) {
        ev.preventDefault();
        this.card.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (ev.shiftKey && (active === first || active === this.card)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && active === last) {
        ev.preventDefault();
        first.focus();
      }
    });
  }

  get isOpen(): boolean {
    return this.qid !== null;
  }

  /** True while a keypress should select an answer rather than move a paddle. */
  get takesAnswerKeys(): boolean {
    return this.qid !== null && this.eligible && !this.answered && !this.revealed
      && this.sinceOpen >= KEY_GRACE;
  }

  open(msg: QuestionMsg): void {
    const options = msg.options.slice(0, MAX_OPTIONS);
    if (options.length === 0) return;

    const reopening = this.qid === msg.qid;
    this.qid = msg.qid;
    this.eligible = msg.eligible;
    this.optionCount = options.length;
    this.revealed = false;
    this.remaining = Math.max(0, msg.timer);
    this.shownCount = -1;
    this.shownAnswered = '';
    // A reconnect mid-question replays `question`; a student who had already
    // answered must not get their buttons back, so the answered flag survives
    // a re-open of the SAME qid.
    if (!reopening) {
      this.answered = false;
      this.choice = null;
      this.sinceOpen = 0;
    }

    this.kindEl.textContent = msg.kind === 'revive' ? 'BACK-IN QUESTION' : 'CLASS QUESTION';
    this.textEl.textContent = msg.text;
    this.resultEl.textContent = '';
    this.resultEl.className = 'q-result';

    for (let i = 0; i < MAX_OPTIONS; i++) {
      const r = this.rows[i]!;
      const has = i < options.length;
      r.btn.hidden = !has;
      if (!has) continue;
      r.text.textContent = options[i]!;
      r.tag.textContent = '';
      r.btn.className = 'opt';
      r.btn.setAttribute('aria-label', `${KEYS[i]}. ${options[i]}`);
      const locked = !this.eligible || this.answered;
      r.btn.disabled = locked;
      r.btn.setAttribute('aria-disabled', locked ? 'true' : 'false');
      if (this.answered && this.choice === i) {
        r.btn.classList.add('chosen');
        r.tag.textContent = 'YOUR ANSWER';
      }
    }

    if (this.eligible) {
      this.card.classList.remove('watching');
      this.statusEl.textContent = this.answered ? 'Answer locked in.' : 'Pick one.';
    } else {
      this.card.classList.add('watching');
      this.statusEl.textContent = watchingLine(msg.waitingOn, msg.kind);
    }

    this.show();
  }

  /** SPEC §6.4 step 2: the live countdown and answered/total count. */
  tick(qid: string, answered: number, total: number, remaining: number): void {
    if (this.qid !== qid || this.revealed) return;
    this.remaining = Math.max(0, remaining);
    if (this.eligible) {
      const line = `${answered} of ${total} answered`;
      if (line !== this.shownAnswered) {
        this.shownAnswered = line;
        this.statusEl.textContent = this.answered ? `Answer locked in — ${line}` : `Pick one — ${line}`;
      }
    }
    this.paintCount();
  }

  /** Local decay between the 4 Hz `qtick`s, so the number does not stutter. */
  frame(dt: number): void {
    if (this.qid === null) return;
    this.sinceOpen += dt;
    if (this.revealed) return;
    this.remaining = Math.max(0, this.remaining - dt);
    this.paintCount();
  }

  reveal(msg: RevealMsg): void {
    if (this.qid !== msg.qid) return; // a reveal for a question we never saw
    this.revealed = true;
    this.countEl.textContent = '';
    this.countEl.hidden = true;

    for (let i = 0; i < MAX_OPTIONS; i++) {
      const r = this.rows[i]!;
      if (r.btn.hidden) continue;
      r.btn.disabled = true;
      r.btn.setAttribute('aria-disabled', 'true');
      r.btn.className = 'opt';
      const tags: string[] = [];
      // Colour is never the only signal (SPEC §9): the correct row is named
      // in words as well as tinted, and so is the student's own pick.
      if (i === msg.correct) {
        r.btn.classList.add('correct');
        tags.push('CORRECT');
      }
      if (msg.yourChoice === i) {
        r.btn.classList.add(i === msg.correct ? 'chosen' : 'wrong');
        tags.push('YOUR ANSWER');
      }
      r.tag.textContent = tags.join(' · ');
    }

    const key = KEYS[msg.correct] ?? '?';
    this.statusEl.textContent = `The answer was ${key}.`;
    this.resultEl.textContent = resultLine(msg, this.eligible);
    this.resultEl.className = `q-result ${resultTone(msg, this.eligible)}`;
  }

  hide(): void {
    if (this.qid === null && this.root.hidden) return;
    this.qid = null;
    this.revealed = false;
    this.answered = false;
    this.choice = null;
    this.root.hidden = true;
    const back = this.restoreFocus;
    this.restoreFocus = null;
    if (back && document.contains(back)) back.focus();
  }

  /** Keyboard route from the page: `1`-`4` and `A`-`D`. */
  selectByKey(raw: string): boolean {
    if (!this.takesAnswerKeys) return false;
    const k = raw.toUpperCase();
    let i = KEYS.indexOf(k);
    if (i === -1 && k >= '1' && k <= '4') i = k.charCodeAt(0) - 49;
    if (i < 0 || i >= this.optionCount) return false;
    this.choose(i);
    return true;
  }

  private choose(i: number): void {
    if (!this.takesAnswerKeys) return;
    if (i < 0 || i >= this.optionCount) return;
    const qid = this.qid;
    if (qid === null) return;

    this.answered = true;
    this.choice = i;
    for (let k = 0; k < MAX_OPTIONS; k++) {
      const r = this.rows[k]!;
      if (r.btn.hidden) continue;
      r.btn.disabled = true;
      r.btn.setAttribute('aria-disabled', 'true');
      if (k === i) {
        r.btn.classList.add('chosen');
        r.tag.textContent = 'YOUR ANSWER';
      }
    }
    this.statusEl.textContent = `Answer locked in: ${KEYS[i]}.`;
    this.shownAnswered = '';
    this.onAnswer(qid, i);
  }

  private paintCount(): void {
    const n = Math.ceil(this.remaining);
    if (n === this.shownCount) return;
    this.shownCount = n;
    this.countEl.hidden = false;
    this.countEl.textContent = `${n}s`;
    this.countEl.classList.toggle('urgent', n <= 5);
  }

  private show(): void {
    if (this.root.hidden) {
      const active = document.activeElement;
      this.restoreFocus = active instanceof HTMLElement ? active : null;
      this.root.hidden = false;
    }
    this.paintCount();
    // Focus lands on the first answer for anyone who can answer, and on the
    // card itself for a watcher, so a screen reader reads the question rather
    // than leaving focus behind on the page under the overlay.
    const target = this.eligible && !this.answered ? this.rows[0]?.btn : this.card;
    if (target && !this.root.contains(document.activeElement)) target.focus();
  }
}

/**
 * What a student who cannot answer is told. The reason they cannot answer
 * differs by question kind, and saying the wrong one is worse than saying
 * nothing: on a revive question they are waiting on a classmate, but on a
 * class question they are ineligible because they are out of this match, and
 * telling them somebody is "getting back in" implies they might be too.
 */
function watchingLine(waitingOn: readonly string[], kind: 'class' | 'revive'): string {
  const names = waitingOn.map((n) => safeName(n)).filter((n) => n !== '?');
  const list =
    names.length === 0 ? null
    : names.length === 1 ? `${names[0]}`
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  if (kind === 'revive') {
    if (!list) return 'Someone is answering to get back in.';
    return names.length === 1
      ? `${list} is answering to get back in.`
      : `${list} are answering to get back in.`;
  }
  // A class question you cannot answer means you are out of this match.
  return list
    ? `You are out this round. Your class is answering.`
    : 'You are out this round. Watch for the next game.';
}

/** Plain classroom English, same register as the server's banners (SPEC §9). */
function resultLine(msg: RevealMsg, eligible: boolean): string {
  if (!eligible) return 'Watch for the next round.';
  const d = msg.yourDelta;
  if (msg.yourChoice === null) {
    if (d < 0) return `You did not answer — you lost ${lives(-d)}.`;
    if (d > 0) return 'You did not answer.';
    return 'You did not answer. No lives lost.';
  }
  const right = msg.yourChoice === msg.correct;
  if (d > 0) return `Correct — you are back in with ${lives(d)}.`;
  if (d < 0) return `Not this time — you lost ${lives(-d)}.`;
  return right ? 'Correct. No lives lost.' : 'Not this time. No lives lost.';
}

function resultTone(msg: RevealMsg, eligible: boolean): string {
  if (!eligible) return 'neutral';
  if (msg.yourDelta > 0) return 'good';
  if (msg.yourDelta < 0) return 'bad';
  return msg.yourChoice === msg.correct ? 'good' : 'neutral';
}

const lives = (n: number): string => (n === 1 ? '1 life' : `${n} lives`);
