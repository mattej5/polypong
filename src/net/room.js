import { Game, STATE } from '../game.js';
import { COLORS } from '../config.js';
import { C, S, PROTOCOL } from './protocol.js';

export const MAX_SEATS = COLORS.length;

// The server-side arena is a fixed virtual space. Every coordinate that leaves
// this room is in arena units, so the virtual size never reaches a client.
const VIRTUAL = 1000;

/**
 * Authoritative game room. Deliberately free of any runtime API — no http, no
 * ws, no timers, no fs. It is handed `send`/`broadcast` and is driven by an
 * external clock, so the same class runs under Node today and inside a
 * Cloudflare Durable Object later without edits.
 */
export class Room {
  constructor({ send, broadcast, snapHz = 20, meta = {} }) {
    this.send = send;
    this.broadcast = broadcast;
    this.meta = meta;   // adapter-supplied, e.g. the join URL for this runtime
    this.snapInterval = 1 / snapHz;
    this.snapAcc = 0;

    this.conns = new Map();   // connId -> { role, slot, token }
    this.seats = [];          // index = slot
    this.bots = 0;
    this.game = new Game();
    this.game.setViewport(VIRTUAL, VIRTUAL, 1);
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
    this.pushLobby();
  }

  message(connId, msg) {
    const c = this.conns.get(connId);
    if (!c || !msg) return;
    if (msg.t === C.HELLO) return this.hello(connId, c, msg);
    if (c.role === 'player') return this.playerMessage(c, msg);
    if (c.role === 'display') return this.displayMessage(msg);
  }

  hello(connId, c, msg) {
    c.role = msg.role === 'display' ? 'display' : 'player';

    if (c.role === 'display') {
      this.send(connId, { t: S.WELCOME, id: connId, role: 'display', slot: null, protocol: PROTOCOL });
      this.pushLobby();
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
  }

  // -------------------------------------------------------------- messages

  playerMessage(c, msg) {
    if (c.slot === null) return;
    switch (msg.t) {
      case C.INPUT: this.game.setInput(c.slot, msg.d); break;
      case C.AIM:   this.game.aimHazard(c.slot, msg.u, msg.v); break;
      case C.PLACE: this.game.placeHazard(c.slot); break;
    }
  }

  displayMessage(msg) {
    switch (msg.t) {
      case C.CONFIG:
        this.bots = Math.max(0, Math.min(MAX_SEATS - this.seats.length, msg.bots | 0));
        this.pushLobby();
        break;
      case C.START: this.startGame(); break;
      case C.PAUSE: this.game.paused = !!msg.on; break;
      case C.RESET: this.resetToLobby(); break;
    }
  }

  // ----------------------------------------------------------------- rounds

  startGame() {
    const humans = this.seats.length;
    const total = Math.min(MAX_SEATS, humans + this.bots);
    if (total < 2) {
      this.broadcast({ t: S.ERROR, msg: 'Need at least 2 players. Add a bot or wait for a join.' });
      return;
    }
    this.game.start(total, total - humans);
    this.seats.forEach((seat) => {
      const p = this.game.players[seat.slot];
      if (!p) return;
      p.name = seat.name;
      p.wasBot = false;
      p.isBot = !seat.connected;   // absent students play as bots until they join
    });
    for (let i = humans; i < total; i++) if (this.game.players[i]) this.game.players[i].wasBot = true;
    this.pushLobby();
  }

  resetToLobby() {
    this.game = new Game();
    this.game.setViewport(VIRTUAL, VIRTUAL, 1);
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

  // ------------------------------------------------------------------ clock

  /** Driven by the adapter: setInterval under Node, alarms under a Durable Object. */
  tick(dt) {
    this.game.update(dt);
    this.snapAcc += dt;
    if (this.snapAcc >= this.snapInterval) {
      this.snapAcc = 0;
      this.broadcast({ t: S.SNAP, s: this.game.snapshot() });
    }
  }
}
