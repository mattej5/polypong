// Paddle-input regression investigation. Headless: no http, no ws, no server
// — it drives Room directly, as test/deadlock.mjs does.
//
//   node test/paddle-input.mjs
//
// Root cause: this is a client-side focus bug on the arena self-join path, not
// a Room/Game input regression. When self-join succeeds, src/arena.js:159
// hides #selfjoin but never blurs #selfname. The keyboard handler at
// src/arena.js:186-188 calls that still-focused INPUT "typing", then returns
// before steering at src/arena.js:201-218. It is reachable when the name is
// submitted with Enter (src/arena.js:179-182); a mouse click normally focuses
// the TAKE A SEAT button first. The hidden class is display:none in
// src/shell.css:197, which does not itself blur the focused input.
//
// A Room-only harness has no document, activeElement, input, or browser focus
// transitions, so it cannot mechanically reproduce this DOM bug. Manual repro:
// 1. Open arena.html (/). 2. Type a name in "YOUR NAME". 3. Press Enter to
// take a seat. 4. After the welcome hides the join panel, without clicking
// anywhere else press ArrowLeft/ArrowRight or A/D. 5. The paddle does not move
// because #selfname remains document.activeElement and typing() swallows the
// keydown. By contrast, src/play.js:236-245 has no typing() guard, so its
// hidden name input does not block its separate keyboard-steering path.
import { readFile } from 'node:fs/promises';
import { Room } from '../src/net/room.js';
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

console.log('\n-- server-side player input remains wired --');
{
  const r = room();
  r.join(1, true);
  r.message(1, { t: C.HELLO, role: 'display' });
  r.join(10, false);
  r.message(10, { t: C.HELLO, role: 'player', name: 'Student' });
  const slot = r.conns.get(10).slot;
  r.message(1, { t: C.CONFIG, bots: 1 });
  r.message(1, { t: C.START });

  check('the seated player exists when the match starts',
    slot !== null && !!r.game.players[slot], `slot=${slot}`);
  r.message(10, { t: 'in', d: -1 });
  check('player INPUT -1 reaches Game.setInput',
    r.game.players[slot].inputDir === -1, `inputDir=${r.game.players[slot].inputDir}`);
  r.message(10, { t: 'in', d: 1 });
  check('player INPUT 1 reaches Game.setInput',
    r.game.players[slot].inputDir === 1, `inputDir=${r.game.players[slot].inputDir}`);
  r.message(10, { t: 'in', d: 0 });
  check('player INPUT 0 reaches Game.setInput',
    r.game.players[slot].inputDir === 0, `inputDir=${r.game.players[slot].inputDir}`);
}

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exitCode = failed ? 1 : 0;
