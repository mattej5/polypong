// Bun transport adapter: routes, the loopback gate, and the WebSocket seam.
//
// Everything runtime-specific about *serving* lives here. `Match` is handed
// `join/leave/message` and never learns what a socket is, which is what lets
// this whole file be replaced by a hosted transport later (SPEC §14 R1)
// without touching game logic.
//
// `startServer` takes its room and its socket registry as parameters rather
// than importing them, so the tests can drive the real handler paths with a
// stub room. There is no second, test-only code path through this file.

import type { ServerWebSocket, Server } from 'bun';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import { decode, encode } from '../shared/protocol';
import { healthPage } from './health';

import teacherPage from '../client/teacher/index.html';
import playPage from '../client/play/index.html';

/** Opaque connection identity, minted here and handed to Match. */
export type ConnId = number;

/** Every socket is published to over one Bun pub/sub topic (SPEC §10.2). */
export const ROOM_TOPIC = 'room';

/** The canonical game WebSocket path. Any unrouted path carrying an Upgrade
 *  header is also accepted, so a client lane choosing a different path still
 *  connects rather than silently failing at 3pm on a Tuesday. */
export const WS_PATH = '/ws';

/** The health page's echo socket. Kept off the room entirely: a teacher
 *  testing reachability must not appear in the roster. */
export const HEALTH_WS_PATH = '/health-ws';

// ------------------------------------------------------------- loopback gate

/**
 * SPEC I9/I10. Exported as a pure function of the address string precisely so
 * it can be tested exhaustively without a second machine.
 *
 * All three spellings below are the SAME peer, and which one Bun reports
 * depends on how the listener was bound. Verified against Bun 1.3.14:
 *   hostname '0.0.0.0' -> '127.0.0.1'
 *   hostname '::'      -> '::ffff:127.0.0.1' for an IPv4 peer, '::1' for IPv6
 * Getting this wrong in either direction is a real failure: too strict locks
 * the teacher out of their own console, too loose hands the console to a
 * student. Note that the whole 127.0.0.0/8 block is loopback, not just .1 —
 * a packet from 127.x can only have originated on this machine.
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (typeof addr !== 'string') return false;
  let a = addr.trim().toLowerCase();
  if (a === '') return false;
  // Strip a bracketed form ("[::1]") and any IPv6 zone index ("fe80::1%en0").
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped IPv6. Only the mapped prefix counts; '::ffff:192.168.1.9' is
  // a LAN peer wearing an IPv6 costume and must NOT pass.
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((s) => Number(s));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return octets[0] === 127;
}

// ------------------------------------------------------------------ sockets

interface SocketData {
  id: ConnId;
  isLocal: boolean;
  /** 'room' sockets are players and the teacher. 'health' sockets are the
   *  reachability page and are invisible to Match. */
  kind: 'room' | 'health';
}

type RoomSocket = ServerWebSocket<SocketData>;

/**
 * Owns the id -> socket map. Match sends by id and broadcasts by topic; it
 * never sees a socket. `bind` is called by startServer once Bun hands back a
 * server, because `server.publish` does not exist before then.
 */
