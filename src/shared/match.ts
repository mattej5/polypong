// The room: seats, roster, phase machine, question orchestration.
//
// Owns no runtime API (SPEC I12). It is handed transport callbacks and a
// persistence callback, and is driven by an external clock. That is what lets
// it run headlessly at 1000x speed under `bun test`, and what would let it
// move to a hosted server later without touching game logic (SPEC §14 R1).
//
// The single most important property of this file: EVERY PHASE THAT WAITS ON
// A HUMAN OWNS A TIMER THAT FIRES WITHOUT THEM (SPEC I1). The previous build
// had three independent things that could stop the world — a pause flag, a
// hazard placement hold, and a quiz freeze — and they collided on every
// elimination, which is precisely when all three wanted to be true. Here,
// `phase` alone decides whether the ball moves, and every phase except
// `lobby`, `playing`, and `matchover` is on a countdown it cannot escape.

import {
  COLORS, DEFAULT_SETTINGS, MAX_SEATS, NAME_MAX_LEN, TIMING,
  sanitizeSettings, type MatchSettings, type Rng,
} from './config';
import {
  PROTOCOL, type ClientMsg, type Phase, type RosterEntry, type ServerMsg,
} from './protocol';
import { Game } from './sim/game';
import {
  QuestionDeck, QuestionEngine, buildRevealMsg, parseCsv,
  type Outcome, type Participant, type Question,
} from './quiz';

/** Opaque connection identity, minted by the transport adapter. */
export type ConnId = number;

export interface QuestionSetRecord {
  id: string;
  name: string;
  csv: string;
}

export interface PersistPayload {
  sets: QuestionSetRecord[];
  settings: MatchSettings;
}

export interface MatchDeps {
  send: (id: ConnId, msg: ServerMsg) => void;
  broadcast: (msg: ServerMsg) => void;
  persist: (payload: PersistPayload) => void;
  /** Teacher pressed Quit. The adapter closes sockets and exits; Match must
   *  never do either itself. */
  onQuit: () => void;
  /** Injected randomness. Match and the sim never call Math.random (SPEC I12). */
  rng: Rng;
  settings?: MatchSettings;
  sets?: QuestionSetRecord[];
  joinUrl?: string;
}

interface Conn {
  role: 'teacher' | 'player' | null;
  pid: string | null;
  isLocal: boolean;
}

/** Session-scoped identity. Survives reconnects, reseating, and matches. */
interface Student {
  pid: string;
  token: string;
  name: string;
  /** Join order, so seats are handed out fairly at Start. */
  joined: number;
  seat: number | null;
  connId: ConnId | null;
  connected: boolean;
  revivesUsed: number;
  /** Permanently out of the CURRENT match: no route back this match. */
  out: boolean;
  correct: number;
  attempted: number;
  matchesWon: number;
}

export class Match {
  private readonly d: MatchDeps;
  private readonly game: Game;
  private readonly quiz: QuestionEngine;

  private conns = new Map<ConnId, Conn>();
  private students = new Map<string, Student>();
  private joinCounter = 0;
  private idCounter = 0;

  private settings: MatchSettings;
  private sets: QuestionSetRecord[];
  private deck: QuestionDeck | null = null;
  private joinUrl = '';

  private phase: Phase = 'lobby';
  private phaseTimer = 0;
  private banner = '';

  /** Simulation clock: the sum of every dt this room has been ticked with.
   *  Deliberately not a wall clock — this class owns no runtime API, and
   *  clients interpolate against this timeline so jitter never reaches their
   *  render clock. */
  private clock = 0;
  private snapAcc = 0;
  private quizPushAcc = 0;

  /** Set while a question is open, so `close` knows what it was about. */
  private questionKind: 'class' | 'revive' = 'class';
  /** Students owed a revive question once the current reveal finishes. */
  private pendingRevive: string[] = [];
  /** Whether the sequence should end in a serve or in a match-over screen. */
  private matchEnded = false;
  /** Permanent-elimination order for the scoreboard; winner appended last. */
  private finishOrder: string[] = [];

