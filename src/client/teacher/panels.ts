// Settings, roster, and scoreboard. Every function here runs ON MESSAGE, never
// on an animation frame: the roster is repainted when a `lobby` message
// arrives (a join, a rename, a life change), not sixty times a second.

import { SETTING_RANGE, type MatchSettings } from '../../shared/config';
import type {
  ClientMsg, Phase, QuestionSetSummary, RosterEntry, SnapPlayer,
} from '../../shared/protocol';
import { button, clear, el, pips, setClass, setText, show } from './dom';

export type Send = (msg: ClientMsg) => void;

/** Settings are editable only where `Match` will actually accept them. A
 *  control that silently does nothing is worse than a disabled one. */
export function settingsEditable(phase: Phase): boolean {
  return phase === 'lobby' || phase === 'matchover';
}

// ---------------------------------------------------------------- settings

interface Stepper {
  readonly row: HTMLElement;
  set(value: number): void;
}

/**
 * A minus/plus stepper rather than a slider or a number field. Two reasons,
 * both classroom ones: it is hittable without aiming while standing at the
 * front of a room, and it has no focused editing state, so a `lobby` message
 * arriving mid-adjustment cannot fight the teacher for the value.
 */
function stepper(
  label: string,
  lo: number,
  hi: number,
  step: number,
  onChange: (value: number) => void,
  format: (value: number) => string = String,
): Stepper {
  const row = el('div', 'set');
  const name = el('span', 'name', label);
  const minus = button('btn step', '−');
  const val = el('span', 'val');
  const plus = button('btn step', '+');
  row.append(name, minus, val, plus);

  let current = lo;
  const set = (value: number): void => {
    current = Math.min(hi, Math.max(lo, Math.round(value)));
    setText(val, format(current));
    minus.disabled = current <= lo;
    plus.disabled = current >= hi;
  };
  minus.addEventListener('click', () => {
    if (current > lo) onChange(Math.max(lo, current - step));
  });
  plus.addEventListener('click', () => {
    if (current < hi) onChange(Math.min(hi, current + step));
  });
  set(lo);
  return { row, set };
}

export interface SettingsPanel {
  update(settings: MatchSettings, sets: readonly QuestionSetSummary[], phase: Phase): void;
}

export function createSettingsPanel(
  root: HTMLElement,
  lock: HTMLElement,
  send: Send,
): SettingsPanel {
  const fields = el('fieldset');
  const patch = (p: Partial<MatchSettings>): void => void send({ t: 'settings', patch: p });

  const arena = stepper('ARENA SIZE', ...SETTING_RANGE.arenaSize, 1, (v) => patch({ arenaSize: v }),
    (v) => `${v}`);
  const lives = stepper('LIVES', ...SETTING_RANGE.lives, 1, (v) => patch({ lives: v }));
  const revives = stepper('REVIVES / STUDENT', ...SETTING_RANGE.revivesPerStudent, 1,
    (v) => patch({ revivesPerStudent: v }));
  const timer = stepper('QUESTION TIMER', ...SETTING_RANGE.questionTimerSec, 5,
    (v) => patch({ questionTimerSec: v }), (v) => `${v}s`);

  const qRow = el('div', 'set');
  const qToggle = button('btn toggle', 'ON');
  qRow.append(el('span', 'name', 'QUESTIONS'), qToggle);
  let questionsOn = true;
  qToggle.addEventListener('click', () => patch({ questionsEnabled: !questionsOn }));

  const setRow = el('div', 'set');
  const setSelect = el('select');
  setRow.append(el('span', 'name', 'QUESTION SET'), setSelect);
  setSelect.addEventListener('change', () => {
    patch({ setId: setSelect.value === '' ? null : setSelect.value });
  });

  fields.append(arena.row, qRow, setRow, timer.row, revives.row, lives.row);
  root.append(fields);

  let setsKey = '';

  return {
    update(settings, sets, phase) {
      arena.set(settings.arenaSize);
      lives.set(settings.lives);
      revives.set(settings.revivesPerStudent);
      timer.set(settings.questionTimerSec);

      questionsOn = settings.questionsEnabled;
      setText(qToggle, questionsOn ? 'ON' : 'OFF');
      setClass(qToggle, `btn toggle ${questionsOn ? 'on' : 'off'}`);

      // Rebuilt only when the list actually changed, so an open dropdown is
      // not yanked shut by an unrelated lobby message.
      const key = sets.map((s) => `${s.id}:${s.name}:${s.count}`).join('|');
      if (key !== setsKey) {
        setsKey = key;
        clear(setSelect);
        const auto = el('option', undefined, sets.length ? 'First set (automatic)' : 'No sets saved');
        auto.value = '';
        setSelect.append(auto);
        for (const s of sets) {
          const o = el('option', undefined, `${s.name} (${s.count})`);
          o.value = s.id;
          setSelect.append(o);
        }
      }
      const wanted = settings.setId ?? '';
      const exists = wanted === '' || sets.some((s) => s.id === wanted);
      if (setSelect.value !== (exists ? wanted : '')) setSelect.value = exists ? wanted : '';

      const editable = settingsEditable(phase);
      fields.disabled = !editable;
      setText(lock, editable ? '' : '— LOCKED WHILE PLAYING');
      setClass(lock, editable ? 'count' : 'count locked');
    },
  };
}