export interface SocketRegistry {
  bind(server: Server<SocketData>): void;
  add(id: ConnId, ws: RoomSocket): void;
  remove(id: ConnId): void;
  send(id: ConnId, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  /** Live room sockets. The teacher page uses zero here to diagnose SPEC R3. */
  count(): number;
  /** Forget every socket. Does NOT close them — see the note on `stop()`. */
  clear(): void;
}

export function createSocketRegistry(): SocketRegistry {
  const byId = new Map<ConnId, RoomSocket>();
  let server: Server<SocketData> | null = null;
  return {
    bind(s) {
      server = s;
    },
    add(id, ws) {
      byId.set(id, ws);
      ws.subscribe(ROOM_TOPIC);
    },
    remove(id) {
      byId.delete(id);
    },
    send(id, msg) {
      const ws = byId.get(id);
      // readyState 1 === OPEN. Sending into a closing socket throws in Bun.
      if (ws && ws.readyState === 1) ws.send(encode(msg));
    },
    broadcast(msg) {
      // One publish beats N sends: at 30 Hz with 8 seats plus spectators the
      // manual loop is the hot path (SPEC §10.2).
      if (server) server.publish(ROOM_TOPIC, encode(msg));
    },
    count() {
      return byId.size;
    },
    clear() {
      byId.clear();
    },
  };
}

// -------------------------------------------------------------------- server

/** The slice of Match that the transport actually drives. Narrow on purpose:
 *  it is also exactly what a test stub has to implement. */
export interface RoomPort {
  join(id: ConnId, isLocal: boolean): void;
  leave(id: ConnId): void;
  message(id: ConnId, msg: ClientMsg): void;
  setJoinUrl(url: string): void;
}

export interface ServerOpts {
  port: number;
  room: RoomPort;
  sockets: SocketRegistry;
  /** Bind address. '::' is dual-stack on macOS and serves IPv4 Chromebooks
   *  and an IPv6 `localhost` from the teacher's own browser off one listener. */
  hostname?: string;
  /** The Mac's LAN IPv4, for the health page. Resolved by main.ts. */
  lanAddress?: string;
  /**
   * Test seam. Production leaves this undefined and the real peer address is
   * used. A test overrides it to exercise the REAL `/` handler as if the
   * request had arrived from another machine — the alternative is asserting
   * only against `isLoopbackAddress`, which would leave the wiring untested.
   */
  addressOf?: (req: Request, server: Server<SocketData>) => string | null;
}

export interface RunningServer {
  port: number;
  stop(): Promise<void>;
}

export function startServer(opts: ServerOpts): RunningServer {
  const { room, sockets } = opts;
  let nextId: ConnId = 1;

  // The teacher console is an HTML bundle, and a bundle route cannot also be a
  // guard function — Bun matches routes before `fetch`, a route handler that
  // returns undefined is an error rather than a fallthrough, and `server.fetch`
  // bypasses `routes` entirely (all three verified against Bun 1.3.14). So the
  // bundle is mounted on a per-boot unguessable path and `/` proxies to it over
  // loopback for local peers only. One extra local request per page load, once
  // a lesson; in exchange `/` is a plain function and SPEC I9 is enforced in
  // one readable place.
  const consolePath = `/__console-${crypto.randomUUID()}`;

  const peerAddress = (req: Request, server: Server<SocketData>): string | null =>
    opts.addressOf ? opts.addressOf(req, server) : (server.requestIP(req)?.address ?? null);

  const upgrade = (
    req: Request,
    server: Server<SocketData>,
    kind: 'room' | 'health',
  ): Response | undefined => {
    const id = nextId++;
    const isLocal = isLoopbackAddress(peerAddress(req, server));
    const ok = server.upgrade(req, { data: { id, isLocal, kind } });
    return ok ? undefined : new Response('expected a websocket upgrade', { status: 426 });
  };

  const server = Bun.serve<SocketData, string>({
    port: opts.port,
    hostname: opts.hostname ?? '::',
    // A student's Chromebook holding an idle socket through a question must
    // not be culled; the room's own deadlines are the only thing that ends a
    // wait (SPEC I1). 255 is Bun's maximum.
    idleTimeout: 255,

    routes: {
      [consolePath]: teacherPage,
      '/play': playPage,

      // SPEC I9. This is the whole of the HTTP access rule.
      '/': async (req, srv) => {
        // The client net layer connects to `ws://<host>` with no path, which
        // lands here rather than on WS_PATH. A browser navigating to `/` never
        // sends this header, so upgrading first costs nothing and stops the
        // student socket from being answered with a 302 it cannot read.
        if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          return upgrade(req, srv, 'room');
        }
        if (!isLoopbackAddress(peerAddress(req, srv))) {
          // 302 rather than 403: a student who typed the IP wanted to play,
          // and bouncing them straight there is the behaviour the room needs.
          return new Response(null, { status: 302, headers: { location: '/play' } });
        }
        const res = await fetch(`http://127.0.0.1:${srv.port}${consolePath}`);
        return new Response(res.body, { status: res.status, headers: res.headers });
      },

      '/health': (req, srv) => {
        const seen = peerAddress(req, srv) ?? 'unknown';
        return new Response(
          healthPage({
            clientAddress: seen,
            serverAddress: opts.lanAddress ?? 'localhost',
            port: srv.port ?? opts.port,
            origin: new URL(req.url).host,
          }),
          { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
        );
      },

      [WS_PATH]: (req, srv) => upgrade(req, srv, 'room'),
      [HEALTH_WS_PATH]: (req, srv) => upgrade(req, srv, 'health'),
    },

    fetch(req, srv) {
      // Any unrouted path asking to upgrade is treated as a game socket, so a
      // client lane that picks a different path still connects.
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return upgrade(req, srv, 'room');
      }
      return new Response('not found', { status: 404 });
    },

    error(err) {
      // A thrown handler must not take the classroom down with it.
      console.error(`  ! request failed: ${err.message}`);
      return new Response('server error', { status: 500 });
    },

    websocket: {
      open(ws) {
        if (ws.data.kind === 'health') return;
        sockets.add(ws.data.id, ws);
        // The HTTP redirect above is cosmetic: nothing stops a student opening
        // a raw socket from devtools and claiming role 'teacher'. This flag is
        // what Match refuses them on (SPEC I10).
        room.join(ws.data.id, ws.data.isLocal);
      },
      message(ws, raw) {
        if (ws.data.kind === 'health') {
          // Echo verbatim; the page times the round trip itself.
          if (typeof raw === 'string') ws.send(raw);
          return;
        }
        if (typeof raw !== 'string') return; // binary frames are not protocol
        const msg = decode<ClientMsg>(raw);
        if (msg === null) return; // malformed: dropped, never thrown, never a disconnect
        room.message(ws.data.id, msg);
      },
      // Close and error are the same event as far as the room is concerned:
      // the seat is gone and a bot takes it. Treating them differently is how
      // the old build ended up with sockets that were closed but still seated.
      //
      // Bun's WebSocketHandler has no separate `error` callback (checked
      // against bun-types 1.4.0): a socket that fails — a Chromebook lid
      // closing, Wi-Fi dropping, a half-open TCP connection — surfaces here as
      // a close with an abnormal code. So this one handler IS both paths, and
      // there is no way for a failed socket to stay seated.
      close(ws) {
        if (ws.data.kind === 'health') return;
        sockets.remove(ws.data.id);
        room.leave(ws.data.id);
      },
    },
  });

  sockets.bind(server);

  return {
    port: server.port ?? opts.port,
    async stop() {
      // `true` terminates live connections; without it a game socket holds the
      // port open and the next start fails.
      //
      // Do NOT close the sockets yourself first. Verified on Bun 1.3.14: if a
      // server-side ws.close() has already run, server.stop(true) never
      // resolves and shutdown hangs forever. stop(true) closes them anyway.
      // The cost is that clients see close code 1006 rather than 1001 — which
      // is fine, because Match has already broadcast "session ended" and the
      // adapter waits for that to flush before calling this.
      await server.stop(true);
      sockets.clear();
    },
  };
}
