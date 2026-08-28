// The open-question panel.
//
// SPEC I11 in this lane, stated as a rule about what this file may read: the
// only place a correct answer ever comes from is `RevealMsg.correct`, and a
// reveal is only ever produced by the server AFTER the question has closed.
// Nothing here caches a key, derives one from a question set, or carries one
// forward from a previous question - `showQuestion` clears the stored reveal,
// and the key is rendered only while the stored reveal's qid still matches the
// question on screen. A teacher cannot see the answer early through this page
// because there is no path through it that has the answer early.
//
// The thing a teacher actually decides with this panel is whether to press
// Close now, and that decision is made from ONE fact: who are we still waiting
// for. So that list is the largest type in the panel and it sits above
// everything else.

import type { QuestionMsg, RevealMsg } from '../../shared/protocol';
import { clear, el, setClass, setText, show } from './dom';

const LETTERS = ['A', 'B', 'C', 'D'];

interface QLiveRow {
  pid: string;
  name: string;
  answered: boolean;
  eligible: boolean;
}

export interface QuestionPanel {
  /** A new question opened. Any previous answer key is dropped here. */
  showQuestion(msg: QuestionMsg): void;
  /** Per-student progress, teacher-only (`qlive`). */
  setLive(qid: string, rows: readonly QLiveRow[]): void;
  /** Class-wide counters (`qtick`). */
  setTick(qid: string, answered: number, total: number, remaining: number): void;
  /** The question closed. This is the first and only time a key exists here. */
  showReveal(msg: RevealMsg): void;
  /** No question at all: match ended, or the teacher ended the game. */
  hide(): void;
  /** True while a question is open and not yet revealed. */
  get open(): boolean;
  /** Whether `qid` is the question currently on screen. Lets the caller drop
   *  a stale `qtick`/`qlive` before acting on it for anything else. */
  isCurrent(qid: string): boolean;
}

