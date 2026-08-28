// The teacher console (SPEC §3, §7). Served at `/`, loopback only.
//
// Three jobs, in the order a teacher needs them:
//   1. Show the join URL, always current, big enough to copy onto a whiteboard
//      from across the room (SPEC §4, and R5 — the IP can change between
//      periods, so this is rendered from the live `lobby` message and never
//      from anything cached).
//   2. Start and end a match.
//   3. Everything else: settings, roster, the open question, question sets,
//      the scoreboard.
//
// TWO CLOCKS, ON PURPOSE. The arena runs on requestAnimationFrame; every DOM
// panel on this page updates only when a message arrives. Re-rendering a
// 25-row roster sixty times a second would cost more than the game does.
//
// NOTHING HERE MAY WHITE-SCREEN. Every inbound message is dispatched inside a
// try/catch and every field it carries is treated as untrusted, because the
// alternative is a teacher standing in front of a class looking at a blank
// page with no way to recover but a reload.

import { DEFAULT_SETTINGS, type MatchSettings } from '../../shared/config';
import type {
  ClientMsg, Phase, QuestionSetSummary, RosterEntry, ServerMsg, SnapPlayer,
} from '../../shared/protocol';
import { Socket } from '../net/socket';
import { ArenaView } from './arena';
import { Sfx } from './audio';
import { byId, setClass, setText, show } from './dom';
import { createQuestionPanel } from './question';
import {
  createRosterPanel, createScorePanel, createSettingsPanel, settingsEditable,
  type ScoreRow,
} from './panels';
import { createSetsPanel } from './sets';

/**
 * How long a page on which no student has EVER connected waits before saying
 * so (SPEC §14 R3).
 *
 * The trade is between crying wolf and staying silent. A teacher who opens the
 * console before the bell and watches an alarm appear while the class is still
 * walking in learns to ignore it, and an ignored warning is the same as no
 * warning. Ninety seconds is long enough that the first student is normally
 * already in, and still a small fraction of a period if the firewall prompt
 * was denied and nobody is ever getting in.
 */
const NO_STUDENT_WARN_MS = 90_000;

/** No message at all for this long means the socket is down. The room
 *  broadcasts a snapshot 30 times a second in every phase, lobby included, so
 *  silence here is unambiguous. */
const LINK_TIMEOUT_MS = 2500;

/** Never shrink the join URL past this. At this size a 32-character address is
 *  under 400px wide, so the floor is never actually reached on a real screen —
 *  it exists so the fit loop cannot run away. */
const MIN_JOIN_URL_PX = 22;

