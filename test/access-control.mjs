// Projector/display access-control regression suite. Headless: no http, no ws,
// no server — it drives Room directly, as test/deadlock.mjs does.
//
//   node test/access-control.mjs
//
// The "remote display must be blocked" checks intentionally FAIL on the code
// as this test is introduced. They are the oracle for the localhost gate, not
// a claim that the current build is secure.
import { readFile } from 'node:fs/promises';
import { Room } from '../src/net/room.js';
import { STATE } from '../src/game.js';
import { C } from '../src/net/protocol.js';

const raw = JSON.parse(await readFile(new URL('../server/question-sets.json', import.meta.url), 'utf8'));
const SETS = Array.isArray(raw) ? raw : raw.sets;

let failed = 0;
const check = (name, ok, note = '') => {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${note ? `\n        ${note}` : ''}`);
  if (!ok) failed++;
};

function room() {
  return new Room({ send: () => {}, broadcast: () => {}, sets: SETS });
}

console.log('\n-- a remote projector must have no match control --');
{
  const r = room();
  r.join(1, false);
  r.message(1, { t: C.HELLO, role: 'display' });
  check('a non-local display hello is not granted the display role',
    r.conns.get(1).role !== 'display', `role=${r.conns.get(1).role}`);
  r.message(1, { t: C.CONFIG, bots: 3 });
  check('a non-local display cannot configure bot count',
    r.bots === 0, `bots=${r.bots}`);
  r.message(1, { t: C.START });
  check('a non-local display cannot start a match',
    r.game.state === STATE.MENU, `state=${r.game.state}`);
}
{
  // First create an active match through the legitimate local projector. A
  // later remote RESET must leave that match — including its Game instance —
  // completely alone.
  const r = room();
  r.join(1, true);
  r.message(1, { t: C.HELLO, role: 'display' });
  r.message(1, { t: C.CONFIG, bots: 2 });
  r.message(1, { t: C.START });
  const activeGame = r.game;
  const activeState = r.game.state;

  r.join(2, false);
  r.message(2, { t: C.HELLO, role: 'display' });
  r.message(2, { t: C.RESET });
  check('a non-local display cannot reset an active match',
    r.game === activeGame && r.game.state === activeState,
    `before=${activeState} after=${r.game.state} replaced=${r.game !== activeGame}`);
}

console.log('\n-- a local projector keeps its existing controls --');
{
  const r = room();
  r.join(1, true);
  r.message(1, { t: C.HELLO, role: 'display' });
  r.message(1, { t: C.CONFIG, bots: 3 });
  check('a local display can configure bot count', r.bots === 3, `bots=${r.bots}`);
  r.message(1, { t: C.START });
  const started = r.game;
  check('a local display can start a match',
    r.game.state === STATE.COUNTDOWN && r.game.players.length === 3,
    `state=${r.game.state} players=${r.game.players.length}`);
  r.message(1, { t: C.RESET });
  check('a local display can reset back to the lobby',
    r.game !== started && r.game.state === STATE.MENU,
    `state=${r.game.state} replaced=${r.game !== started}`);
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exitCode = failed ? 1 : 0;