// ------------------------------------------------------------------ roster

interface Row {
  root: HTMLElement;
  swatch: HTMLElement;
  name: HTMLElement;
  pips: HTMLElement;
  status: HTMLElement;
  conn: HTMLElement;
  score: HTMLElement;
  rename: HTMLButtonElement;
  remove: HTMLButtonElement;
  editing: boolean;
}

/** The wire is not trusted. A field that arrives as null or a string must
 *  degrade to something readable on a projector, never to "Q null/null". */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v !== '' ? v : fallback;

const STATUS_TEXT: Record<RosterEntry['status'], string> = {
  waiting: 'WAITING',
  alive: 'ALIVE',
  'pending-revive': 'REVIVE?',
  out: 'OUT',
};

const STATUS_CLASS: Record<RosterEntry['status'], string> = {
  waiting: 'rstatus st-waiting',
  alive: 'rstatus st-alive',
  'pending-revive': 'rstatus st-revive',
  out: 'rstatus st-out',
};

export interface RosterPanel {
  update(roster: readonly RosterEntry[], maxLives: number): void;
  /**
   * Lives and alive/dead straight off the snapshot stream.
   *
   * `Match` broadcasts a `lobby` message on a join, a rename, a removal, a
   * start and an end — but NOT on an elimination, so `RosterEntry.lives` is
   * the value it had when the match began. The snapshot is the only live
   * source, and `revivingPids` (from the teacher-only `qlive` rows) is the
   * only way to tell a student who is out for good from one who is currently
   * answering for their life back.
   */
  setVitals(players: readonly SnapPlayer[], revivingPids: ReadonlySet<string>): void;
}

