// Transport tests. These run against a real Bun.serve on an ephemeral port
// with a stub room, so every assertion below exercises the same handler code
// that a classroom runs — there is no test-only branch inside http.ts.

import { afterEach, describe, expect, test } from 'bun:test';

import type { ClientMsg } from '../src/shared/protocol';
import { encode } from '../src/shared/protocol';
import {
  createSocketRegistry,
  isLoopbackAddress,
  startServer,
  type ConnId,
  type RoomPort,
  type RunningServer,
} from '../src/server/http';

// ------------------------------------------------------------------ helpers

interface StubRoom extends RoomPort {
  joins: { id: ConnId; isLocal: boolean }[];
  leaves: ConnId[];
  messages: { id: ConnId; msg: ClientMsg }[];
  joinUrls: string[];
}

function stubRoom(): StubRoom {
  const r: StubRoom = {
    joins: [],
    leaves: [],
    messages: [],
    joinUrls: [],
    join(id, isLocal) {
      r.joins.push({ id, isLocal });
    },
    leave(id) {
      r.leaves.push(id);
    },
    message(id, msg) {
      r.messages.push({ id, msg });
    },
    setJoinUrl(url) {
      r.joinUrls.push(url);
    },
  };
  return r;
}

let running: RunningServer | null = null;

function start(opts: { room: RoomPort; address?: string; port?: number }): RunningServer {
  const s = startServer({
    port: opts.port ?? 0,
    room: opts.room,
    sockets: createSocketRegistry(),
    lanAddress: '10.0.1.42',
    // The seam that makes the non-loopback path testable from one machine.
    // Left undefined here means "use the real peer address".
    ...(opts.address === undefined ? {} : { addressOf: () => opts.address ?? null }),
  });
  running = s;
  return s;
}

const base = (s: RunningServer): string => `http://127.0.0.1:${s.port}`;

/** Waits for a predicate rather than a fixed sleep, so the suite is not flaky
 *  on a loaded machine and not slow on an idle one. */
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

