import { Game, STATE } from '../game.js';
import { COLORS } from '../config.js';
import { C, S, PROTOCOL } from './protocol.js';
import { QuizEngine, parseQuestionCsv, questionsToCsv } from '../quiz.js';
import { QUIZ } from '../quiz-config.js';

export const MAX_SEATS = COLORS.length;

// The server-side arena is a fixed virtual space. Every coordinate that leaves
// this room is in arena units, so the virtual size never reaches a client.
const VIRTUAL = 1000;

// How often the live quiz counters go out. Deliberately slower than snapshots.
const QUIZ_PUSH_INTERVAL = 0.25;

/**
 * Authoritative game room. Deliberately free of any runtime API — no http, no
 * ws, no timers, no fs. It is handed `send`/`broadcast` and is driven by an
 * external clock, so the same class runs under Node today and inside a
 * Cloudflare Durable Object later without edits.
 *
 * Question-set persistence follows the same rule: the room never writes a file.
 * It calls the injected `persistSets(sets)` callback and lets the adapter
 * decide whether that means fs.writeFile or storage.put.
 */
export class Room {
  constructor({ send, broadcast, snapHz = 20, meta = {}, sets = [], persistSets = null, rand = Math.random }) {
    this.send = send;
    this.broadcast = broadcast;
    this.meta = meta;   // adapter-supplied, e.g. the join URL for this runtime
    this.snapInterval = 1 / snapHz;
    this.snapAcc = 0;
    this.rand = rand;

    this.conns = new Map();   // connId -> { role, slot, token }
    this.seats = [];          // index = slot
    this.reviveUsed = [];     // slot -> lifetime revives spent; bounds match length
    this.bots = 0;
    this.game = new Game();
    this.game.setViewport(VIRTUAL, VIRTUAL, 1);

    // ------------------------------------------------------------- quiz state
    this.persistSets = typeof persistSets === 'function' ? persistSets : () => {};
    this.quiz = new QuizEngine({ rand });
    this.quiz.loadSets(Array.isArray(sets) ? sets : []);
    this.nextSetNum = this.quiz.sets.reduce(
      (m, s) => Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0), 0) + 1;

