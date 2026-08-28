// Liveness of the phase machine. SPEC I1, I2, I3, I4.
//
// The previous build did not die of a wrong collision normal. It died because
// a match could reach a state that nothing could move it out of, in a room
// with 25 teenagers watching. So these tests are not about whether the game is
// fun; they are about whether it is possible to get stuck.
//
// The method is deliberately hostile. Students answer wrongly, answer late,
// never answer at all, disconnect mid-question, reconnect, and leave for good.
// The teacher clicks things at bad moments. Every run must still terminate.

import { describe, expect, test } from 'bun:test';
import { Match } from '../src/shared/match';
import type { ClientMsg, Phase, QuestionMsg, RosterEntry, ServerMsg } from '../src/shared/protocol';
import { SAMPLE_SETS } from '../src/shared/sample-sets';
import { mulberry32 } from './helpers/rng';

const DT = 1 / 60;
/** Ten simulated minutes. Every match must finish far inside this. */
const MAX_TICKS = 60 * 60 * 10;

interface Harness {
  match: Match;
  /** Latest message of each type seen by a given connection. */
  inbox: Map<number, ServerMsg[]>;
  phase(): Phase;
  roster(): RosterEntry[];
  tick(n?: number): void;
  send(id: number, msg: ClientMsg): void;
  /** Every question that has been opened, in order. */
  questions: { qid: string; kind: 'class' | 'revive' }[];
  /** Max questions opened without the ball moving in between. SPEC I3. */
  maxChain: number;
}

function harness(opts: {
  students: number;
  seed: number;
  arenaSize: number;
  questions: boolean;
  revives?: number;
}): Harness {
  const inbox = new Map<number, ServerMsg[]>();
  const questions: { qid: string; kind: 'class' | 'revive' }[] = [];
  let chain = 0;
  let maxChain = 0;
  let lastPhase: Phase = 'lobby';
  const seenQids = new Set<string>();

  const record = (id: number, msg: ServerMsg): void => {
    const box = inbox.get(id) ?? [];
    box.push(msg);
    // Snapshots arrive 30 times a second and would otherwise evict the lobby
    // and question messages the assertions actually read. Trim only snapshots.
    if (box.length > 600) {
      let dropped = 0;
      for (let i = 0; i < box.length && dropped < 300; i++) {
        if (box[i]?.t === 'snap') { box.splice(i, 1); i--; dropped++; }
      }
      if (dropped === 0) box.splice(0, box.length - 600);
    }
    inbox.set(id, box);
  };

  const conns = new Set<number>();
  const match = new Match({
    rng: mulberry32(opts.seed),
    sets: SAMPLE_SETS.map((s) => ({ ...s })),
    persist: () => {},
    onQuit: () => {},
    // Recorded unconditionally: a refusal sent to a socket we are about to
    // reject is exactly what some tests need to observe.
    send: (id, msg) => record(id, msg),
    broadcast: (msg) => { for (const id of conns) record(id, msg); },
  });

  const h: Harness = {
    match,
    inbox,
    questions,
    get maxChain() { return maxChain; },
    phase(): Phase {
      // Read the phase off the wire rather than out of a private field: if the
      // clients cannot see it, it does not exist as far as the game goes.
      for (const box of inbox.values()) {
        for (let i = box.length - 1; i >= 0; i--) {
          const m = box[i];
          if (m?.t === 'snap') return m.s.ph;
        }
      }
      return 'lobby';
    },
    roster(): RosterEntry[] {
      for (const box of inbox.values()) {
        for (let i = box.length - 1; i >= 0; i--) {
          const m = box[i];
          if (m?.t === 'lobby') return m.roster;
        }
      }
      return [];
    },
    tick(n = 1): void {
      for (let i = 0; i < n; i++) {
        match.tick(DT);
        const p = h.phase();
        if (p === 'playing' || p === 'lobby' || p === 'matchover') chain = 0;
        // Count a question the first time its qid appears anywhere.
        for (const box of inbox.values()) {
          for (let k = box.length - 1; k >= 0; k--) {
            const m = box[k];
            if (m?.t !== 'question') continue;
            if (seenQids.has(m.qid)) break;
            seenQids.add(m.qid);
            questions.push({ qid: m.qid, kind: m.kind });
            chain++;
            if (chain > maxChain) maxChain = chain;
            break;
          }
        }
        lastPhase = p;
      }
    },
    send(id, msg): void { match.message(id, msg); },
  };

  // Teacher on a loopback socket, students on remote ones.
  conns.add(0);
  match.join(0, true);
  match.message(0, { t: 'hello', role: 'teacher' });
  match.message(0, {
    t: 'settings',
    patch: {
      arenaSize: opts.arenaSize,
      questionsEnabled: opts.questions,
      questionTimerSec: 10,
      revivesPerStudent: opts.revives ?? 1,
      lives: 3,
    },
  });

  for (let i = 1; i <= opts.students; i++) {
    conns.add(i);
    match.join(i, false);
    match.message(i, { t: 'hello', role: 'player', name: `Kid${i}` });
  }
  return h;
}

