// The connection. SPEC §8, §10.2.
//
// This is the ONE file in src/client/net/ allowed to touch WebSocket,
// localStorage, and location — interp.ts and predict.ts stay pure arithmetic
// so they can be tested under bare `bun test`. Everything here is I/O and
// timers instead.
//
// School Wi-Fi drops and Chromebooks sleep. A closed socket is a normal event
// on this network, not an error path: reconnect automatically with backoff,
// and carry the join token across the gap so the student reclaims their seat
// (SPEC §8) instead of rejoining as a stranger.

import type { ClientMsg, Role, ServerMsg } from '../../shared/protocol';
import { decode, encode } from '../../shared/protocol';

const TOKEN_KEY = 'polypong.token';

const BACKOFF_START_MS = 300;
const BACKOFF_MAX_MS = 5000;
const BACKOFF_FACTOR = 1.7;

function loadToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    // Storage can throw in private-browsing / locked-down Chromebook
    // profiles. No token to replay is a degraded reconnect, not a crash.
    return undefined;
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Best-effort. A student who can't persist a token just rejoins fresh
    // next time; nothing here is worth surfacing as an error.
  }
}

export type MessageHandler = (msg: ServerMsg) => void;

export class Socket {
  private readonly role: Role;
  private readonly name: string | undefined;
  private ws: WebSocket | null = null;
  private token: string | undefined;
  private handlers = new Set<MessageHandler>();
  private backoffMs = BACKOFF_START_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;

  constructor(role: Role, name?: string) {
    this.role = role;
    this.name = name;
    this.token = loadToken();
  }

  /** Subscribe to decoded server messages. Returns an unsubscribe function. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  /** Stop reconnecting and close the live socket, if any. */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(msg));
  }

  private open(): void {
    const ws = new WebSocket(`ws://${location.host}`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = BACKOFF_START_MS; // a successful connect resets backoff
      this.send({ t: 'hello', role: this.role, name: this.name, token: this.token });
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return; // never thrown, just dropped
      const msg = decode<ServerMsg>(ev.data);
      if (!msg) return;
      if (msg.t === 'welcome' && msg.token) {
        this.token = msg.token;
        saveToken(msg.token);
      }
      for (const h of this.handlers) h(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket already
      this.ws = null;
      if (this.closedByCaller) return;
      this.scheduleReconnect();
    };

    // A socket error is always followed by a close event; the reconnect is
    // driven from onclose so there is exactly one retry path, not two racing
    // ones.
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(BACKOFF_MAX_MS, this.backoffMs * BACKOFF_FACTOR);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByCaller) return;
      this.open();
    }, delay);
  }
}