  constructor(deps: MatchDeps) {
    this.d = deps;
    this.settings = sanitizeSettings(deps.settings ?? DEFAULT_SETTINGS);
    this.sets = (deps.sets ?? []).map((s) => ({ ...s }));
    this.joinUrl = deps.joinUrl ?? '';
    this.game = new Game(deps.rng);
    this.quiz = new QuestionEngine();
  }

  setJoinUrl(url: string): void {
    this.joinUrl = url;
    this.pushLobby();
  }

  // ----------------------------------------------------------- connections

  join(id: ConnId, isLocal: boolean): void {
    this.conns.set(id, { role: null, pid: null, isLocal });
  }

  leave(id: ConnId): void {
    const c = this.conns.get(id);
    this.conns.delete(id);
    if (!c?.pid) return;
    const s = this.students.get(c.pid);
    if (!s) return;
    s.connected = false;
    s.connId = null;
    // A dropped student must never stall the match: the AI takes their paddle
    // and gives it straight back if they reconnect...
    if (s.seat !== null) {
      this.game.setBot(s.seat, true);
      this.game.setInput(s.seat, 0);
    }
    // ...and must never stall an open question either. A sleeping Chromebook
    // is dropped from the answer set so "everyone has answered" still
    // terminates. This is SPEC I4 and it is the whole reason a question can
    // never hang the room.
    this.quiz.dropParticipant(c.pid);
    this.pushLobby();
  }

  message(id: ConnId, msg: ClientMsg): void {
    const c = this.conns.get(id);
    if (!c || !msg) return;
    if (msg.t === 'hello') return this.hello(id, c, msg);
    if (c.role === 'teacher') return this.teacherMessage(msg);
    if (c.role === 'player') return this.playerMessage(c, msg);
  }

  private hello(id: ConnId, c: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.role === 'teacher') {
      // Blocking the page from loading is the visible half of this. A student
      // who opens a raw socket from devtools and asks for role 'teacher' must
      // still be refused, and THIS is the check that does it (SPEC I10).
      if (!c.isLocal) {
        this.d.send(id, { t: 'error', msg: 'The teacher console only works on this computer.' });
        return;
      }
      c.role = 'teacher';
      this.d.send(id, {
        t: 'welcome', role: 'teacher', protocol: PROTOCOL,
        pid: null, token: null, name: null, seat: null, color: null,
      });
      this.pushSets(id);
      this.pushLobby();
      this.pushQuestionTo(id, null);
      return;
    }

    c.role = 'player';
    // Reclaim on reconnect: token first, then an unoccupied name. Chromebooks
    // sleep constantly and a student who reloads must not lose their seat.
    let s = msg.token ? this.findByToken(msg.token) : undefined;
    if (!s && msg.name) s = this.findByFreeName(msg.name);
    if (!s) {
      const created = this.createStudent(msg.name);
      if (!created) {
        this.d.send(id, { t: 'error', msg: 'This class is full.' });
        return;
      }
      s = created;
    }

    // Two tabs, one student: the newer connection wins and the older is
    // dropped, rather than both driving the same paddle.
    if (s.connId !== null && s.connId !== id) this.conns.delete(s.connId);
    s.connected = true;
    s.connId = id;
    c.pid = s.pid;
    if (s.seat !== null) this.game.setBot(s.seat, false);

