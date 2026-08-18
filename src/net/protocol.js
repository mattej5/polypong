// Wire protocol. Shared verbatim by every client and every server adapter.
// Keep it small and additive — both ends must agree, including the Cloudflare
// adapter that does not exist yet.

export const PROTOCOL = 1;

// client -> server
export const C = {
  HELLO: 'hello',   // { role:'display'|'player'|'teacher', name?, token? }
  INPUT: 'in',      // { d: -1|0|1 }
  AIM: 'aim',       // { u, v }   arena units
  PLACE: 'place',   // {}
  CONFIG: 'cfg',    // { bots }            display only
  START: 'start',   // {}                  display only
  PAUSE: 'pause',   // { on }              display only
  RESET: 'reset',   // {}                  display only

  // quiz — students
  ANSWER: 'ans',        // { qid, c: 0..3 }

  // quiz — teacher console (/admin) only
  SET_SAVE: 'setsave',  // { id?, name, csv }
  SET_DELETE: 'setdel', // { id }
  QUIZ_CFG: 'qcfg',     // { setId?, timerSec?, autoAdvance?, projectResults?, enabled? }
  QUIZ_ASK_NOW: 'qask', // {}                  fire a question immediately
  QUIZ_CLOSE: 'qclose', // {}                  teacher override: close early
  QUIZ_EXTEND: 'qext',  // { slot, sec }       per-student time extension
};

// server -> client
export const S = {
  WELCOME: 'welcome', // { id, role, slot, token, protocol }
  LOBBY: 'lobby',     // { seats:[{slot,name,color,connected,bot}], bots, state }
  SNAP: 'snap',       // { s: <Game.snapshot()> }
  ERROR: 'err',       // { msg }

  // quiz — everyone. Never carries the answer key while a question is open.
  QUIZ_ASK: 'qask',   // { qid, q, options, topic, timer, twoOption, reason, mine }
  QUIZ_TICK: 'qtick', // { qid, answered, total, remaining, overtime }
  QUIZ_END: 'qend',   // { qid, correct, options, yours?, youWere?, revived? }
  QUIZ_OFF: 'qoff',   // {}   no question open (sent on join so late tabs settle)

  // quiz — teacher console only
  SETS: 'sets',       // { sets:[{id,name,count,twoOption}], cfg:{...} }
  QUIZ_LIVE: 'qlive', // { qid, rows:[{slot,name,answered,correct,remaining,extension}] }
  QUIZ_LOG: 'qlog',   // { entries:[...], topics:[...], targets:{slot:round} }
};

export const encode = (msg) => JSON.stringify(msg);
export const decode = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};