function main(): void {
  const sfx = new Sfx();
  const socket = new Socket('teacher');

  const send = (msg: ClientMsg): void => socket.send(msg);

  // ---------------------------------------------------------------- state
  let phase: Phase = 'lobby';
  let settings: MatchSettings = DEFAULT_SETTINGS;
  let roster: readonly RosterEntry[] = [];
  let sets: readonly QuestionSetSummary[] = [];
  let joinUrl = '';
  let everStudent = false;
  /**
   * Students who are dead in the sim but still eligible in the OPEN question,
   * i.e. answering for their life back (SPEC §6.2). This is the only signal on
   * the wire that separates `pending-revive` from `out`, and it is teacher-only
   * (`qlive`). It carries no answer and no choice — only who is being waited on.
   */
  let revivingPids: ReadonlySet<string> = new Set();
  /** The newest seat vitals seen, so the roster can be repainted when the
   *  revive set changes without waiting for the next snapshot to differ. */
  let lastPlayers: readonly SnapPlayer[] = [];
  let warnDismissed = false;
  let lastMessageAt = Date.now();
  let linkUp = false;

  // ------------------------------------------------------------- elements
  const joinUrlEl = byId('joinurl');
  const copyBtn = byId<HTMLButtonElement>('copy');
  const healthLink = byId<HTMLAnchorElement>('healthlink');
  const linkChip = byId('link');
  const phaseChip = byId('phase');
  const joinedChip = byId('joined');
  const muteBtn = byId<HTMLButtonElement>('mute');
  const warnEl = byId('warn');
  const warnDismiss = byId<HTMLButtonElement>('warndismiss');
  const startBtn = byId<HTMLButtonElement>('start');
  const endBtn = byId<HTMLButtonElement>('end');
  const rematchBtn = byId<HTMLButtonElement>('rematch');
  const closeBtn = byId<HTMLButtonElement>('closenow');
  const quitBtn = byId<HTMLButtonElement>('quit');
  const fsBtn = byId<HTMLButtonElement>('fs');
  const arenaWrap = byId('arenawrap');
  const arenaMsg = byId('arenamsg');
  const questionPanelEl = byId('panel-question');
  const setsPanelEl = byId('panel-sets');
  const scorePanelEl = byId('panel-score');
  const fatalEl = byId('fatal');

  const fatal = (message: string): void => {
    setText(fatalEl, `${message}  (click to dismiss)`);
    show(fatalEl, true);
  };
  // It is pinned over the bottom of the arena, so it must be dismissible —
  // an unrecoverable strip across a projected game is its own failure.
  fatalEl.addEventListener('click', () => show(fatalEl, false));

  // -------------------------------------------------------------- panels
  const settingsPanel = createSettingsPanel(byId('settings'), byId('settingslock'), send);
  const rosterPanel = createRosterPanel(byId('roster'), byId('rostercount'), byId('rosterempty'), send);
  const questionPanel = createQuestionPanel(questionPanelEl, byId('q-body'));
  const setsPanel = createSetsPanel(byId('sets'), send);
  const scorePanel = createScorePanel(byId('score'));

  const arena = new ArenaView({
    canvas: byId<HTMLCanvasElement>('arena'),
    sfx,
    onPhase: (p) => {
      phase = p;
      // `Match` broadcasts `questionOff` only when a match ENDS, never at the
      // end of the normal question → reveal → announce → resume sequence. So
      // without this the closed question — its text, its correct answer, and
      // every student's choice — stays projected on the wall through the
      // countdown and the whole next rally. The sequence is over at `resume`.
      if (p === 'resume' || p === 'playing' || p === 'countdown' || p === 'lobby') {
        questionPanel.hide();
        if (revivingPids.size > 0) {
          revivingPids = new Set();
          rosterPanel.setVitals(lastPlayers, revivingPids);
        }
      }
      paintControls();
    },
    onVitals: (players) => {
      lastPlayers = players;
      rosterPanel.setVitals(players, revivingPids);
    },
    onFatal: fatal,
  });
  arena.start();

  // ------------------------------------------------------------ controls

  function paintControls(): void {
    // Start is offered only where it means "begin", never where it would
    // silently discard a match in progress. End game is legal everywhere else.
    startBtn.disabled = phase !== 'lobby';
    endBtn.disabled = phase === 'lobby';
    rematchBtn.disabled = phase !== 'matchover';
    show(closeBtn, phase === 'question');

    setText(phaseChip, phase.toUpperCase());
    setClass(phaseChip, phase === 'question' ? 'chip hot' : phase === 'lobby' ? 'chip' : 'chip live');

    settingsPanel.update(settings, sets, phase);
    // The CSV textarea holds the `correct` column, and this page is projected
    // on a wall. A set cannot be selected mid-match anyway, so the whole panel
    // goes away while one is running rather than showing the class an answer
    // key the teacher forgot to clear.
    show(setsPanelEl, settingsEditable(phase));

    const waiting = phase === 'lobby';
    show(arenaMsg, waiting);
    if (waiting) {
      setText(arenaMsg, roster.length
        ? `${roster.length} STUDENT${roster.length === 1 ? '' : 'S'} READY — PRESS START`
        : 'WAITING FOR STUDENTS — BOTS WILL FILL ANY EMPTY SEATS');
    }
  }

  startBtn.addEventListener('click', () => send({ t: 'start' }));
  endBtn.addEventListener('click', () => send({ t: 'end' }));
  rematchBtn.addEventListener('click', () => send({ t: 'rematch' }));
  closeBtn.addEventListener('click', () => send({ t: 'closeQuestion' }));

  // Quit shuts the server down and ends the session for all 25 of them, so it
  // is the one control on this page that asks first. End game is not
  // destructive — the roster and scoreboard survive it — so it does not.
  const confirmEl = byId('confirm');
  const confirmText = byId('confirmtext');
  const confirmYes = byId<HTMLButtonElement>('confirmyes');
  const confirmNo = byId<HTMLButtonElement>('confirmno');
  let onConfirm: (() => void) | null = null;

  function ask(message: string, yesLabel: string, action: () => void): void {
    setText(confirmText, message);
    setText(confirmYes, yesLabel);
    onConfirm = action;
    show(confirmEl, true);
    confirmNo.focus();
  }
  confirmNo.addEventListener('click', () => {
    onConfirm = null;
    show(confirmEl, false);
  });
  confirmYes.addEventListener('click', () => {
    const action = onConfirm;
    onConfirm = null;
    show(confirmEl, false);
    action?.();
  });
  quitBtn.addEventListener('click', () => {
    ask(
      'Quit PolyPong? This ends the session for every student and shuts the app down.',
      'YES, QUIT',
      () => send({ t: 'quit' }),
    );
  });

  // ------------------------------------------------------------ join URL

  function paintJoinUrl(url: string): void {
    joinUrl = url;
    setText(joinUrlEl, url || '—');
    fitJoinUrl();
    try {
      healthLink.href = url ? new URL(url).origin + '/health' : '/health';
    } catch {
      healthLink.href = '/health';
    }
  }

  /**
   * Shrink the join URL until it FITS, rather than letting it ellipsise.
   *
   * This is the one string on the page that must never be wrong, and an
   * ellipsis makes it wrong in the most expensive way available: the teacher
   * copies `http://192.168.100.1…` onto the board and not one student in the
   * room can join. That address is not hypothetical — a 15-character host on a
   * 1440-wide laptop overflows the header at the CSS clamp's top size.
   *
   * Measured and corrected rather than guessed, because the width available
   * depends on the sibling chips, which depend on the roster count.
   */
  function fitJoinUrl(): void {
    joinUrlEl.style.fontSize = '';
    if (joinUrlEl.scrollWidth <= joinUrlEl.clientWidth) return;
    const max = parseFloat(window.getComputedStyle(joinUrlEl).fontSize);
    if (!Number.isFinite(max) || max <= 0) return;
    let size = Math.max(
      MIN_JOIN_URL_PX,
      Math.floor((max * joinUrlEl.clientWidth) / joinUrlEl.scrollWidth),
    );
    joinUrlEl.style.fontSize = `${size}px`;
    // The first pass is a ratio, which is exact for a monospace face and close
    // enough otherwise; these are the rounding corrections.
    for (let i = 0; i < 8 && size > MIN_JOIN_URL_PX; i++) {
      if (joinUrlEl.scrollWidth <= joinUrlEl.clientWidth) break;
      size -= 1;
      joinUrlEl.style.fontSize = `${size}px`;
    }
  }

  let fitPending = 0;
  window.addEventListener('resize', () => {
    if (fitPending !== 0) return;
    fitPending = requestAnimationFrame(() => {
      fitPending = 0;
      fitJoinUrl();
    });
  });

  copyBtn.addEventListener('click', () => {
    if (!joinUrl) return;
    const done = (): void => {
      setText(copyBtn, 'COPIED');
      window.setTimeout(() => setText(copyBtn, 'COPY'), 1500);
    };
    // `navigator.clipboard?.writeText(...)` would short-circuit the WHOLE
    // chain when the API is absent, so the fallback below could never run.
    const api = navigator.clipboard;
    if (!api) return fallbackCopy(joinUrl, done);
    api.writeText(joinUrl).then(done).catch(() => fallbackCopy(joinUrl, done));
  });

  function fallbackCopy(text: string, done: () => void): void {
    // Clipboard access can be refused even on localhost if the window is not
    // focused. A hidden textarea plus execCommand still works everywhere.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch {
      setText(copyBtn, 'COPY FAILED');
      window.setTimeout(() => setText(copyBtn, 'COPY'), 2000);
    }
  }

  // ------------------------------------------------------- audio, screen

  // Browsers block audio until a gesture. Arm on the first one, whatever it
  // was, and never complain in the console when it is refused.
  const armAudio = (): void => sfx.arm();
  window.addEventListener('pointerdown', armAudio, { capture: true });
  window.addEventListener('keydown', armAudio, { capture: true });

  muteBtn.addEventListener('click', () => {
    sfx.muted = !sfx.muted;
    sfx.arm();
    setText(muteBtn, sfx.muted ? 'SOUND OFF' : 'SOUND ON');
    setClass(muteBtn, sfx.muted ? 'btn' : 'btn go');
  });
  setClass(muteBtn, 'btn go');

  // Fullscreen the arena alone, so the projector shows the game and nothing
  // else while the console stays live on the laptop's own screen.
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void arenaWrap.requestFullscreen?.().catch(() => undefined);
  });
  document.addEventListener('fullscreenchange', () => {
    setText(fsBtn, document.fullscreenElement ? 'EXIT FULL SCREEN' : 'FULL SCREEN');
  });

  // ------------------------------------------------------------ messages

  const endedEl = byId('ended');
  const endedText = byId('endedtext');

  function handle(msg: ServerMsg): void {
    lastMessageAt = Date.now();
    if (!linkUp) {
      linkUp = true;
      setText(linkChip, 'CONNECTED');
      setClass(linkChip, 'chip live');
      fitJoinUrl();   // the chip just got narrower; the URL may fit larger now
    }

    switch (msg.t) {
      case 'welcome':
        // A reconnect lands here. The snapshot timeline it was interpolating
        // against may no longer exist, so start the stream over rather than
        // blending across the gap.
        arena.reset();
        return;

      case 'lobby': {
        if (Array.isArray(msg.roster)) roster = msg.roster;
        if (msg.settings) settings = msg.settings;
        if (typeof msg.joinUrl === 'string') paintJoinUrl(msg.joinUrl);
        if (typeof msg.phase === 'string') phase = msg.phase;
        if (roster.length > 0) everStudent = true;
        arena.setMaxLives(settings.lives);
        rosterPanel.update(roster, settings.lives);
        setText(joinedChip, `${roster.length} JOINED`);
        paintControls();
        return;
      }

      case 'snap':
        if (typeof msg.c === 'number' && msg.s) arena.push(msg.c, msg.s);
        return;

      case 'sets':
        if (Array.isArray(msg.sets)) {
          sets = msg.sets;
          setsPanel.update(sets);
          settingsPanel.update(settings, sets, phase);
        }
        return;

      case 'question':
        revivingPids = new Set();
        questionPanel.showQuestion(msg);
        sfx.chime();
        return;

      case 'qtick':
        questionPanel.setTick(msg.qid, msg.answered, msg.total, msg.remaining);
        return;

      case 'qlive': {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        if (!questionPanel.isCurrent(msg.qid)) return;
        questionPanel.setLive(msg.qid, rows);
        const next = new Set<string>();
        for (const r of rows) if (r?.eligible && typeof r.pid === 'string') next.add(r.pid);
        revivingPids = next;
        rosterPanel.setVitals(lastPlayers, revivingPids);
        return;
      }

      case 'reveal':
        // Deliberately does NOT clear `revivingPids`. A student who hit zero
        // from a class question is owed a revive question that has not been
        // asked yet, and `Match` sends no roster update in between — clearing
        // here would flash OUT beside their name for the five seconds
        // immediately before they are handed a lifeline. The phase change to
        // `resume` clears it, by which point the outcome really is settled.
        questionPanel.showReveal(msg);
        return;

      case 'questionOff':
        revivingPids = new Set();
        questionPanel.hide();
        return;

      case 'scoreboard':
        if (Array.isArray(msg.rows)) {
          scorePanel.update(msg.rows as ScoreRow[]);
          show(scorePanelEl, msg.rows.length > 0);
        }
        return;

      case 'ended':
        setText(endedText, typeof msg.msg === 'string' ? msg.msg : 'The session has ended.');
        show(endedEl, true);
        return;

      case 'error':
        fatal(typeof msg.msg === 'string' ? msg.msg : 'The server refused that.');
        return;

      default:
        return;
    }
  }

  socket.onMessage((msg) => {
    try {
      handle(msg);
    } catch (err) {
      // One bad frame must not take the console down. Log it once per kind and
      // carry on: the next snapshot is 33 ms away.
      console.warn('teacher console: dropped a message it could not handle', err);
    }
  });

  // ------------------------------------------------- link + firewall watch

  warnDismiss.addEventListener('click', () => {
    warnDismissed = true;
    show(warnEl, false);
  });

  const bootAt = Date.now();
  window.setInterval(() => {
    const now = Date.now();

    if (linkUp && now - lastMessageAt > LINK_TIMEOUT_MS) {
      linkUp = false;
      setText(linkChip, 'RECONNECTING');
      setClass(linkChip, 'chip dead');
      fitJoinUrl();   // a wider chip leaves less room; refit before it clips
    }

    // SPEC §14 R3. If the teacher clicked Deny on the macOS firewall prompt,
    // students cannot reach the server and nothing on any screen says why —
    // this page is the only place in the system that can notice.
    const shouldWarn =
      !everStudent && !warnDismissed && now - bootAt > NO_STUDENT_WARN_MS;
    show(warnEl, shouldWarn);
  }, 1000);

  paintJoinUrl('');
  paintControls();
  settingsPanel.update(settings, sets, phase);
  rosterPanel.update(roster, settings.lives);
  socket.connect();
}

try {
  main();
} catch (err) {
  // The page failed to wire itself up at all. Say so in plain words rather
  // than leaving a black rectangle on a classroom wall.
  const note = document.createElement('div');
  note.className = 'fatal';
  note.textContent = `PolyPong console failed to start: ${
    err instanceof Error ? err.message : String(err)
  }. Reload this page.`;
  document.body.append(note);
  console.error(err);
}
