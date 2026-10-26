// The PWA's WebSocket to its Hub (Phase 3 hardening), DOM-free so it can be tested with fakes.
//
// - Half-open detection: "ping" every 30 s, answered by the Hub's auto-response (does not wake the
//   Durable Object); no frame within 15 s => the socket is dropped and replaced.
// - Android background -> foreground: on `visible` (and `online`) an open socket is probed with a
//   5 s deadline; a missing socket is reconnected right away (unless the server asked us to wait).
// - While hidden, a dropped socket is NOT reconnected (no background reconnect loops on a phone);
//   it reconnects when the page is visible again.
// - Reconnect delays: shared/link.ts (first retry spread over a few seconds so a Worker deploy
//   doesn't make every phone reconnect at once; 4029 / 429 / 5xx hints only ever lengthen waits).
import {
  CLOSE_RATE_LIMITED,
  type Clock,
  Heartbeat,
  PHONE_RECONNECT,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  type ReconnectHints,
  reconnectDelay,
  retryHintFromText,
} from "@mcp-remote/shared/link";

export const WS_OPEN = 1;
export const WS_CONNECTING = 0;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

/** Result of the cheap /api/me check done before each reconnect (Worker only, no Durable Object). */
export type AuthCheck = "ok" | "signed_out" | ReconnectHints;

export interface PhoneLinkDeps {
  url: () => string;
  open: (url: string) => SocketLike;
  clock: Clock;
  random?: () => number;
  isVisible: () => boolean;
  checkAuth: () => Promise<AuthCheck>;
  onOpen: () => void;
  onFrame: (data: string) => void;
  /** The socket went away (a reconnect may follow). */
  onDown: () => void;
  /** Cookie gone / account no longer allowed: back to the sign-in screen. */
  onSignedOut: () => void;
}

export class PhoneLink {
  private ws: SocketLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  /** Do not reconnect before this time (server asked us to wait). */
  private notBefore = 0;
  private stopped = false;
  private readonly hb: Heartbeat;
  /** For tests / the status dot. */
  lastDelayMs: number | null = null;

  constructor(private readonly d: PhoneLinkDeps) {
    this.hb = new Heartbeat({
      clock: d.clock,
      intervalMs: PING_INTERVAL_MS,
      timeoutMs: PONG_TIMEOUT_MS,
      ping: () => this.sendRaw("ping"),
      onDead: () => this.drop(4000, "no answer to keepalive ping"),
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  send(data: string): boolean {
    return this.sendRaw(data);
  }

  /** Open now (first start, or the user is waiting). */
  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.hb.stop();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close(1000, "bye");
      } catch {
        /* ignore */
      }
    }
  }

  /** Page became visible, or the network came back. */
  wake(): void {
    if (this.stopped || !this.d.isVisible()) return;
    if (this.ws?.readyState === WS_OPEN) {
      // Android may have silently killed the socket while the page slept: find out quickly.
      this.hb.probe(PROBE_TIMEOUT_MS);
      return;
    }
    if (this.ws?.readyState === WS_CONNECTING) return;
    if (this.timer !== null && this.d.clock.now() < this.notBefore) return; // server asked us to wait
    this.clearTimer();
    this.attempt = 0;
    this.later(Math.max(0, this.notBefore - this.d.clock.now()));
  }

  private sendRaw(data: string): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    this.clearTimer();
    if (this.stopped) return;
    if (this.ws && (this.ws.readyState === WS_OPEN || this.ws.readyState === WS_CONNECTING)) return;
    const sock = this.d.open(this.d.url());
    this.ws = sock;
    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.attempt = 0;
      this.notBefore = 0;
      this.hb.start();
      this.d.onOpen();
    };
    sock.onmessage = (ev) => {
      if (this.ws !== sock) return;
      this.hb.received();
      const data = String(ev.data);
      if (data === "pong") return;
      this.d.onFrame(data);
    };
    sock.onclose = (ev) => {
      if (this.ws !== sock) return;
      this.closed(ev.code, ev.reason);
    };
  }

  /** Give up on a socket that stopped answering (it may sit in CLOSING for minutes otherwise). */
  private drop(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    ws.onopen = null;
    try {
      ws.close(1000, "replacing a dead connection");
    } catch {
      /* ignore */
    }
    this.closed(code, reason);
  }

  private closed(code: number, reason: string): void {
    this.ws = null;
    this.hb.stop();
    this.d.onDown();
    if (this.stopped) return;
    if (code === 1008 || code === 4401) {
      this.d.onSignedOut();
      return;
    }
    const hints: ReconnectHints = {};
    if (code === CLOSE_RATE_LIMITED) {
      hints.rateLimited = true;
      hints.retryAfterMs = retryHintFromText(reason);
    }
    this.schedule(hints);
  }

  private schedule(hints: ReconnectHints): void {
    const delay = reconnectDelay(this.attempt++, PHONE_RECONNECT, hints, this.d.random);
    if (hints.rateLimited || hints.retryAfterMs || hints.serverError) this.notBefore = this.d.clock.now() + delay;
    this.lastDelayMs = delay;
    if (!this.d.isVisible()) {
      // No reconnect loop in the background; wake() reconnects when the page is visible again.
      return;
    }
    this.later(delay);
  }

  private later(delay: number): void {
    this.clearTimer();
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    if (!this.d.isVisible()) return; // wake() picks it up
    // Cheap Worker-only check: signed out -> sign-in screen instead of a loop; 429/5xx -> wait longer.
    let auth: AuthCheck;
    try {
      auth = await this.d.checkAuth();
    } catch {
      auth = "ok"; // offline: the socket attempt fails and backs off normally
    }
    if (this.stopped) return;
    if (auth === "signed_out") {
      this.d.onSignedOut();
      return;
    }
    if (auth !== "ok") {
      this.schedule(auth);
      return;
    }
    this.connect();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.d.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