export function createQuestionPanel(panel: HTMLElement, body: HTMLElement): QuestionPanel {
  /**
   * Scroll the SIDE COLUMN only, never the page.
   *
   * `scrollIntoView` walks every scrollable ancestor, and below 1080px the
   * whole app scrolls — so on a small display it would push the join URL off
   * the top of the screen at exactly the moment the room is busiest.
   */
  const scrollPanelIntoView = (): void => {
    const scroller = panel.parentElement;
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, panel.offsetTop - scroller.offsetTop);
  };

  const meta = el('div', 'qmeta');
  const kind = el('span', 'chip');
  const count = el('span', 'qcount', '0/0');
  const timerEl = el('span', 'qtimer', '');
  meta.append(kind, count, timerEl);

  const waitBox = el('div', 'waitbox');
  const waitLabel = el('div', 'eyebrow', 'WAITING ON');
  const waitNames = el('div', 'waitnames', '—');
  const doneNames = el('div', 'donenames', '');
  waitBox.append(waitLabel, waitNames, doneNames);

  const text = el('div', 'qtext');
  const options = el('div');
  const keyNote = el('p', 'qhidden', 'THE ANSWER IS REVEALED WHEN THE QUESTION CLOSES');
  const outcomes = el('div');

  body.append(meta, waitBox, text, options, keyNote, outcomes);

  let question: QuestionMsg | null = null;
  let reveal: RevealMsg | null = null;

  function paintOptions(): void {
    clear(options);
    if (!question) return;
    const key = reveal && reveal.qid === question.qid ? reveal.correct : null;
    const opts = Array.isArray(question.options) ? question.options : [];
    opts.forEach((opt, i) => {
      const correct = key === i;
      const line = el('div', correct ? 'qopt correct' : 'qopt');
      line.textContent = `${LETTERS[i] ?? '?'}. ${String(opt)}${correct ? '   ← CORRECT' : ''}`;
      options.append(line);
    });
  }

  function paintOutcomes(): void {
    clear(outcomes);
    if (!reveal || !question || reveal.qid !== question.qid) return;
    if (!Array.isArray(reveal.outcomes)) return;
    for (const o of reveal.outcomes) {
      if (!o || typeof o.name !== 'string') continue;
      const chose = o.choice === null || o.choice === undefined
        ? 'no answer'
        : `chose ${LETTERS[o.choice] ?? '?'}`;
      const delta = o.delta > 0 ? `+${o.delta} life` : o.delta < 0 ? `${o.delta} life` : 'no change';
      const line = el('div', 'outcome');
      line.append(
        el('span', undefined, `${o.name} — ${chose} — `),
        el('span', o.delta > 0 ? 'delta-up' : o.delta < 0 ? 'delta-down' : undefined, delta),
      );
      outcomes.append(line);
    }
  }

  return {
    get open(): boolean {
      return question !== null && reveal === null;
    },

    isCurrent(qid) {
      return question !== null && question.qid === qid;
    },

    showQuestion(msg) {
      question = msg;
      reveal = null;               // a new question can never inherit an old key
      show(panel, true);
      // The side column scrolls, and a teacher who was looking at the question
      // sets panel would otherwise never see the question open at all. This is
      // the one panel that is allowed to demand the column's attention.
      scrollPanelIntoView();
      show(keyNote, true);
      show(waitBox, true);
      setText(kind, msg.kind === 'revive' ? 'REVIVE QUESTION' : 'CLASS QUESTION');
      setClass(kind, msg.kind === 'revive' ? 'chip hot' : 'chip');
      setText(text, typeof msg.text === 'string' ? msg.text : '');
      setText(timerEl, `${Math.ceil(Number(msg.timer) || 0)}s`);
      setText(count, '0/0');
      // `waitingOn` is populated for anyone who cannot answer, which includes
      // the teacher. It is the only source of this list until the first
      // `qlive` lands, and after a mid-question page reload there may not BE
      // another one until some student answers — so seed from it rather than
      // showing a dash for the rest of the timer.
      const waiting = Array.isArray(msg.waitingOn) ? msg.waitingOn.filter((n) => typeof n === 'string') : [];
      setText(waitNames, waiting.length ? waiting.join('   ') : '—');
      setClass(waitNames, 'waitnames');
      setText(doneNames, '');
      clear(outcomes);
      paintOptions();
    },

    setLive(qid, rows) {
      if (!question || question.qid !== qid || !Array.isArray(rows)) return;
      const waiting: string[] = [];
      const done: string[] = [];
      for (const r of rows) {
        if (!r || typeof r.name !== 'string') continue;
        if (!r.eligible) continue;   // dropped: they cannot block the close
        (r.answered ? done : waiting).push(r.name);
      }
      setText(waitNames, waiting.length ? waiting.join('   ') : 'EVERYONE HAS ANSWERED');
      setClass(waitNames, waiting.length ? 'waitnames' : 'waitnames st-alive');
      setText(doneNames, done.length ? `answered: ${done.join(', ')}` : '');
    },

    setTick(qid, answered, total, remaining) {
      if (!question || question.qid !== qid) return;
      setText(count, `${Number(answered) || 0}/${Number(total) || 0}`);
      setText(timerEl, `${Math.ceil(Math.max(0, Number(remaining) || 0))}s`);
    },

    showReveal(msg) {
      // A reveal for a question this page never saw (a mid-question reload)
      // has nothing to reveal against. Showing an empty CLOSED panel that
      // nothing later clears is worse than showing nothing.
      if (!question || question.qid !== msg.qid) return;
      reveal = msg;
      show(panel, true);
      show(keyNote, false);
      show(waitBox, false);
      setText(kind, 'CLOSED');
      setClass(kind, 'chip live');
      setText(timerEl, '');
      paintOptions();
      paintOutcomes();
    },

    hide() {
      question = null;
      reveal = null;
      show(panel, false);
      clear(options);
      clear(outcomes);
    },
  };
}
