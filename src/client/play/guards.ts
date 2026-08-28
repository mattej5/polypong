// Wire validation for the student page.
//
// SPEC does not promise the student client anything about a malformed frame,
// so this file decides: NOTHING off the wire is trusted for layout. A frame
// that is not the shape this page expects is dropped, and the page keeps
// drawing the last good one. The alternative — reading `s.pl[0].n` off a
// half-formed object inside requestAnimationFrame — throws once and leaves a
// black screen for the rest of the lesson, which is exactly the failure a
// student cannot report and a teacher cannot fix.
//
// `decode` in protocol.ts already guarantees "an object with a string `t`".
// Everything below is the second half: that the fields the renderer indexes
// into actually exist and are finite.

import { MAX_SEATS } from '../../shared/config';
import type {
  Phase,
  QuestionMsg,
  RevealMsg,
  RosterEntry,
  Snapshot,
  SnapBall,
  SnapHazard,
  SnapPlayer,
} from '../../shared/protocol';

const PHASES = new Set<string>([
  'lobby', 'countdown', 'playing', 'question', 'reveal', 'announce', 'resume', 'matchover',
]);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

const pair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);

export const isPhase = (v: unknown): v is Phase => str(v) && PHASES.has(v);

function isSnapPlayer(v: unknown): v is SnapPlayer {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    num(p.i) && p.i >= 0 && p.i < MAX_SEATS &&
    num(p.l) && num(p.s) && str(p.n) &&
    (p.a === 0 || p.a === 1) && (p.b === 0 || p.b === 1)
  );
}

function isSnapBall(v: unknown): v is SnapBall {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return num(b.i) && pair(b.p) && pair(b.v) && (b.h === 0 || b.h === 1);
}

function isSnapHazard(v: unknown): v is SnapHazard {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return (h.k === 'blackhole' || h.k === 'sun') && pair(h.p) && num(h.o);
}

/** The one guard the render path depends on. Everything it walks is checked. */
export function isSnapshot(v: unknown): v is Snapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (!isPhase(s.ph) || !num(s.tm) || !num(s.rd) || !str(s.bn)) return false;
  if (!Array.isArray(s.pl) || !Array.isArray(s.bl) || !Array.isArray(s.hz)) return false;
  if (s.pl.length > MAX_SEATS) return false;
  if (!(s.wn === null || num(s.wn))) return false;
  if (!(s.sp === null || pair(s.sp))) return false;
  for (const p of s.pl) if (!isSnapPlayer(p)) return false;
  for (const b of s.bl) if (!isSnapBall(b)) return false;
  for (const h of s.hz) if (!isSnapHazard(h)) return false;
  return true;
}

export function isRoster(v: unknown): v is RosterEntry[] {
  if (!Array.isArray(v)) return false;
  for (const r of v) {
    if (!r || typeof r !== 'object') return false;
    const e = r as Record<string, unknown>;
    if (!str(e.pid) || !str(e.name)) return false;
    if (!(e.seat === null || num(e.seat))) return false;
    if (!num(e.lives) || !str(e.status)) return false;
  }
  return true;
}

/**
 * A question with 2-4 usable options. Anything past four is dropped rather
 * than rendered, because the modal has four keys and four buttons and a fifth
 * option would be unreachable — silently unanswerable is worse than absent.
 */
export function isQuestion(v: unknown): v is QuestionMsg {
  if (!v || typeof v !== 'object') return false;
  const q = v as Record<string, unknown>;
  if (!str(q.qid) || !str(q.text)) return false;
  if (q.kind !== 'class' && q.kind !== 'revive') return false;
  if (typeof q.eligible !== 'boolean') return false;
  if (!Array.isArray(q.options) || q.options.length < 1) return false;
  for (const o of q.options) if (!str(o)) return false;
  return true;
}

export function isReveal(v: unknown): v is RevealMsg {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (!str(r.qid) || !num(r.correct)) return false;
  if (!(r.yourChoice === null || num(r.yourChoice))) return false;
  return num(r.yourDelta);
}

/** Names from other students are DATA. They reach the DOM by textContent
 *  only — never innerHTML — and this trims what a long one can do to layout. */
export function safeName(v: unknown, fallback = '?'): string {
  if (!str(v)) return fallback;
  const t = v.replace(/\s+/g, ' ').trim();
  return t === '' ? fallback : t.slice(0, 24);
}
