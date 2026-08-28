import { describe, test, expect } from 'bun:test';
import {
  parseCsv,
  questionsToCsv,
  blankCsvTemplate,
  QuestionDeck,
  QuestionEngine,
  buildRevealMsg,
  type Question,
  type Participant,
  type ParticipantKind,
  type QuestionKind,
  type OutcomeStatus,
} from '../src/shared/quiz';
import { mulberry32 as seededRng } from './helpers/rng';

const Q: Question = { text: 'What is 2+2?', options: ['3', '4', '5', '6'], correct: 1 };

function atRisk(pid: string, livesBefore: number): Participant {
  return { pid, name: pid, kind: 'atRisk', livesBefore };
}
function reviving(pid: string): Participant {
  return { pid, name: pid, kind: 'reviving' };
}

// ------------------------------------------------------------------- CSV

describe('CSV import', () => {
  test('quoted field with an embedded comma', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\n"What is 2, plus 2?",Three,Four,Five,Six,B';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toBe('What is 2, plus 2?');
    expect(questions[0]?.options).toEqual(['Three', 'Four', 'Five', 'Six']);
    expect(questions[0]?.correct).toBe(1);
  });

  test('doubled double-quote is an escaped literal quote', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\n"She said ""hello""",A,B,,,A';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions[0]?.text).toBe('She said "hello"');
  });

  test('CRLF line endings', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\r\nQ1,A,B,C,D,A\r\nQ2,A,B,,,B\r\n';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(2);
    expect(questions[1]?.options).toHaveLength(2);
  });

  test('leading UTF-8 BOM is stripped', () => {
    const csv = '﻿question,optionA,optionB,optionC,optionD,correct\nQ1,A,B,,,A';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toBe('Q1');
  });

  test('missing header row: first row is treated as data', () => {
    const csv = 'Is the sky blue?,True,False,,,A';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toBe('Is the sky blue?');
  });

  test('present header row is skipped, not treated as a malformed question', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\nQ1,A,B,,,A';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(1);
  });

  test('trailing blank lines produce neither questions nor issues', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\nQ1,A,B,,,A\n\n\n   \n';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions).toHaveLength(1);
  });

  test('a two-option row parses to exactly two options', () => {
    const csv = 'question,optionA,optionB,optionC,optionD,correct\nTrue or false: water boils at 100C.,True,False,,,A';
    const { questions, issues } = parseCsv(csv);
    expect(issues).toEqual([]);
    expect(questions[0]?.options).toEqual(['True', 'False']);
    expect(questions[0]?.correct).toBe(0);
  });

  test('several malformed rows are each reported by line number with a useful message, and skipped', () => {
    const csv = [
      'question,optionA,optionB,optionC,optionD,correct',
      ',A,B,,,A', // line 2: empty question text
      'Q,OnlyA,,,,A', // line 3: option B empty
      'Q,A,B,C,D,E', // line 4: correct letter not A-D
      'Q,A,B,C,,B', // line 5: C filled, D blank (asymmetric)
      'Q,A,B,,,C', // line 6: correct is C, but this is a two-option row
      'Good question,Yes,No,,,A', // line 7: valid, should still parse
    ].join('\n');

    const { questions, issues } = parseCsv(csv);

    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toBe('Good question');

    expect(issues).toHaveLength(5);
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6]);
    for (const issue of issues) {
      expect(issue.message.length).toBeGreaterThan(0);
    }
    expect(issues[0]?.message).toMatch(/question column is empty/);
    expect(issues[1]?.message).toMatch(/option B is empty/);
    expect(issues[2]?.message).toMatch(/'E' is not one of the options/);
    expect(issues[3]?.message).toMatch(/option C is filled in but option D is blank/);
    expect(issues[4]?.message).toMatch(/only has 2 options/);
  });

  test('never throws on garbage input', () => {
    expect(() => parseCsv('')).not.toThrow();
    expect(() => parseCsv('"""""""')).not.toThrow();
    expect(() => parseCsv('﻿')).not.toThrow();
  });
});

