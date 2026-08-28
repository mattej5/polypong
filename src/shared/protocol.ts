// The wire. Shared verbatim by the server and every client.
//
// Rules for changing this file:
//   1. Both ends must agree, so a change here is a change everywhere.
//   2. Additive only within a protocol version. Bump PROTOCOL if you break it.
//   3. Nothing here imports anything with a runtime API (SPEC I12).
//   4. An answer key never appears in a message a student can receive while
//      the question is open (SPEC I11). See `QuestionMsg` vs `RevealMsg`.

import type { MatchSettings } from './config';

export const PROTOCOL = 1;

/** The only phase in which the ball moves is `playing`. SPEC §10.3. */
export type Phase =
  | 'lobby'
  | 'countdown'   // pre-serve 3-2-1 at the start of a match
  | 'playing'
  | 'question'    // frozen, a question is on screen
  | 'reveal'      // frozen, showing the correct answer
  | 'announce'    // frozen, "RILEY IS OUT"
  | 'resume'      // frozen, 3-2-1 before play restarts
  | 'matchover';

export type Role = 'teacher' | 'player';

/** What a student is doing right now. SPEC §7 roster. */
export type PlayerStatus =
  /** joined but not seated: spectator, or arrived after Start */
  | 'waiting'
  /** seated and in play */
  | 'alive'
  /** at zero lives, still holds a revive chance in the current question */
  | 'pending-revive'
  /** eliminated with no way back this match */
  | 'out';

/** One row of the teacher's roster, and of the students' lobby list. */
export interface RosterEntry {
  /** Stable identity for the whole session. Survives reconnects and reseats. */
  pid: string;
  name: string;
  /** Seat index 0..7, or null when not in play. */
  seat: number | null;
  color: string | null;
  connected: boolean;
  /** False while a bot stands in for a dropped student. */
  human: boolean;
  lives: number;
  status: PlayerStatus;
  revivesUsed: number;
  /** Session totals, not per match. */
  correct: number;
  attempted: number;
  matchesWon: number;
}

// ------------------------------------------------------------------ snapshot
// Broadcast at TIMING.snapHz. Arena units throughout. Field names are short
// because this goes out 30 times a second; the comments carry the meaning.

export interface SnapPlayer {
  /** Seat index. */
  i: number;
  /** Lives remaining. */
  l: number;
  /** Alive in the arena. */
  a: 0 | 1;
  /** Currently driven by AI (a bot seat, or a dropped student). */
  b: 0 | 1;
  /** Display name. */
  n: string;
  /** Paddle centre as a fraction 0..1 along its own edge, from edge.a to edge.b. */
  s: number;
}

export interface SnapBall {
  /** Stable identity. NOT the array index — a split or a goal reorders these,
   *  and interpolating by index sends one ball skating across the arena. */
  i: number;
  p: [number, number];
  v: [number, number];
  /** Hot: passed through a sun, costs 2 lives. */
  h: 0 | 1;
}

export interface SnapHazard {
  k: 'blackhole' | 'sun';
  p: [number, number];
  /** Seat whose elimination spawned it, for colouring. */
  o: number;
}

export interface Snapshot {
  ph: Phase;
  /** Seconds remaining on the current phase timer. */
  tm: number;
  /** Round number. Increments on every serve; two snapshots with different
   *  rounds are never blended, because the ball teleports to the centre. */
  rd: number;
  /** Banner text, already in plain classroom English. */
  bn: string;
  pl: SnapPlayer[];
  bl: SnapBall[];
  hz: SnapHazard[];
  /** Splitter position, or null. */
  sp: [number, number] | null;
  /** Winning seat once ph === 'matchover', null on a draw. */
  wn: number | null;
}

// --------------------------------------------------------- client -> server

export type ClientMsg =
  | { t: 'hello'; role: Role; name?: string; token?: string }
  /** Paddle direction in the SENDER'S OWN SCREEN FRAME. The server converts
   *  via Edge.rightSign; the client never does. SPEC §5.3. */
  | { t: 'input'; d: -1 | 0 | 1 }
  | { t: 'answer'; qid: string; choice: number }
  // ---- teacher only. Every one of these is refused on a non-loopback socket.
  | { t: 'settings'; patch: Partial<MatchSettings> }
  | { t: 'start' }
  | { t: 'end' }
  | { t: 'rematch' }
  | { t: 'closeQuestion' }
  | { t: 'quit' }
  | { t: 'removePlayer'; pid: string }
  | { t: 'renamePlayer'; pid: string; name: string }
  | { t: 'saveSet'; id?: string; name: string; csv: string }
  | { t: 'deleteSet'; id: string };

// --------------------------------------------------------- server -> client

export interface QuestionSetSummary {
  id: string;
  name: string;
  count: number;
}

/**
 * A question, as a student sees it. There is deliberately no field for the
 * correct answer: this type is what SPEC I11 is tested against.
 */
export interface QuestionMsg {
  t: 'question';
  qid: string;
  /** 'class' = everyone alive plus the newly eliminated. 'revive' = only the
   *  players who just hit zero; everyone else watches. SPEC §6.2. */
  kind: 'class' | 'revive';
  text: string;
  options: string[];
  /** Seconds allowed. */
  timer: number;
  /** False for anyone who must watch rather than answer. */
  eligible: boolean;
  /** Names of the players being waited on, for the watchers' modal. */
  waitingOn: string[];
}

/** Sent once a question has closed. Only now does the key go out. */
export interface RevealMsg {
  t: 'reveal';
  qid: string;
  correct: number;
  /** What this recipient chose, or null if they did not answer / were watching. */
  yourChoice: number | null;
  /** Life delta applied to this recipient by this question. */
  yourDelta: number;
  /** Per-player outcomes, for the teacher panel and the arena view. */
  outcomes: { pid: string; name: string; choice: number | null; delta: number }[];
}

export type ServerMsg =
  | {
      t: 'welcome';
      role: Role;
      protocol: number;
      pid: string | null;
      token: string | null;
      name: string | null;
      seat: number | null;
      color: string | null;
    }
  | {
      t: 'lobby';
      phase: Phase;
      roster: RosterEntry[];
      settings: MatchSettings;
      /** e.g. "http://10.0.1.42:5080/play" — shown large on the teacher page. */
      joinUrl: string;
    }
  | { t: 'snap'; /** the room's own accumulated sim clock, seconds */ c: number; s: Snapshot }
  | QuestionMsg
  | { t: 'qtick'; qid: string; answered: number; total: number; remaining: number }
  | RevealMsg
  | { t: 'questionOff' }
  | { t: 'scoreboard'; rows: { pid: string; name: string; place: number; correct: number; attempted: number; matchesWon: number }[] }
  | { t: 'error'; msg: string }
  | { t: 'ended'; msg: string }
  // ---- teacher only
  | { t: 'sets'; sets: QuestionSetSummary[] }
  | { t: 'qlive'; qid: string; rows: { pid: string; name: string; answered: boolean; eligible: boolean }[] };

export const encode = (m: ServerMsg | ClientMsg): string => JSON.stringify(m);

/** Never throws. A malformed frame is null and is dropped by the caller. */
export function decode<T>(raw: string): T | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof (parsed as { t?: unknown }).t !== 'string') return null;
    return parsed as T;
  } catch {
    return null;
  }
}