    this.quizEnabled = true;
    this.quizPushAcc = 0;
    this.teacherPause = false;
    this.seenVolleys = 0;
    this.seenElims = 0;
    this.lastTargetedRound = {};   // slot -> the round their wall was aimed at
    this.lastResult = null;
  }

  // ------------------------------------------------------------ connections

  join(connId) {
    this.conns.set(connId, { role: null, slot: null, token: null });
  }

  leave(connId) {
    const c = this.conns.get(connId);
    this.conns.delete(connId);
    if (!c || c.slot === null) return;
    const seat = this.seats[c.slot];
    if (!seat) return;
    seat.connected = false;
    seat.connId = null;
    // A dropped student must never stall the match. Hand the paddle to the AI
    // and give it straight back if they reconnect.
    const p = this.game.players[c.slot];
    if (p && !p.wasBot) { p.isBot = true; p.inputDir = 0; }
    // ...and must never stall an open question either. A sleeping Chromebook
    // is dropped from the answer set so "wait for everyone" still terminates.
    this.quiz.dropParticipant(c.slot);
    this.pushLobby();
  }

  message(connId, msg) {
    const c = this.conns.get(connId);
    if (!c || !msg) return;
    if (msg.t === C.HELLO) return this.hello(connId, c, msg);
    if (c.role === 'player') return this.playerMessage(c, msg);
    if (c.role === 'teacher') return this.teacherMessage(connId, msg);
    if (c.role === 'display') return this.displayMessage(msg);
  }

  hello(connId, c, msg) {
    if (msg.role === 'display') c.role = 'display';
    else if (msg.role === 'teacher') c.role = 'teacher';
    else c.role = 'player';

    if (c.role !== 'player') {
      this.send(connId, { t: S.WELCOME, id: connId, role: c.role, slot: null, protocol: PROTOCOL });
      if (c.role === 'teacher') { this.pushSets(connId); this.pushLog(connId); }
      this.pushLobby();
      this.pushQuizTo(connId, c);
      return;
    }

    // Reclaim a seat on reconnect: token first, then name. Chromebooks sleep.
    let seat = this.seats.find((s) => s && msg.token && s.token === msg.token);
    if (!seat && msg.name) {
      seat = this.seats.find((s) => s && !s.connected && s.name === String(msg.name).trim());
    }

    if (!seat) {
      if (this.seats.length >= MAX_SEATS) {
        this.send(connId, { t: S.ERROR, msg: 'This game is full (8 players).' });
        return;
      }
      if (this.game.state !== STATE.MENU) {
        this.send(connId, { t: S.ERROR, msg: 'Game already running — wait for the next round.' });
        return;
      }
      const slot = this.seats.length;
      seat = {
        slot,
        name: (String(msg.name || '').trim() || `Player ${slot + 1}`).slice(0, 14),
        color: COLORS[slot],
        token: `${slot}-${Math.random().toString(36).slice(2, 10)}`,
        connected: false,
        connId: null,
      };
      this.seats.push(seat);
    }

    seat.connected = true;
    seat.connId = connId;
    c.slot = seat.slot;
    c.token = seat.token;

    const p = this.game.players[seat.slot];
    if (p && !p.wasBot) p.isBot = false;   // reclaim from the AI stand-in

    this.send(connId, {
      t: S.WELCOME, id: connId, role: 'player',
      slot: seat.slot, token: seat.token, color: seat.color,
      name: seat.name, protocol: PROTOCOL,
    });
    this.pushLobby();
    this.pushQuizTo(connId, c);
  }

  // -------------------------------------------------------------- messages

  playerMessage(c, msg) {
    if (c.slot === null) return;
    switch (msg.t) {
      case C.INPUT: this.game.setInput(c.slot, msg.d); break;
      case C.AIM:   this.game.aimHazard(c.slot, msg.u, msg.v); break;
      case C.PLACE: this.game.placeHazard(c.slot); break;
      case C.ANSWER: this.onAnswer(c.slot, msg); break;
    }
  }

  displayMessage(msg) {
    switch (msg.t) {
      case C.CONFIG:
        this.bots = Math.max(0, Math.min(MAX_SEATS - this.seats.length, msg.bots | 0));
        this.pushLobby();
        break;
      case C.START: this.startGame(); break;
      case C.PAUSE:
        this.teacherPause = !!msg.on;
        if (!this.quiz.open) this.game.paused = this.teacherPause;
        break;
      case C.RESET: this.resetToLobby(); break;
    }
  }

  /** The teacher console drives everything the projector can, plus the quiz. */
  teacherMessage(connId, msg) {
    switch (msg.t) {
      case C.SET_SAVE:      return this.saveSet(connId, msg);
      case C.SET_DELETE:    return this.deleteSet(connId, msg);
      case C.QUIZ_CFG:      return this.configureQuiz(msg);
      case C.QUIZ_ASK_NOW:  return this.askNow(connId);
      case C.QUIZ_CLOSE:    return this.closeQuestion('teacher');
      case C.QUIZ_EXTEND:   return this.extendFor(msg);
      default:              return this.displayMessage(msg);
    }
  }

  // ------------------------------------------------------------ question sets

  saveSet(connId, msg) {
    const name = String(msg.name || '').trim().slice(0, 60) || 'Untitled set';
    const { questions, errors } = parseQuestionCsv(msg.csv || '');
    if (!questions.length) {
      this.send(connId, {
        t: S.ERROR,
        msg: errors.length ? `Nothing saved: ${errors[0].msg} (line ${errors[0].line})`
                           : 'Nothing saved: no questions found in that CSV.',
      });
      return;
    }
    const existing = msg.id && this.quiz.sets.find((s) => s.id === msg.id);
    if (existing) {
      existing.name = name;
      existing.questions = questions;
      existing.csv = questionsToCsv(questions);
    } else {
      if (this.quiz.sets.length >= QUIZ.maxSets) {
        this.send(connId, { t: S.ERROR, msg: `Set limit reached (${QUIZ.maxSets}). Delete one first.` });
        return;
      }
      const set = {
        id: `set-${this.nextSetNum++}`,
        name,
        questions,
        csv: questionsToCsv(questions),
      };
      this.quiz.sets.push(set);
      if (!this.quiz.activeSetId) this.quiz.setActiveSet(set.id);
    }
    if (this.quiz.activeSetId) this.quiz.reshuffle();
    this.persistSets(this.quiz.sets);
    this.broadcastSets();
    if (errors.length) {
      this.send(connId, { t: S.ERROR, msg: `${errors.length} row(s) skipped — see the preview.` });
    }
  }

  deleteSet(connId, msg) {
    const i = this.quiz.sets.findIndex((s) => s.id === msg.id);
    if (i < 0) return;
    this.quiz.sets.splice(i, 1);
    if (this.quiz.activeSetId === msg.id) {
      this.quiz.setActiveSet(this.quiz.sets.length ? this.quiz.sets[0].id : null);
    }
    this.persistSets(this.quiz.sets);
    this.broadcastSets();
  }

  configureQuiz(msg) {
    if (msg.setId !== undefined) this.quiz.setActiveSet(msg.setId);
    if (msg.timerSec !== undefined) {
      this.quiz.timerSec = Math.max(QUIZ.minTimerSec,
        Math.min(QUIZ.maxTimerSec, Number(msg.timerSec) || QUIZ.defaultTimerSec));
    }
    if (msg.autoAdvance !== undefined) this.quiz.autoAdvance = !!msg.autoAdvance;
    if (msg.projectResults !== undefined) this.quiz.projectResults = !!msg.projectResults;
    if (msg.enabled !== undefined) this.quizEnabled = !!msg.enabled;
    this.broadcastSets();
  }

  extendFor(msg) {
    const slot = msg.slot | 0;
    const sec = msg.sec === undefined ? QUIZ.extensionStepSec : Number(msg.sec) || 0;
    if (sec === 0) this.quiz.clearExtension(slot);
    else this.quiz.extend(slot, sec);
    this.pushQuizCounters(true);
    this.broadcastSets();
  }

  quizConfigPayload() {
    return {
      setId: this.quiz.activeSetId,
      timerSec: this.quiz.timerSec,
      autoAdvance: this.quiz.autoAdvance,
      projectResults: this.quiz.projectResults,
      enabled: this.quizEnabled,
      volleysPerQuestion: QUIZ.volleysPerQuestion,
      targetCooldownRounds: QUIZ.targetCooldownRounds,
      extensions: { ...this.quiz.extensions },
    };
  }

  setsPayload() {
    return {
      t: S.SETS,
      cfg: this.quizConfigPayload(),
      sets: this.quiz.sets.map((s) => ({
        id: s.id,
        name: s.name,
        count: s.questions.length,
        twoOption: s.questions.filter((q) => q.options.length === 2).length,
        csv: s.csv || questionsToCsv(s.questions),
      })),
    };
  }

  pushSets(connId) { this.send(connId, this.setsPayload()); }

  broadcastSets() {
    const payload = this.setsPayload();
    for (const [id, c] of this.conns) if (c.role === 'teacher') this.send(id, payload);
  }

  pushLog(connId) {
    this.send(connId, {
      t: S.QUIZ_LOG,
      entries: this.quiz.history.slice(-25),
      topics: this.quiz.topicReport(),
      targets: { ...this.lastTargetedRound },
      round: this.game.round,
    });
  }

  broadcastLog() {
    for (const [id, c] of this.conns) if (c.role === 'teacher') this.pushLog(id);
  }

  // ----------------------------------------------------------------- rounds

  startGame() {
    const humans = this.seats.length;
    const total = Math.min(MAX_SEATS, humans + this.bots);
    if (total < 2) {
      this.broadcast({ t: S.ERROR, msg: 'Need at least 2 players. Add a bot or wait for a join.' });
      return;
    }
    this.reviveUsed = new Array(MAX_SEATS).fill(0);
    this.game.start(total, total - humans);
    this.seats.forEach((seat) => {
      const p = this.game.players[seat.slot];
      if (!p) return;
      p.name = seat.name;
      p.wasBot = false;
      p.isBot = !seat.connected;   // absent students play as bots until they join
    });
    for (let i = humans; i < total; i++) if (this.game.players[i]) this.game.players[i].wasBot = true;
    this.seenVolleys = 0;
    this.seenElims = 0;
    this.lastTargetedRound = {};
    this.pushLobby();
  }

  resetToLobby() {
    if (this.quiz.open) this.closeQuestion('reset');
    this.game = new Game();
    this.game.setViewport(VIRTUAL, VIRTUAL, 1);
    this.seenVolleys = 0;
    this.seenElims = 0;
    this.lastTargetedRound = {};
    this.teacherPause = false;
    this.pushLobby();
  }

  pushLobby() {
    this.broadcast({
      t: S.LOBBY,
      meta: this.meta,
      state: this.game.state,
      bots: this.bots,
      max: MAX_SEATS,
      seats: this.seats.map((s) => ({
        slot: s.slot, name: s.name, color: s.color, connected: s.connected,
      })),
    });
  }

  // ------------------------------------------------------------------- quiz

  /**
   * Everyone who should get the question: every connected student, eliminated
   * ones included. Being out of the arena is precisely when a student needs a
   * question — it is their way back in — so they are never filtered here.
   */
  participants() {
    return this.seats
      .filter((s) => s.connected)
      .map((s) => ({ slot: s.slot, name: s.name }));
  }

  askNow(connId) {
    const q = this.fireQuestion('teacher');
    if (!q && connId !== undefined) {
      this.send(connId, {
        t: S.ERROR,
        msg: this.quiz.open ? 'A question is already open.'
          : !this.quiz.ready ? 'Pick a question set with at least one question first.'
          : 'No connected students to ask.',
      });
    }
  }

  fireQuestion(reason) {
    if (!this.quizEnabled) return null;
    if (this.quiz.open || !this.quiz.ready) return null;
    const people = this.participants();
    if (!people.length) return null;
    const q = this.quiz.ask(people, reason);
    if (!q) return null;

    // Freeze the arena while the class thinks. Nothing auto-advances past a
    // student who is still working unless the teacher turned that on.
    if (this.game.state !== STATE.MENU && this.game.state !== STATE.GAMEOVER) {
      this.game.paused = true;
    }
    const payload = { t: S.QUIZ_ASK, ...this.quiz.askPayload() };
    this.broadcast(payload);
    this.pushQuizCounters(true);
    return q;
  }

  onAnswer(slot, msg) {
    if (!this.quiz.open) return;
    const res = this.quiz.answer(slot, msg.qid | 0, msg.c);
    if (!res) return;
    this.pushQuizCounters(true);
    if (this.quiz.everyoneAnswered) this.closeQuestion('all-answered');
  }

  closeQuestion(why) {
    if (!this.quiz.open) return;
    const result = this.quiz.close();
    this.lastResult = { ...result, why };
    this.game.paused = this.teacherPause;

    // A correct answer from an eliminated student buys them back into the
    // arena. This is the whole reason they answer at all.
    const revived = [];
    if (QUIZ.reviveOnCorrect && this.game.alivePlayers.length >= QUIZ.reviveMinAlive) {
      const eligible = result.right
        .filter((slot) => {
          const p = this.game.players[slot];
          return p && !p.alive && (this.reviveUsed[slot] || 0) < QUIZ.reviveMaxPerStudent;
        })
        // Students who have been back the fewest times go first, so one strong
        // answerer cannot monopolise the way back in.
        .sort((a, b) => (this.reviveUsed[a] || 0) - (this.reviveUsed[b] || 0));

      for (const slot of eligible.slice(0, QUIZ.reviveMaxPerQuestion)) {
        if (this.game.revive(slot, QUIZ.reviveLives)) {
          this.reviveUsed[slot] = (this.reviveUsed[slot] || 0) + 1;
          revived.push(slot);
        }
      }
    }

    const targeted = this.pickTarget(result.wrong);

    for (const [id, c] of this.conns) {
      const base = {
        t: S.QUIZ_END, qid: result.qid, correct: result.correct,
        options: result.options, topic: result.topic, why,
      };
      if (c.role === 'player' && c.slot !== null) {
        const row = result.rows.find((r) => r.slot === c.slot);
        this.send(id, {
          ...base,
          yours: row ? row.choice : null,
          youWere: row ? (row.choice === null ? 'missed' : row.correct ? 'right' : 'wrong') : null,
          revived: revived.includes(c.slot),
          targeted: targeted === c.slot,
        });
      } else if (c.role === 'teacher') {
        this.send(id, { ...base, rows: result.rows, targeted });
      } else {
        // Projector: the answer key, and per-student results only if the
        // teacher has explicitly opted in to showing them to the class.
        this.send(id, this.quiz.projectResults ? { ...base, rows: result.rows } : base);
      }
    }
    this.broadcastLog();
    this.pushLobby();
  }

  /**
   * GUARDRAIL. Everyone who missed is a candidate, one is drawn at random, and
   * a student who has already been aimed at inside the cooldown window is not a
   * candidate at all. The point is that the student who is struggling hardest
   * does not get the ball fired at them every single volley in front of the
   * class. Returns the chosen slot, or null when nobody may be targeted.
   */
  pickTarget(wrongSlots) {
    if (!wrongSlots.length) return null;
    if (this.game.state === STATE.MENU || this.game.state === STATE.GAMEOVER) return null;
    if (this.rand() > QUIZ.targetProbability) return null;

    const serveRound = this.game.round + 1;   // the serve this would apply to
    const eligible = wrongSlots.filter((slot) => {
      const p = this.game.players[slot];
      if (!p || !p.alive) return false;                 // no wall to aim at
      if (p.isBot) return false;                        // bots do not answer
      const last = this.lastTargetedRound[slot];
      if (last === undefined) return true;
      return serveRound - last >= QUIZ.targetCooldownRounds;
    });
    if (!eligible.length) return null;

    const slot = eligible[Math.floor(this.rand() * eligible.length) % eligible.length];
    if (!this.game.setServeTarget(slot)) return null;
    this.lastTargetedRound[slot] = serveRound;
    return slot;
  }

  /** Cadence watchdog. Runs after the sim so the counters it reads are fresh. */
  detectTriggers() {
    const g = this.game;
    if (this.quiz.open || !this.quizEnabled) return;
    if (g.state === STATE.MENU || g.state === STATE.GAMEOVER) return;

    if (g.eliminations > this.seenElims) {
      this.seenElims = g.eliminations;
      if (QUIZ.askOnElimination && this.fireQuestion('elimination')) return;
    }
    if (g.volleys > this.seenVolleys) {
      this.seenVolleys = g.volleys;
      if (g.volleys % QUIZ.volleysPerQuestion === 0) this.fireQuestion('volley');
    }
  }

  /** Per-connection quiz counters. Students see only their own clock. */
  pushQuizCounters(force = false) {
    if (!this.quiz.open) return;
    const c = this.quiz.current;
    const { answered, total } = this.quiz.answeredCount();
    const rows = this.quiz.liveRows();
    for (const [id, conn] of this.conns) {
      if (conn.role === 'player' && conn.slot !== null) {
        this.send(id, {
          t: S.QUIZ_TICK, qid: c.qid, answered, total,
          overtime: c.overtime,
          remaining: Math.max(0, Math.round(this.quiz.remainingFor(conn.slot))),
          locked: !!(c.seats.get(conn.slot) && c.seats.get(conn.slot).choice !== null),
        });
      } else if (conn.role === 'teacher') {
        this.send(id, { t: S.QUIZ_TICK, qid: c.qid, answered, total, overtime: c.overtime });
        this.send(id, { t: S.QUIZ_LIVE, qid: c.qid, rows });
      } else {
        // Projector gets the count only. Who is right stays off the wall.
        this.send(id, { t: S.QUIZ_TICK, qid: c.qid, answered, total, overtime: c.overtime });
      }
    }
    if (force) this.quizPushAcc = 0;
  }

  /** Bring one freshly-joined connection in sync with any open question. */
  pushQuizTo(connId, c) {
    if (!this.quiz.open) { this.send(connId, { t: S.QUIZ_OFF }); return; }
    this.send(connId, { t: S.QUIZ_ASK, ...this.quiz.askPayload() });
    const { answered, total } = this.quiz.answeredCount();
    const cur = this.quiz.current;
    const seat = c.slot !== null ? cur.seats.get(c.slot) : null;
    this.send(connId, {
      t: S.QUIZ_TICK, qid: cur.qid, answered, total, overtime: cur.overtime,
      remaining: c.slot !== null ? Math.max(0, Math.round(this.quiz.remainingFor(c.slot))) : 0,
      locked: !!(seat && seat.choice !== null),
    });
  }

  // ------------------------------------------------------------------ clock

  /** Driven by the adapter: setInterval under Node, alarms under a Durable Object. */
  tick(dt) {
    if (this.quiz.open) {
      if (this.quiz.tick(dt) === 'done') this.closeQuestion('timer');
    }

    this.game.update(dt);
    this.detectTriggers();

    if (this.quiz.open) {
      this.quizPushAcc += dt;
      if (this.quizPushAcc >= QUIZ_PUSH_INTERVAL) { this.quizPushAcc = 0; this.pushQuizCounters(); }
    }

    this.snapAcc += dt;
    if (this.snapAcc >= this.snapInterval) {
      this.snapAcc = 0;
      this.broadcast({ t: S.SNAP, s: this.game.snapshot() });
    }
  }
}
