// Wire protocol. Shared verbatim by every client and every server adapter.
// Keep it small and additive — both ends must agree, including the Cloudflare
// adapter that does not exist yet.

export const PROTOCOL = 1;

// client -> server
export const C = {
  HELLO: 'hello',   // { role:'display'|'player', name?, token? }
  INPUT: 'in',      // { d: -1|0|1 }
  AIM: 'aim',       // { u, v }   arena units
  PLACE: 'place',   // {}
  CONFIG: 'cfg',    // { bots }            display only
  START: 'start',   // {}                  display only
  PAUSE: 'pause',   // { on }              display only
  RESET: 'reset',   // {}                  display only
};

// server -> client
export const S = {
  WELCOME: 'welcome', // { id, role, slot, token, protocol }
  LOBBY: 'lobby',     // { seats:[{slot,name,color,connected,bot}], bots, state }
  SNAP: 'snap',       // { s: <Game.snapshot()> }
  ERROR: 'err',       // { msg }
};

export const encode = (msg) => JSON.stringify(msg);
export const decode = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};