describe('CSV round-trip', () => {
  test('parse -> serialise -> parse yields the same questions', () => {
    const original: Question[] = [
      { text: 'A question, with a comma', options: ['Yes', 'No'], correct: 1 },
      { text: 'A question with a "quote"', options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correct: 2 },
      { text: 'Plain question', options: ['A', 'B', 'C', 'D'], correct: 0 },
    ];

    const csv = questionsToCsv(original);
    const { questions, issues } = parseCsv(csv);

    expect(issues).toEqual([]);
    expect(questions).toEqual(original);
  });

  test('blank template round-trips to zero questions and zero issues', () => {
    const { questions, issues } = parseCsv(blankCsvTemplate());
    expect(questions).toEqual([]);
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------- engine: §6.2 table
// This table IS the spec (SPEC §6.2). Every participant kind the engine
// knows about, crossed with every way a question can resolve for them.
//
// The chain terminates at depth 2 because 'atRisk' participants only ever
// exist in a class question (an alive player put at risk); a revive
// question's eligible list is only ever 'reviving' participants (players
// already at zero, being offered one shot back). Once nobody living is at
// risk, nothing can drop to zero, so nothing can trigger a third question.

describe('SPEC §6.2 — participant kind x outcome table', () => {
  interface Case {
    label: string;
    kind: ParticipantKind;
    questionKind: QuestionKind;
    action: 'correct' | 'wrong' | 'timeout';
    delta: number;
    status: OutcomeStatus;
    correct: boolean | null;
  }

  const cases: Case[] = [
    // Alive player (atRisk), in a class question.
    { label: 'atRisk + correct -> nothing happens', kind: 'atRisk', questionKind: 'class', action: 'correct', delta: 0, status: 'unaffected', correct: true },
    { label: 'atRisk + wrong -> -1 life', kind: 'atRisk', questionKind: 'class', action: 'wrong', delta: -1, status: 'lostLife', correct: false },
    { label: 'atRisk + no answer -> counts as wrong, -1 life', kind: 'atRisk', questionKind: 'class', action: 'timeout', delta: -1, status: 'lostLife', correct: null },

    // The just-eliminated player with a revive chance (reviving), in a class question.
    { label: 'reviving (class) + correct -> revived with 1 life', kind: 'reviving', questionKind: 'class', action: 'correct', delta: 1, status: 'revived', correct: true },
    { label: 'reviving (class) + wrong -> permanently out', kind: 'reviving', questionKind: 'class', action: 'wrong', delta: 0, status: 'eliminated', correct: false },
    { label: 'reviving (class) + no answer -> permanently out', kind: 'reviving', questionKind: 'class', action: 'timeout', delta: 0, status: 'eliminated', correct: null },

    // The same 'reviving' kind, but in an actual revive question.
    { label: 'reviving (revive) + correct -> survives with 1 life', kind: 'reviving', questionKind: 'revive', action: 'correct', delta: 1, status: 'revived', correct: true },
    { label: 'reviving (revive) + wrong -> permanently out', kind: 'reviving', questionKind: 'revive', action: 'wrong', delta: 0, status: 'eliminated', correct: false },
    { label: 'reviving (revive) + no answer -> permanently out', kind: 'reviving', questionKind: 'revive', action: 'timeout', delta: 0, status: 'eliminated', correct: null },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const engine = new QuestionEngine();
      const participant: Participant = c.kind === 'atRisk' ? atRisk('p1', 2) : reviving('p1');
      const qid = engine.open(c.questionKind, Q, [participant], 30);

      if (c.action === 'correct') engine.answer('p1', qid, Q.correct);
      else if (c.action === 'wrong') engine.answer('p1', qid, (Q.correct + 1) % Q.options.length);
      else engine.tick(999); // timeout: never answer

      expect(engine.shouldClose()).toBe(true);
      const outcome = engine.close();
      expect(outcome.entries).toHaveLength(1);
      const entry = outcome.entries[0]!;
      expect(entry.correct).toBe(c.correct);
      expect(entry.delta).toBe(c.delta);
      expect(entry.status).toBe(c.status);
    });
  }

  test('permanently-out and spectator participants are simply never in the eligible list', () => {
    // The engine only ever knows about participants it was given. A caller
    // that correctly excludes out/spectator players from `eligible` means
    // the engine grades nobody on their behalf and they never block close.
    const engine = new QuestionEngine();
    const qid = engine.open('class', Q, [atRisk('alive1', 3)], 30);
    engine.answer('spectator1', qid, 0); // ignored: not eligible
    engine.answer('alive1', qid, Q.correct);
    expect(engine.shouldClose()).toBe(true);
    const outcome = engine.close();
    expect(outcome.entries).toHaveLength(1);
    expect(outcome.entries[0]?.pid).toBe('alive1');
  });
});

// -------------------------------------------------------------- chain bound

describe('SPEC I3 — chain bounded at depth 2', () => {
  test('a class question that drops three alive players to zero produces exactly one revive question', () => {
    const engine = new QuestionEngine();
    const players = [atRisk('a', 1), atRisk('b', 1), atRisk('c', 1), atRisk('d', 3)];
    const qid = engine.open('class', Q, players, 30);

    const wrong = (Q.correct + 1) % Q.options.length;
    engine.answer('a', qid, wrong);
    engine.answer('b', qid, wrong);
    engine.answer('c', qid, wrong);
    engine.answer('d', qid, Q.correct); // stays alive, not owed a revive

    const outcome = engine.close();
    expect(outcome.triggersRevive.map((r) => r.pid).sort()).toEqual(['a', 'b', 'c']);
  });

  test('closing the resulting revive question always produces triggersRevive: [], no matter the answers', () => {
    for (const answers of [
      ['correct', 'correct', 'correct'],
      ['wrong', 'wrong', 'wrong'],
      ['timeout', 'timeout', 'timeout'],
      ['correct', 'wrong', 'timeout'],
    ] as const) {
      const engine = new QuestionEngine();
      const candidates = [reviving('a'), reviving('b'), reviving('c')];
      const qid = engine.open('revive', Q, candidates, 30);

      const wrong = (Q.correct + 1) % Q.options.length;
      const pids = ['a', 'b', 'c'];
      answers.forEach((action, i) => {
        const pid = pids[i]!;
        if (action === 'correct') engine.answer(pid, qid, Q.correct);
        else if (action === 'wrong') engine.answer(pid, qid, wrong);
        // 'timeout': no call to answer()
      });
      engine.tick(999);
      expect(engine.shouldClose()).toBe(true);
      const outcome = engine.close();
      expect(outcome.triggersRevive).toEqual([]);
    }
  });

  test('structural guard: even a mis-opened revive question with an atRisk participant cannot trigger a third question', () => {
    // A well-behaved caller never does this — a revive question's eligible
    // list should only ever contain 'reviving' participants. This test
    // proves the engine does not merely rely on callers behaving: closing
    // a `kind: 'revive'` question ALWAYS returns an empty triggersRevive,
    // regardless of what participants were passed to open().
    const engine = new QuestionEngine();
    const qid = engine.open('revive', Q, [atRisk('rogue', 1)], 30);
    engine.answer('rogue', qid, (Q.correct + 1) % Q.options.length); // wrong, would hit zero
    const outcome = engine.close();
    expect(outcome.triggersRevive).toEqual([]);
  });
});

// ----------------------------------------------------------------- liveness

describe('SPEC I1 / I4 — liveness', () => {
  test('a question where nobody answers still closes once the timer expires', () => {
    const engine = new QuestionEngine();
    engine.open('class', Q, [atRisk('a', 2), atRisk('b', 2)], 10);
    expect(engine.shouldClose()).toBe(false);
    engine.tick(5);
    expect(engine.shouldClose()).toBe(false);
    engine.tick(5.01);
    expect(engine.shouldClose()).toBe(true);
    const outcome = engine.close();
    expect(outcome.entries.every((e) => e.correct === null)).toBe(true);
  });

  test('a question where every eligible participant disconnects closes immediately, not on the timer', () => {
    const engine = new QuestionEngine();
    engine.open('class', Q, [atRisk('a', 2), atRisk('b', 2)], 120);
    expect(engine.shouldClose()).toBe(false);
    engine.dropParticipant('a');
    expect(engine.shouldClose()).toBe(false);
    engine.dropParticipant('b');
    expect(engine.shouldClose()).toBe(true); // no tick() needed at all
  });

  test('dropping a participant who already answered is a no-op', () => {
    const engine = new QuestionEngine();
    const qid = engine.open('class', Q, [atRisk('a', 2)], 30);
    engine.answer('a', qid, Q.correct);
    engine.dropParticipant('a');
    const outcome = engine.close();
    expect(outcome.entries[0]?.correct).toBe(true);
  });

  test('answer() ignores a stale qid, a second answer, and an out-of-range choice', () => {
    const engine = new QuestionEngine();
    const qid = engine.open('class', Q, [atRisk('a', 2)], 30);
    engine.answer('a', 'not-the-real-qid', Q.correct);
    engine.answer('a', qid, 99); // out of range, ignored
    engine.answer('a', qid, 0);
    engine.answer('a', qid, Q.correct); // second answer, ignored — first stands
    const outcome = engine.close();
    expect(outcome.entries[0]?.choice).toBe(0);
  });
});

// -------------------------------------------------------------- leak test

describe('SPEC I11 — the answer key never reaches a client while the question is open', () => {
  function walksForKey(value: unknown, key: string): boolean {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((v) => walksForKey(v, key));
    for (const [k, v] of Object.entries(value)) {
      if (k === key) return true;
      if (walksForKey(v, key)) return true;
    }
    return false;
  }

  test('toClientMsg contains no "correct" field at any depth, for eligible or watching recipients', () => {
    const engine = new QuestionEngine();
    engine.open('class', Q, [atRisk('a', 2), atRisk('b', 2)], 30);

    for (const pid of ['a', 'b', 'someone-not-even-in-the-match']) {
      const msg = engine.toClientMsg(pid);
      expect(msg).not.toBeNull();
      const roundTripped: unknown = JSON.parse(JSON.stringify(msg));
      expect(walksForKey(roundTripped, 'correct')).toBe(false);
    }
  });

  test('toClientMsg returns null when no question is open', () => {
    const engine = new QuestionEngine();
    expect(engine.toClientMsg('anyone')).toBeNull();
  });

  test('an ineligible recipient sees eligible: false and the names they are waiting on', () => {
    const engine = new QuestionEngine();
    engine.open('class', Q, [atRisk('a', 2), atRisk('b', 2)], 30);
    const watcherMsg = engine.toClientMsg('spectator');
    expect(watcherMsg?.eligible).toBe(false);
    expect(watcherMsg?.waitingOn.sort()).toEqual(['a', 'b']);

    const eligibleMsg = engine.toClientMsg('a');
    expect(eligibleMsg?.eligible).toBe(true);
    expect(eligibleMsg?.waitingOn).toEqual([]);
  });

  test('buildRevealMsg legitimately carries the correct answer after close (I11 only applies while open)', () => {
    const engine = new QuestionEngine();
    const qid = engine.open('class', Q, [atRisk('a', 2)], 30);
    engine.answer('a', qid, Q.correct);
    const outcome = engine.close();
    const reveal = buildRevealMsg(outcome, 'a');
    expect(reveal.correct).toBe(Q.correct);
    expect(reveal.yourChoice).toBe(Q.correct);
    expect(reveal.yourDelta).toBe(0);
  });
});

// -------------------------------------------------------------- selection

describe('question selection', () => {
  const pool: Question[] = Array.from({ length: 5 }, (_, i) => ({
    text: `Question ${i}`,
    options: ['A', 'B'],
    correct: 0,
  }));

  test('draws every question once before any repeat', () => {
    const deck = new QuestionDeck(pool, seededRng(1));
    const drawn = Array.from({ length: 5 }, () => deck.draw());
    const texts = new Set(drawn.map((q) => q.text));
    expect(texts.size).toBe(5);
  });

  test('reshuffles and continues after the set is exhausted — over two full passes every question appears exactly twice', () => {
    const deck = new QuestionDeck(pool, seededRng(2));
    const counts = new Map<string, number>();
    for (let i = 0; i < 10; i++) {
      const q = deck.draw();
      counts.set(q.text, (counts.get(q.text) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2]);
  });

  test('deterministic under a seeded Rng: same seed, same sequence', () => {
    const deckA = new QuestionDeck(pool, seededRng(42));
    const deckB = new QuestionDeck(pool, seededRng(42));
    const seqA = Array.from({ length: 12 }, () => deckA.draw().text);
    const seqB = Array.from({ length: 12 }, () => deckB.draw().text);
    expect(seqA).toEqual(seqB);
  });

  test('different seeds are very likely to produce a different order', () => {
    const deckA = new QuestionDeck(pool, seededRng(1));
    const deckB = new QuestionDeck(pool, seededRng(999));
    const seqA = Array.from({ length: 5 }, () => deckA.draw().text);
    const seqB = Array.from({ length: 5 }, () => deckB.draw().text);
    expect(seqA).not.toEqual(seqB);
  });
});