function openSocket(s: RunningServer, path = '/ws'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}${path}`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('socket failed to open'));
  });
}

afterEach(async () => {
  if (running) {
    await running.stop();
    running = null;
  }
});

// ------------------------------------------------------- the pure gate (I9)

describe('isLoopbackAddress', () => {
  test.each([
    '127.0.0.1',
    '127.0.0.53',
    '127.1.2.3',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
    '[::1]',
    '::1%lo0',
    ' 127.0.0.1 ',
  ])('accepts loopback %p', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });

  test.each([
    '10.0.1.42',
    '192.168.1.101',
    '172.16.4.9',
    '169.254.10.1',
    '0.0.0.0',
    '128.0.0.1',
    '27.0.0.1',
    // The trap: a LAN peer in IPv4-mapped clothing. Bun reports this form
    // whenever the listener is bound to '::', which is how we bind.
    '::ffff:192.168.1.101',
    '::ffff:10.0.1.42',
    'fe80::1',
    '::',
    '2606:4700::1111',
    'localhost',
    'not an address',
    '127.0.0.256',
    '127.0.0',
    '',
    '   ',
  ])('rejects %p', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(false);
  });

  test('rejects a missing address', () => {
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

// ------------------------------------------------------------------- routes

describe('routes', () => {
  test('non-loopback GET / is redirected to /play (SPEC I9)', async () => {
    const s = start({ room: stubRoom(), address: '::ffff:192.168.1.77' });
    const res = await fetch(base(s) + '/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '', 'http://x').pathname).toBe('/play');
  });

  test('non-loopback GET / never leaks the console markup', async () => {
    const s = start({ room: stubRoom(), address: '10.0.1.9' });
    const res = await fetch(base(s) + '/', { redirect: 'manual' });
    expect((await res.text()).trim()).toBe('');
  });

  test('loopback GET / returns 200 and the teacher page', async () => {
    // No address override: this is the genuine peer address from Bun.
    const s = start({ room: stubRoom() });
    const res = await fetch(base(s) + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  test('GET /play returns 200 from a non-loopback address', async () => {
    const s = start({ room: stubRoom(), address: '192.168.1.101' });
    const res = await fetch(base(s) + '/play');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('GET /health returns 200 from a non-loopback address and reports it', async () => {
    const s = start({ room: stubRoom(), address: '192.168.1.101' });
    const res = await fetch(base(s) + '/health');
    expect(res.status).toBe(200);
    const body = await res.text();
    // The page's whole job is telling a teacher what the server saw.
    expect(body).toContain('192.168.1.101');
    expect(body).toContain('10.0.1.42');
    expect(body).toContain('/health-ws');
  });

  test('GET /health works from loopback too', async () => {
    const s = start({ room: stubRoom() });
    expect((await fetch(base(s) + '/health')).status).toBe(200);
  });

  test('an unknown path is 404, not the console', async () => {
    const s = start({ room: stubRoom(), address: '192.168.1.101' });
    expect((await fetch(base(s) + '/admin')).status).toBe(404);
  });
});

// ----------------------------------------------------------------- sockets

describe('websockets', () => {
  test('a loopback socket joins with isLocal true', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s);
    await until(() => room.joins.length === 1);
    expect(room.joins[0]?.isLocal).toBe(true);
    ws.close();
  });

  test('a non-loopback socket joins with isLocal false (SPEC I10)', async () => {
    const room = stubRoom();
    const s = start({ room, address: '::ffff:192.168.1.77' });
    const ws = await openSocket(s);
    await until(() => room.joins.length === 1);
    expect(room.joins[0]?.isLocal).toBe(false);
    ws.close();
  });

  test('each connection gets a distinct id', async () => {
    const room = stubRoom();
    const s = start({ room });
    const a = await openSocket(s);
    const b = await openSocket(s);
    await until(() => room.joins.length === 2);
    expect(room.joins[0]?.id).not.toBe(room.joins[1]?.id);
    a.close();
    b.close();
  });

  test('frames are decoded and handed to the room', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s);
    await until(() => room.joins.length === 1);
    ws.send(encode({ t: 'hello', role: 'player', name: 'RILEY' }));
    ws.send(encode({ t: 'input', d: -1 }));
    await until(() => room.messages.length === 2);
    expect(room.messages[0]?.msg).toEqual({ t: 'hello', role: 'player', name: 'RILEY' });
    expect(room.messages[1]?.msg).toEqual({ t: 'input', d: -1 });
    expect(room.messages[0]?.id).toBe(room.joins[0]?.id ?? -1);
    ws.close();
  });

  test('a malformed frame is dropped without throwing or disconnecting', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s);
    await until(() => room.joins.length === 1);

    ws.send('{ this is not json');
    ws.send('null');
    ws.send('[]');
    ws.send('{"no":"tag"}');
    ws.send('{"t":42}');
    ws.send('');

    // The socket must still be usable afterwards; that is the real assertion.
    ws.send(encode({ t: 'start' }));
    await until(() => room.messages.length > 0);
    expect(room.messages).toHaveLength(1);
    expect(room.messages[0]?.msg).toEqual({ t: 'start' });
    expect(room.leaves).toHaveLength(0);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test('closing a socket leaves the room with the same id', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s);
    await until(() => room.joins.length === 1);
    const id = room.joins[0]?.id;
    ws.close();
    await until(() => room.leaves.length === 1);
    expect(room.leaves[0]).toBe(id ?? -1);
  });

  test('an abrupt drop with no close frame still leaves the room (SPEC I4)', async () => {
    // The Chromebook-lid case. Bun has no separate websocket `error` callback,
    // so this asserts that a socket which dies mid-connection really does reach
    // `close` and free the seat, rather than sitting in the roster forever.
    const room = stubRoom();
    const s = start({ room });

    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const chunks: string[] = [];
    const conn = await Bun.connect({
      hostname: '127.0.0.1',
      port: s.port,
      socket: {
        data(_sock, data) {
          chunks.push(new TextDecoder().decode(data));
        },
        error() {},
        close() {},
      },
    });
    conn.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await until(() => chunks.join('').includes('101'));
    await until(() => room.joins.length === 1);

    // No close frame, no goodbye: just yank the TCP connection.
    conn.terminate();
    await until(() => room.leaves.length === 1);
    expect(room.leaves[0]).toBe(room.joins[0]?.id ?? -1);
  });

  test('the health socket echoes and never reaches the room', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s, '/health-ws');
    const got: string[] = [];
    ws.onmessage = (ev) => got.push(String(ev.data));
    ws.send('12345.5');
    await until(() => got.length === 1);
    expect(got[0]).toBe('12345.5');
    expect(room.joins).toHaveLength(0);
    ws.close();
    await Bun.sleep(30);
    expect(room.leaves).toHaveLength(0);
  });

  test('an upgrade on "/" joins the room rather than being redirected', async () => {
    // src/client/net/socket.ts connects to `ws://${location.host}` with no
    // path, so this lands on the "/" route, which otherwise answers with the
    // teacher page or a 302. Every student socket depends on this.
    const room = stubRoom();
    const s = start({ room, address: '::ffff:192.168.1.77' });
    const ws = await openSocket(s, '/');
    await until(() => room.joins.length === 1);
    expect(room.joins[0]?.isLocal).toBe(false);
    ws.close();
  });

  test('an upgrade on "/" from loopback joins as local', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s, '/');
    await until(() => room.joins.length === 1);
    expect(room.joins[0]?.isLocal).toBe(true);
    ws.close();
  });

  test('an upgrade on an unrouted path still joins the room', async () => {
    const room = stubRoom();
    const s = start({ room });
    const ws = await openSocket(s, '/socket');
    await until(() => room.joins.length === 1);
    ws.close();
  });
});

// ---------------------------------------------------------------- lifecycle

describe('stop()', () => {
  test('releases the port so the same port can be bound again', async () => {
    const port = 5411 + Math.floor(Math.random() * 200);
    const first = start({ room: stubRoom(), port });
    expect(first.port).toBe(port);
    expect((await fetch(base(first) + '/health')).status).toBe(200);
    await first.stop();
    running = null;

    const second = start({ room: stubRoom(), port });
    running = second;
    expect(second.port).toBe(port);
    expect((await fetch(base(second) + '/health')).status).toBe(200);
  });

  test('stops with a live socket attached', async () => {
    const room = stubRoom();
    const port = 5711 + Math.floor(Math.random() * 200);
    const first = start({ room, port });
    const ws = await openSocket(first);
    await until(() => room.joins.length === 1);
    await first.stop();
    running = null;

    const second = start({ room: stubRoom(), port });
    running = second;
    expect((await fetch(base(second) + '/health')).status).toBe(200);
    expect(ws.readyState).not.toBe(WebSocket.CONNECTING);
  });
});