export function createRosterPanel(
  root: HTMLElement,
  count: HTMLElement,
  empty: HTMLElement,
  send: Send,
): RosterPanel {
  const rows = new Map<string, Row>();

  function makeRow(pid: string): Row {
    // Two lines per student: the name and the two actions on the first, the
    // status detail on the second. A single line makes REMOVE the first thing
    // to be squeezed off the edge, and REMOVE is the control a teacher reaches
    // for fastest when a student joins under a name they should not have.
    const rowEl = el('div', 'rrow');
    const swatch = el('span', 'swatch');
    const name = el('span', 'rname');
    const pipsEl = el('span', 'pips');
    const meta = el('span', 'rmeta');
    const status = el('span', 'rstatus');
    const conn = el('span', 'rconn');
    const score = el('span', 'rq');
    meta.append(status, conn, score);
    const acts = el('span', 'racts');
    const rename = button('btn small', 'RENAME');
    const remove = button('btn small danger', 'REMOVE');
    acts.append(rename, remove);
    rowEl.append(swatch, name, pipsEl, acts, meta);

    const row: Row = {
      root: rowEl, swatch, name, pips: pipsEl, status, conn, score, rename, remove,
      editing: false,
    };

    remove.addEventListener('click', () => send({ t: 'removePlayer', pid }));

    // Inline rename, not a modal: the roster row stays where the eye already
    // is, and Escape puts it back exactly as it was.
    rename.addEventListener('click', () => {
      if (row.editing) return;
      row.editing = true;
      const before = row.name.textContent ?? '';
      const input = el('input');
      input.type = 'text';
      input.maxLength = 10;
      input.value = before;
      clear(row.name);
      row.name.append(input);
      input.focus();
      input.select();

      let done = false;
      const finish = (commit: boolean): void => {
        if (done) return;
        done = true;
        row.editing = false;
        const next = input.value.trim();
        clear(row.name);
        row.name.textContent = commit && next ? next : before;
        if (commit && next && next !== before) send({ t: 'renamePlayer', pid, name: next });
      };
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    });

    return row;
  }

  let lastRoster: readonly RosterEntry[] = [];
  let lastMaxLives = 3;
  let vitals: ReadonlyMap<number, SnapPlayer> = new Map();
  let reviving: ReadonlySet<string> = new Set();

  /** Paints the mutable half of every row from the roster plus whatever the
   *  snapshot has said since the roster was last broadcast. */
  function paintVitals(): void {
    for (const entry of lastRoster) {
      const row = rows.get(entry.pid);
      if (!row) continue;
      const live = entry.seat === null ? undefined : vitals.get(entry.seat);
      const seated = entry.status !== 'waiting';
      const lives = num(live && seated ? live.l : entry.lives);
      const alive = live && seated ? live.a === 1 : entry.status === 'alive';

      let status: RosterEntry['status'];
      if (!seated) status = 'waiting';
      else if (alive) status = 'alive';
      else if (reviving.has(entry.pid)) status = 'pending-revive';
      else status = 'out';

      setText(row.pips, status === 'waiting' ? '—' : pips(lives, lastMaxLives));
      setText(row.status, STATUS_TEXT[status] ?? 'WAITING');
      setClass(row.status, STATUS_CLASS[status] ?? 'rstatus');
    }
  }

  return {
    setVitals(players, revivingPids) {
      const map = new Map<number, SnapPlayer>();
      for (const p of players) if (p) map.set(p.i, p);
      vitals = map;
      reviving = revivingPids;
      paintVitals();
    },

    update(roster, maxLives) {
      lastRoster = roster;
      lastMaxLives = maxLives;
      const seen = new Set<string>();
      for (const entry of roster) {
        if (!entry || typeof entry.pid !== 'string') continue;
        seen.add(entry.pid);
        let row = rows.get(entry.pid);
        if (!row) {
          row = makeRow(entry.pid);
          rows.set(entry.pid, row);
          root.append(row.root);
        }
        row.swatch.style.backgroundColor = entry.color ?? '#26313f';
        if (!row.editing) setText(row.name, str(entry.name, '(no name)'));
        setText(row.conn, entry.connected ? 'CONNECTED' : 'DROPPED — BOT');
        setClass(row.conn, entry.connected ? 'rconn' : 'rconn drop');
        setText(row.score, `Q ${num(entry.correct)}/${num(entry.attempted)}`);
      }

      for (const [pid, row] of rows) {
        if (seen.has(pid)) continue;
        row.root.remove();
        rows.delete(pid);
      }

      // Reorder only when the order is genuinely wrong. Re-appending a node
      // blurs anything focused inside it, which would kill an open rename.
      let dirty = false;
      let i = 0;
      for (const entry of roster) {
        if (root.children[i] !== rows.get(entry.pid)?.root) { dirty = true; break; }
        i++;
      }
      if (dirty && ![...rows.values()].some((r) => r.editing)) {
        for (const entry of roster) {
          const row = rows.get(entry.pid);
          if (row) root.append(row.root);
        }
      }

      paintVitals();
      setText(count, roster.length ? `${roster.length}` : '');
      show(empty, roster.length === 0);
    },
  };
}

// -------------------------------------------------------------- scoreboard

export interface ScoreRow {
  pid: string;
  name: string;
  place: number;
  correct: number;
  attempted: number;
  matchesWon: number;
}

export interface ScorePanel {
  update(rows: readonly ScoreRow[]): void;
}

export function createScorePanel(root: HTMLElement): ScorePanel {
  const head = el('div', 'scorerow head');
  head.append(
    el('span', undefined, 'PLACE'),
    el('span', undefined, 'NAME'),
    el('span', undefined, 'QUESTIONS'),
    el('span', undefined, 'WINS'),
  );
  const body = el('div');
  root.append(head, body);

  return {
    update(rows) {
      clear(body);
      for (const r of rows) {
        if (!r) continue;
        const line = el('div', 'scorerow');
        line.append(
          el('span', 'place', num(r.place) > 0 ? `#${num(r.place)}` : '—'),
          el('span', undefined, str(r.name, '(no name)')),
          el('span', undefined, `${num(r.correct)}/${num(r.attempted)}`),
          el('span', undefined, String(num(r.matchesWon))),
        );
        body.append(line);
      }
    },
  };
}