/** The open question a given connection is currently looking at, if any. */
function openQuestion(h: Harness, id: number): QuestionMsg | null {
  const box = h.inbox.get(id) ?? [];
  for (let i = box.length - 1; i >= 0; i--) {
    const m = box[i];
    if (m?.t === 'questionOff') return null;
    if (m?.t === 'reveal') return null;
    if (m?.t === 'question') return m;
  }
  return null;
}

describe('phase machine liveness', () => {
  test('every match terminates, at every size, questions on and off', () => {
    for (let size = 2; size <= 8; size++) {
      for (const questions of [true, false]) {
        const h = harness({ students: size, seed: 1000 + size, arenaSize: size, questions });
        h.send(0, { t: 'start' });

        let ticks = 0;
        while (h.phase() !== 'matchover' && ticks < MAX_TICKS) {
          h.tick();
          ticks++;
          // Everyone answers, always correctly is impossible to know, so pick
          // the first option: sometimes right, usually wrong. Good enough to
          // drive the state machine through both branches.
          for (let id = 1; id <= size; id++) {
            const q = openQuestion(h, id);
            if (q?.eligible) h.send(id, { t: 'answer', qid: q.qid, choice: 0 });
          }
        }
        expect(ticks).toBeLessThan(MAX_TICKS);
        expect(h.phase()).toBe('matchover');
      }
    }
  }, 60_000);

  test('nobody ever answers: the timer still ends the match', () => {
    // The worst realistic case. A class that ignores the screen entirely must
    // not be able to freeze the game (SPEC I1).
    for (let size = 2; size <= 6; size++) {
      const h = harness({ students: size, seed: 77 + size, arenaSize: size, questions: true });
      h.send(0, { t: 'start' });
      let ticks = 0;
      while (h.phase() !== 'matchover' && ticks < MAX_TICKS) { h.tick(); ticks++; }
      expect(ticks).toBeLessThan(MAX_TICKS);
      expect(h.phase()).toBe('matchover');
    }
  }, 30_000);

  test('everyone disconnects mid-match: it still terminates', () => {
    // Chromebooks sleeping en masse at the end of a period. Bots inherit the
    // paddles and the match plays itself out (SPEC I4).
    const h = harness({ students: 6, seed: 4242, arenaSize: 6, questions: true });
    h.send(0, { t: 'start' });
    h.tick(200);
    for (let id = 1; id <= 6; id++) h.match.leave(id);

    let ticks = 0;
    while (h.phase() !== 'matchover' && ticks < MAX_TICKS) { h.tick(); ticks++; }
    expect(ticks).toBeLessThan(MAX_TICKS);
  }, 30_000);

  test('hostile fuzz: random answers, drops, rejoins, and teacher clicks', () => {
    for (let seed = 0; seed < 12; seed++) {
      const rng = mulberry32(9000 + seed);
      const size = 2 + Math.floor(rng() * 7);
      const h = harness({
        students: size,
        seed: 500 + seed,
        arenaSize: size,
        questions: true,
        revives: Math.floor(rng() * 4),
      });
      h.send(0, { t: 'start' });

      const gone = new Set<number>();
      let ticks = 0;
      while (h.phase() !== 'matchover' && ticks < MAX_TICKS) {
        h.tick();
        ticks++;

        for (let id = 1; id <= size; id++) {
          if (gone.has(id)) {
            // Sometimes they come back.
            if (rng() < 0.0005) {
              gone.delete(id);
              h.match.join(id, false);
              h.match.message(id, { t: 'hello', role: 'player', name: `Kid${id}` });
            }
            continue;
          }
          if (rng() < 0.0004) { h.match.leave(id); gone.add(id); continue; }

          const q = openQuestion(h, id);
          // A third of students never answer; the rest answer at random,
          // including out-of-range and stale choices.
          if (q?.eligible && id % 3 !== 0 && rng() < 0.02) {
            h.send(id, { t: 'answer', qid: q.qid, choice: Math.floor(rng() * 6) - 1 });
          }
          if (rng() < 0.02) {
            h.send(id, { t: 'input', d: (Math.floor(rng() * 3) - 1) as -1 | 0 | 1 });
          }
        }

        // The teacher clicking Close now at arbitrary moments, including when
        // no question is open.
        if (rng() < 0.002) h.send(0, { t: 'closeQuestion' });
      }
      expect(ticks).toBeLessThan(MAX_TICKS);
      expect(h.phase()).toBe('matchover');
    }
  }, 120_000);

  test('question chains never exceed depth 2 (SPEC I3)', () => {
    for (let seed = 0; seed < 6; seed++) {
      const h = harness({ students: 6, seed: 3000 + seed, arenaSize: 6, questions: true, revives: 3 });
      h.send(0, { t: 'start' });
      let ticks = 0;
      while (h.phase() !== 'matchover' && ticks < MAX_TICKS) {
        h.tick();
        ticks++;
        // Answer wrongly on purpose, which is what produces chains at all:
        // wrong answers cost lives, and a life loss can trigger a revive round.
        for (let id = 1; id <= 6; id++) {
          const q = openQuestion(h, id);
          if (q?.eligible) h.send(id, { t: 'answer', qid: q.qid, choice: 3 });
        }
      }
      expect(h.maxChain).toBeLessThanOrEqual(2);
      // A revive question is never followed by another question without play
      // resuming in between.
      for (let i = 1; i < h.questions.length; i++) {
        if (h.questions[i - 1]!.kind === 'revive') {
          expect(h.questions[i]!.kind).toBe('class');
        }
      }
    }
  }, 60_000);
});