    this.d.send(id, {
      t: 'welcome', role: 'player', protocol: PROTOCOL,
      pid: s.pid, token: s.token, name: s.name,
      seat: s.seat, color: s.seat === null ? null : (COLORS[s.seat] ?? null),
    });
    this.pushLobby();
    this.pushQuestionTo(id, s.pid);
  }

  private playerMessage(c: Conn, msg: ClientMsg): void {
    const s = c.pid ? this.students.get(c.pid) : undefined;
    if (!s) return;
    if (msg.t === 'input') {
      if (s.seat === null || !s.connected) return;
      this.game.setInput(s.seat, msg.d);
      return;
    }
    if (msg.t === 'answer') {
      // The engine ignores an ineligible pid, a stale qid, and a second
      // answer, so no validation is needed here.
      this.quiz.answer(s.pid, msg.qid, msg.choice);
      this.pushQuizLive();
    }
  }

  private teacherMessage(msg: ClientMsg): void {
    switch (msg.t) {
      case 'settings':
        // Settings are locked mid-match: changing the arena size or life count
        // under a running game has no coherent meaning.
        if (this.phase !== 'lobby' && this.phase !== 'matchover') return;
        this.settings = sanitizeSettings(msg.patch, this.settings);
        this.savePersistent();
        this.pushLobby();
        return;
      case 'start': return this.startMatch();
      case 'rematch': return this.startMatch();
      case 'end': return this.endMatch();
      case 'closeQuestion':
        if (this.phase === 'question') this.closeQuestion();
        return;
      case 'quit':
        this.d.broadcast({ t: 'ended', msg: 'Your teacher ended the session.' });
        this.d.onQuit();
        return;
      case 'removePlayer': return this.removeStudent(msg.pid);
      case 'renamePlayer': return this.renameStudent(msg.pid, msg.name);
      case 'saveSet': return this.saveSet(msg.id, msg.name, msg.csv);
      case 'deleteSet': return this.deleteSet(msg.id);
      default: return;
    }
  }

  // ---------------------------------------------------------------- roster

  private findByToken(token: string): Student | undefined {
    for (const s of this.students.values()) if (s.token === token) return s;
    return undefined;
  }

  private findByFreeName(raw: string): Student | undefined {
    const name = this.cleanName(raw);
    for (const s of this.students.values()) {
      if (!s.connected && s.name === name) return s;
    }
    return undefined;
  }

  private cleanName(raw: string): string {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LEN);
  }

  /** Unique within the session; a collision gets a numeric suffix so two
   *  students called Sam are still tellable apart on the wall labels. */
  private uniqueName(base: string, exceptPid?: string): string {
    const taken = new Set<string>();
    for (const s of this.students.values()) {
      if (s.pid !== exceptPid) taken.add(s.name.toLowerCase());
    }
    const root = base || 'Player';
    if (!taken.has(root.toLowerCase())) return root;
    for (let n = 2; n < 100; n++) {
      const suffix = String(n);
      const trimmed = root.slice(0, Math.max(1, NAME_MAX_LEN - suffix.length));
      const candidate = `${trimmed}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return root.slice(0, NAME_MAX_LEN);
  }

  private createStudent(rawName?: string): Student | null {
    // Practical ceiling. Seats are capped at MAX_SEATS; everyone beyond that
    // spectates, but an unbounded roster is a memory leak with a class of 30
    // reloading tabs.
    if (this.students.size >= 60) return null;
    const pid = `p${++this.idCounter}`;
    const s: Student = {
      pid,
      token: `${pid}-${Math.floor(this.d.rng() * 1e9).toString(36)}`,
      name: this.uniqueName(this.cleanName(rawName ?? '') || `Player ${this.idCounter}`),
      joined: ++this.joinCounter,
      seat: null,
      connId: null,
      connected: false,
      revivesUsed: 0,
      out: false,
      correct: 0,
      attempted: 0,
      matchesWon: 0,
    };
    this.students.set(pid, s);
    return s;
  }

  private removeStudent(pid: string): void {
    const s = this.students.get(pid);
    if (!s) return;
    if (s.seat !== null) this.game.setBot(s.seat, true);
    this.quiz.dropParticipant(pid);
    if (s.connId !== null) {
      this.d.send(s.connId, { t: 'ended', msg: 'Your teacher removed you from the game.' });
      this.conns.delete(s.connId);
    }
    this.students.delete(pid);
    this.pushLobby();
  }

  private renameStudent(pid: string, raw: string): void {
    const s = this.students.get(pid);
    if (!s) return;
    s.name = this.uniqueName(this.cleanName(raw) || s.name, pid);
    if (s.seat !== null) this.game.setLabel(s.seat, s.name);
    this.pushLobby();
  }

  private seatedStudent(seat: number): Student | undefined {
    for (const s of this.students.values()) if (s.seat === seat) return s;
    return undefined;
  }

  // ------------------------------------------------------------- lifecycle

  private startMatch(): void {
    const size = this.settings.arenaSize;

    // Seats go to students in join order. Bots fill whatever is left at the
    // moment Start is pressed (SPEC §7); everyone past the arena size waits
    // for the next match.
    const queue = [...this.students.values()].sort((a, b) => a.joined - b.joined);
    const isBot: boolean[] = new Array<boolean>(size).fill(true);
    for (const s of this.students.values()) s.seat = null;
    queue.slice(0, size).forEach((s, i) => {
      s.seat = i;
      isBot[i] = !s.connected;   // a student who joined but has since dropped
    });
    for (const s of this.students.values()) {
      s.out = false;
      s.revivesUsed = 0;
    }

    this.game.start(size, this.settings.lives, isBot);
    for (const s of this.students.values()) {
      if (s.seat !== null) this.game.setLabel(s.seat, s.name);
    }

    this.deck = this.buildDeck();
    this.finishOrder = [];
    this.pendingRevive = [];
    this.matchEnded = false;
    this.game.drainEvents();
    this.enter('countdown', TIMING.startCountdown, 'GET READY');
    this.pushLobby();
  }

  private endMatch(): void {
    this.quiz.abandon();
    this.pendingRevive = [];
    this.matchEnded = false;
    this.deck = null;
    this.enter('lobby', 0, '');
    this.d.broadcast({ t: 'questionOff' });
    this.pushLobby();
  }

  private buildDeck(): QuestionDeck | null {
    if (!this.settings.questionsEnabled) return null;
    const set = this.sets.find((s) => s.id === this.settings.setId) ?? this.sets[0];
    if (!set) return null;
    const { questions } = parseCsv(set.csv);
    if (questions.length === 0) return null;
    return new QuestionDeck(questions, this.d.rng);
  }

  /** The one place `phase` changes. Keeping it single-entry is what makes the
   *  "does the ball move?" question answerable by reading one line. */
  private enter(phase: Phase, seconds: number, banner: string): void {
    this.phase = phase;
    this.phaseTimer = seconds;
    this.banner = banner;
    this.game.setRunning(phase === 'playing');
  }

  // ------------------------------------------------------------------ tick

  tick(dt: number): void {
    this.clock += dt;

    switch (this.phase) {
      case 'lobby':
      case 'matchover':
        break;

      case 'playing':
        this.game.update(dt);
        this.drainGameEvents();
        break;

      case 'question':
        this.quiz.tick(dt);
        // Human paddles still drift under a freeze, so the sim is ticked to
        // move them; `setRunning(false)` is what holds the ball still.
        this.game.update(dt);
        this.quizPushAcc += dt;
        if (this.quizPushAcc >= 0.25) {
          this.quizPushAcc = 0;
          this.pushQuizTick();
        }
        // Closes when everyone has answered OR the timer expired. The teacher's
        // Close now button is a third door into the same room.
        if (this.quiz.shouldClose()) this.closeQuestion();
        break;

      case 'countdown':
      case 'reveal':
      case 'announce':
      case 'resume':
        this.game.update(dt);
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.advancePhase();
        break;
    }

    this.snapAcc += dt;
    const interval = 1 / TIMING.snapHz;
    if (this.snapAcc >= interval) {
      this.snapAcc %= interval;
      this.d.broadcast({
        t: 'snap',
        c: +this.clock.toFixed(3),
        s: this.game.snapshot({ ph: this.phase, tm: Math.max(0, this.phaseTimer), bn: this.banner }),
      });
    }
  }

  /** What happens when a timed phase runs out. This is SPEC §6.4 in code. */
  private advancePhase(): void {
    switch (this.phase) {
      case 'countdown':
        this.enter('playing', 0, '');
        this.game.serve();
        return;

      case 'reveal':
        // Life changes were applied at close; now say out loud what happened.
        // The reveal is also the last moment any client should be showing a
        // question, so retire it explicitly rather than leaving every client
        // to infer it from the phase. A modal that outlives its question
        // covers the arena for the rest of the round.
        this.d.broadcast({ t: 'questionOff' });
        this.enter('announce', TIMING.announceHold, this.banner);
        return;

      case 'announce':
        if (this.matchEnded) return this.finishMatch();
        // A class question that killed somebody owes them one revive question,
        // and that revive question owes nobody anything (SPEC I3).
        if (this.pendingRevive.length > 0) return this.openReviveQuestion();
        this.enter('resume', TIMING.resumeCountdown, '');
        return;

      case 'resume':
        this.enter('playing', 0, '');
        this.game.serve();
        return;

      default:
        return;
    }
  }

  private drainGameEvents(): void {
    for (const e of this.game.drainEvents()) {
      if (e.t === 'eliminated') {
        const s = this.seatedStudent(e.seat);
        const name = s ? s.name : this.botName(e.seat);
        this.onElimination(e.seat, name);
        return;   // the elimination owns the phase now; ignore later events
      }
      if (e.t === 'matchOver') {
        this.matchEnded = true;
        this.enter('announce', TIMING.announceHold, this.winnerBanner(e.winner));
        return;
      }
    }
  }

  private botName(seat: number): string {
    const p = this.game.players[seat];
    return p ? p.label : `SEAT ${seat + 1}`;
  }

  private winnerBanner(winner: number | null): string {
    if (winner === null) return 'NOBODY LEFT — IT IS A DRAW';
    const s = this.seatedStudent(winner);
    return `${(s ? s.name : this.botName(winner)).toUpperCase()} WINS`;
  }

  // -------------------------------------------------------------- questions

  /**
   * Somebody just lost their last life to a ball. Two routes out, and both of
   * them are on a clock: with questions on we ask the class, and with them off
   * we simply announce it. Neither route can wait on a student indefinitely.
   */
  private onElimination(seat: number, name: string): void {
    const student = this.seatedStudent(seat);
    const question = this.deck?.draw() ?? null;
    // Somebody's status just changed, so the roster is stale as of this
    // instant. Elimination is rare enough that pushing the whole roster here
    // costs nothing, and leaving it stale means a teacher reads "ALIVE" next
    // to a student who is out.

    if (!question) {
      if (student) this.markOut(student);
      this.enter('announce', TIMING.announceHold, `${name.toUpperCase()} IS OUT`);
      this.pushLobby();
      return;
    }

    const eligible: Participant[] = [];

    // The just-eliminated student answers for their life back, but only if
    // they still have a revive left. Spent budget means elimination is
    // permanent and no chance is offered (SPEC §6.3) — this is the rule that
    // guarantees the match ends.
    const canRevive =
      student !== undefined &&
      !student.out &&
      student.revivesUsed < this.settings.revivesPerStudent;
    if (canRevive && student) {
      eligible.push({ pid: student.pid, name: student.name, kind: 'reviving' });
    } else if (student) {
      this.markOut(student);
    }

    // Everyone still alive answers, and a wrong answer costs them a life.
    for (const s of this.students.values()) {
      if (s.seat === null || s.out || s.pid === student?.pid) continue;
      const p = this.game.players[s.seat];
      if (!p?.alive) continue;
      eligible.push({ pid: s.pid, name: s.name, kind: 'atRisk', livesBefore: p.lives });
    }

    if (eligible.length === 0) {
      this.enter('announce', TIMING.announceHold, `${name.toUpperCase()} IS OUT`);
      this.pushLobby();
      return;
    }

    this.pushLobby();
    this.openQuestion('class', question, eligible);
  }

  private openReviveQuestion(): void {
    const question = this.deck?.draw() ?? null;
    const eligible: Participant[] = [];
    for (const pid of this.pendingRevive) {
      const s = this.students.get(pid);
      if (!s || s.out || !s.connected) continue;
      eligible.push({ pid: s.pid, name: s.name, kind: 'reviving' });
    }
    this.pendingRevive = [];

    // Nobody left who can actually take the chance — every candidate
    // disconnected or was already resolved. Do not open an empty question.
    if (!question || eligible.length === 0) {
      this.enter('resume', TIMING.resumeCountdown, '');
      return;
    }
    this.openQuestion('revive', question, eligible);
  }

  private openQuestion(kind: 'class' | 'revive', question: Question, eligible: Participant[]): void {
    this.questionKind = kind;
    this.quiz.open(kind, question, eligible, this.settings.questionTimerSec);
    this.enter('question', this.settings.questionTimerSec, '');
    for (const s of this.students.values()) {
      if (s.connId !== null) this.pushQuestionTo(s.connId, s.pid);
    }
    for (const [id, c] of this.conns) {
      if (c.role === 'teacher') this.pushQuestionTo(id, null);
    }
    this.pushQuizLive();
  }

  private closeQuestion(): void {
    if (!this.quiz.isOpen()) return;
    const outcome = this.quiz.close();
    this.applyOutcome(outcome);

    for (const s of this.students.values()) {
      if (s.connId !== null) this.d.send(s.connId, buildRevealMsg(outcome, s.pid));
    }
    for (const [id, c] of this.conns) {
      if (c.role === 'teacher') this.d.send(id, buildRevealMsg(outcome, ''));
    }

    this.enter('reveal', TIMING.resultHold, this.outcomeBanner(outcome));
  }

  /**
   * Translate the engine's verdicts into game state. The engine deliberately
   * knows nothing about revive budgets or seats, so filtering `triggersRevive`
   * by remaining budget happens HERE and nowhere else.
   */
  private applyOutcome(outcome: Outcome): void {
    for (const e of outcome.entries) {
      const s = this.students.get(e.pid);
      if (!s) continue;
      s.attempted++;
      if (e.correct) s.correct++;

      if (e.kind === 'reviving') {
        if (e.status === 'revived' && s.seat !== null) {
          s.revivesUsed++;
          s.out = false;
          this.game.revive(s.seat, 1);
          if (!s.connected) this.game.setBot(s.seat, true);
        } else {
          this.markOut(s);
        }
        continue;
      }

      // atRisk: a wrong answer costs a life, and that life loss can eliminate.
      if (e.delta < 0 && s.seat !== null) {
        this.game.loseLife(s.seat, -e.delta);
      }
    }

    // Everyone the engine says just hit zero, filtered by whether they can
    // actually still come back. Those who cannot are out immediately rather
    // than being offered a chance that does not exist.
    const owed: string[] = [];
    for (const cand of outcome.triggersRevive) {
      const s = this.students.get(cand.pid);
      if (!s) continue;
      if (s.revivesUsed < this.settings.revivesPerStudent && s.connected) owed.push(s.pid);
      else this.markOut(s);
    }
    this.pendingRevive = owed;

    // A question can end the match outright — the last two players both miss,
    // both hit zero, and nobody is left. Drain so the sim's own verdict wins.
    for (const e of this.game.drainEvents()) {
      if (e.t === 'matchOver') {
        this.matchEnded = true;
        this.pendingRevive = [];
      }
    }
    if (!this.matchEnded && this.game.winner !== null && this.game.over) {
      this.matchEnded = true;
    }
    // Lives and statuses moved; the roster on the teacher's wall is stale
    // until this goes out.
    this.pushLobby();
  }

  private markOut(s: Student): void {
    if (s.out) return;
    s.out = true;
    if (!this.finishOrder.includes(s.pid)) this.finishOrder.push(s.pid);
  }

  private outcomeBanner(outcome: Outcome): string {
    const revived = outcome.entries.filter((e) => e.status === 'revived');
    const gone = outcome.entries.filter((e) => e.status === 'eliminated');
    const hurt = outcome.entries.filter((e) => e.status === 'lostLife');
    const parts: string[] = [];
    for (const e of revived) parts.push(`${e.name.toUpperCase()} IS BACK IN`);
    for (const e of gone) parts.push(`${e.name.toUpperCase()} IS OUT`);
    if (parts.length === 0 && hurt.length > 0) {
      parts.push(hurt.length === 1
        ? `${hurt[0]!.name.toUpperCase()} LOST A LIFE`
        : `${hurt.length} PLAYERS LOST A LIFE`);
    }
    return parts.join(' · ') || 'NOBODY MISSED';
  }

  private finishMatch(): void {
    const winnerSeat = this.game.winner;
    const winner = winnerSeat === null ? undefined : this.seatedStudent(winnerSeat);
    if (winner) {
      winner.matchesWon++;
      if (!this.finishOrder.includes(winner.pid)) this.finishOrder.push(winner.pid);
    }
    this.enter('matchover', 0, this.winnerBanner(winnerSeat));
    this.d.broadcast({ t: 'questionOff' });
    this.pushScoreboard();
    this.pushLobby();
  }

  // ------------------------------------------------------------- outgoing

  private pushLobby(): void {
    this.d.broadcast({
      t: 'lobby',
      phase: this.phase,
      roster: this.roster(),
      settings: this.settings,
      joinUrl: this.joinUrl,
    });
  }

  private roster(): RosterEntry[] {
    const rows: RosterEntry[] = [];
    for (const s of [...this.students.values()].sort((a, b) => a.joined - b.joined)) {
      const p = s.seat === null ? undefined : this.game.players[s.seat];
      const inPlay = this.phase !== 'lobby' && s.seat !== null && p !== undefined;
      rows.push({
        pid: s.pid,
        name: s.name,
        seat: s.seat,
        color: s.seat === null ? null : (COLORS[s.seat] ?? null),
        connected: s.connected,
        human: s.connected && !!p && !p.isBot,
        lives: p?.lives ?? 0,
        status: !inPlay ? 'waiting'
          : p?.alive ? 'alive'
          : s.out ? 'out'
          : 'pending-revive',
        revivesUsed: s.revivesUsed,
        correct: s.correct,
        attempted: s.attempted,
        matchesWon: s.matchesWon,
      });
    }
    return rows;
  }

  private pushQuestionTo(id: ConnId, pid: string | null): void {
    if (!this.quiz.isOpen()) {
      this.d.send(id, { t: 'questionOff' });
      return;
    }
    const msg = this.quiz.toClientMsg(pid ?? '');
    if (msg) this.d.send(id, msg);
  }

  private pushQuizTick(): void {
    const t = this.quiz.tickState();
    if (!t) return;
    this.d.broadcast({ t: 'qtick', qid: t.qid, answered: t.answered, total: t.total, remaining: t.remaining });
  }

  private pushQuizLive(): void {
    const rows = this.quiz.liveRows();
    const qid = this.quiz.currentQid();
    if (!qid) return;
    for (const [id, c] of this.conns) {
      if (c.role === 'teacher') this.d.send(id, { t: 'qlive', qid, rows });
    }
  }

  private pushScoreboard(): void {
    // finishOrder is elimination order, so places run backwards from it.
    const places = new Map<string, number>();
    const total = this.finishOrder.length;
    this.finishOrder.forEach((pid, i) => places.set(pid, total - i));
    const rows = [...this.students.values()]
      .map((s) => ({
        pid: s.pid, name: s.name,
        place: places.get(s.pid) ?? 0,
        correct: s.correct, attempted: s.attempted, matchesWon: s.matchesWon,
      }))
      .sort((a, b) => (a.place || 99) - (b.place || 99));
    this.d.broadcast({ t: 'scoreboard', rows });
  }

  private pushSets(id: ConnId): void {
    this.d.send(id, {
      t: 'sets',
      sets: this.sets.map((s) => ({
        id: s.id,
        name: s.name,
        count: parseCsv(s.csv).questions.length,
      })),
    });
  }

  private broadcastSets(): void {
    for (const [id, c] of this.conns) if (c.role === 'teacher') this.pushSets(id);
  }

  // ------------------------------------------------------------ question sets

  private saveSet(id: string | undefined, name: string, csv: string): void {
    const clean = String(name ?? '').trim().slice(0, 40) || 'Untitled set';
    const existing = id ? this.sets.find((s) => s.id === id) : undefined;
    if (existing) {
      existing.name = clean;
      existing.csv = csv;
    } else {
      this.sets.push({ id: `set-${++this.idCounter}-${this.sets.length + 1}`, name: clean, csv });
    }
    this.savePersistent();
    this.broadcastSets();
    this.pushLobby();
  }

  private deleteSet(id: string): void {
    this.sets = this.sets.filter((s) => s.id !== id);
    if (this.settings.setId === id) this.settings = { ...this.settings, setId: this.sets[0]?.id ?? null };
    this.savePersistent();
    this.broadcastSets();
    this.pushLobby();
  }

  private savePersistent(): void {
    this.d.persist({ sets: this.sets.map((s) => ({ ...s })), settings: this.settings });
  }
}