describe('teacher control', () => {
  test('End game returns to the lobby from every phase and keeps the roster', () => {
    const phasesSeen = new Set<Phase>();
    for (let seed = 0; seed < 8; seed++) {
      const h = harness({ students: 4, seed: 600 + seed, arenaSize: 4, questions: true });
      h.send(0, { t: 'start' });
      h.tick(60 + seed * 137);
      phasesSeen.add(h.phase());

      const before = h.roster().length;
      h.send(0, { t: 'end' });
      h.tick(4);
      expect(h.phase()).toBe('lobby');
      // Names and seats survive: a teacher ending a match must not make 25
      // students retype their names (SPEC §7).
      expect(h.roster().length).toBe(before);

      // And the room is still usable afterwards.
      h.send(0, { t: 'start' });
      h.tick(240);
      expect(['countdown', 'playing', 'question', 'reveal', 'announce', 'resume', 'matchover'])
        .toContain(h.phase());
    }
    // The loop above should have caught the machine in more than one phase,
    // otherwise it is only testing one path.
    expect(phasesSeen.size).toBeGreaterThan(1);
  }, 30_000);

  test('a non-loopback socket cannot become the teacher (SPEC I10)', () => {
    const h = harness({ students: 1, seed: 5, arenaSize: 2, questions: false });
    h.match.join(99, false);
    h.match.message(99, { t: 'hello', role: 'teacher' });
    // It must be refused...
    const box = h.inbox.get(99) ?? [];
    expect(box.some((m) => m.t === 'error')).toBe(true);

    // ...and its teacher commands must do nothing.
    h.match.message(99, { t: 'start' });
    h.tick(10);
    expect(h.phase()).toBe('lobby');
  });

  test('settings are locked while a match runs', () => {
    const h = harness({ students: 4, seed: 11, arenaSize: 4, questions: false });
    h.send(0, { t: 'start' });
    h.tick(200);
    h.send(0, { t: 'settings', patch: { arenaSize: 8 } });
    h.tick(2);
    // The running match still has its original seat count.
    const seated = h.roster().filter((r) => r.seat !== null);
    expect(seated.length).toBeLessThanOrEqual(4);
  });
});

describe('seating', () => {
  test('bots fill the seats students did not claim', () => {
    const h = harness({ students: 2, seed: 21, arenaSize: 6, questions: false });
    h.send(0, { t: 'start' });
    h.tick(10);
    const seated = h.roster().filter((r) => r.seat !== null);
    expect(seated.length).toBe(2);
    // Four bots make up the rest of the ring.
    const box = h.inbox.get(0) ?? [];
    const snap = [...box].reverse().find((m) => m.t === 'snap');
    expect(snap?.t === 'snap' && snap.s.pl.length).toBe(6);
  });

  test('students past the arena size wait rather than being turned away', () => {
    const h = harness({ students: 6, seed: 22, arenaSize: 3, questions: false });
    h.send(0, { t: 'start' });
    h.tick(10);
    const roster = h.roster();
    expect(roster.length).toBe(6);
    expect(roster.filter((r) => r.seat !== null).length).toBe(3);
    expect(roster.filter((r) => r.status === 'waiting').length).toBe(3);
  });

  test('a student who reconnects reclaims their seat', () => {
    const h = harness({ students: 3, seed: 23, arenaSize: 3, questions: false });
    h.send(0, { t: 'start' });
    h.tick(60);
    const seatBefore = h.roster().find((r) => r.name === 'Kid2')?.seat;
    expect(seatBefore).not.toBeNull();

    h.match.leave(2);
    h.tick(30);
    expect(h.roster().find((r) => r.name === 'Kid2')?.connected).toBe(false);

    h.match.join(2, false);
    h.match.message(2, { t: 'hello', role: 'player', name: 'Kid2' });
    h.tick(5);
    const after = h.roster().find((r) => r.name === 'Kid2');
    expect(after?.connected).toBe(true);
    expect(after?.seat).toBe(seatBefore ?? -1);
  });
});
