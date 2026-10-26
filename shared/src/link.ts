/**
 * Client-side link hardening shared by the daemon and the PWA (Phase 3, D5):
 *
 * - Heartbeat: half-open detection. The client sends the literal text "ping"; the Hub's
 *   WebSocket auto-response answers "pong" WITHOUT waking the Durable Object. Any inbound frame
 *   counts as proof of life. If nothing arrives within `timeoutMs` after a ping, the link is dead.
 * - reconnectDelay: jittered backoff with a wide random spread on the first retry, so that a
 *   Worker deploy (which drops every socket at once) does not make every client reconnect in the
 *   same second, plus floors for "rate limited" and "server error" answers.
 *
 * No polling: the only periodic traffic is the keepalive ping, answered by the runtime.
 * Kept free of zod so the PWA bundle can import it on its own (`@mcp-remote/shared/link`).
 */

/** Keepalive interval for every client socket to the Hub. */
export const PING_INTERVAL_MS = 30_000;
/** No frame (not even the auto-response "pong") this long after a ping => half-open, reconnect. */
export const PONG_TIMEOUT_MS = 15_000;
/** Shorter deadline when the PWA comes back to the foreground and wants to know at once. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Close code the Hub uses when a client sent too many frames / connected too often. */
export const CLOSE_RATE_LIMITED = 4029;
/** Floor for the next reconnect after CLOSE_RATE_LIMITED or HTTP 429 without Retry-After. */
export const RATE_LIMITED_MIN_MS = 60_000;
/** Floor for the next reconnect after an HTTP 5xx from the Worker. */
export const SERVER_ERROR_MIN_MS = 5_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Timers of whatever runtime we are in (node, browser, workerd); shared/ has no DOM/node types. */
const timers = globalThis as unknown as {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
  clearTimeout: (h) => timers.clearTimeout(h),
};

export interface HeartbeatOptions {
  /** Send the "ping" text frame; return false if the socket is not open. */
  ping: () => boolean;
  /** Called once when the link is considered dead. The heartbeat stops itself first. */
  onDead: () => void;
  intervalMs?: number;
  timeoutMs?: number;
  clock?: Clock;
}

/**
 * Ping every `intervalMs`; after each ping, expect ANY inbound frame within `timeoutMs`.
 * Call `received()` for every inbound frame (including "pong").
 */
export class Heartbeat {
  private tick: unknown = null;
  private deadline: unknown = null;
  private deadlineAt = 0;
  private running = false;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HeartbeatOptions) {
    this.clock = opts.clock ?? realClock;
    this.intervalMs = opts.intervalMs ?? PING_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? PONG_TIMEOUT_MS;
  }

  start(): void {
    this.stop();
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.tick !== null) this.clock.clearTimeout(this.tick);
    if (this.deadline !== null) this.clock.clearTimeout(this.deadline);
    this.tick = null;
    this.deadline = null;
  }

  /** Any inbound frame: the link is alive. */
  received(): void {
    if (this.deadline !== null) {
      this.clock.clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  /** Ping now and expect an answer within `timeoutMs` (e.g. the page just became visible). */
  probe(timeoutMs = PROBE_TIMEOUT_MS): void {
    if (!this.running) return;
    this.sendPing(timeoutMs);
  }

  private schedule(): void {
    this.tick = this.clock.setTimeout(() => {
      this.tick = null;
      if (!this.running) return;
      this.sendPing(this.timeoutMs);
      if (this.running) this.schedule();
    }, this.intervalMs);
  }

  private sendPing(timeoutMs: number): void {
    if (!this.opts.ping()) return; // not open: the close handler takes over
    const at = this.clock.now() + timeoutMs;
    // Keep an earlier deadline if one is already pending.
    if (this.deadline !== null && this.deadlineAt <= at) return;
    if (this.deadline !== null) this.clock.clearTimeout(this.deadline);
    this.deadlineAt = at;
    this.deadline = this.clock.setTimeout(() => {
      this.deadline = null;
      if (!this.running) return;
      this.stop();
      this.opts.onDead();
    }, timeoutMs);
  }
}

export interface ReconnectProfile {
  /** Base of the exponential part (attempt >= 1). */
  baseMs: number;
  /** Cap of the exponential part. */
  capMs: number;
  /** First retry after losing a working connection: uniform in [minMs, spreadMs]. */
  spreadMs: number;
  minMs: number;
}

/** Daemons are unattended: spread wide, cap high. */
export const DAEMON_RECONNECT: ReconnectProfile = { baseMs: 2_000, capMs: 120_000, spreadMs: 15_000, minMs: 500 };
/** A visible PWA has a person waiting: reconnect quickly, but still spread. */
export const PHONE_RECONNECT: ReconnectProfile = { baseMs: 1_000, capMs: 30_000, spreadMs: 3_000, minMs: 250 };

export interface ReconnectHints {
  /** Server-requested wait (Retry-After / close reason), in ms. */
  retryAfterMs?: number | null;
  /** Rate limited without a usable Retry-After. */
  rateLimited?: boolean;
  /** HTTP 5xx from the Worker. */
  serverError?: boolean;
}

/**
 * Delay before reconnect attempt `attempt` (0 = first retry after a working connection dropped).
 *   attempt 0: uniform [minMs, spreadMs]  -> a mass disconnect (deploy) is spread over spreadMs
 *   attempt n: "equal jitter": e/2 + random(e/2), e = min(cap, base * 2^n)  -> grows for sure
 * Server hints only ever lengthen the delay, and get their own jitter so rate-limited clients
 * don't all return at the same instant.
 */
export function reconnectDelay(
  attempt: number,
  profile: ReconnectProfile,
  hints: ReconnectHints = {},
  random: () => number = Math.random,
): number {
  let d: number;
  if (attempt <= 0) {
    d = profile.minMs + random() * Math.max(0, profile.spreadMs - profile.minMs);
  } else {
    const e = Math.min(profile.capMs, profile.baseMs * 2 ** Math.min(attempt, 30));
    d = Math.max(profile.minMs, e / 2 + random() * (e / 2));
  }
  const jitter = () => random() * profile.spreadMs;
  if (hints.retryAfterMs && hints.retryAfterMs > 0) d = Math.max(d, hints.retryAfterMs + jitter());
  else if (hints.rateLimited) d = Math.max(d, RATE_LIMITED_MIN_MS + jitter());
  if (hints.serverError) d = Math.max(d, SERVER_ERROR_MIN_MS + jitter());
  return Math.floor(d);
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) to ms; null if absent/invalid. Capped at 1 day. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  let ms: number | null = null;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) ms = Math.max(0, t - now);
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return Math.min(ms, 86_400_000);
}

/** "retry in 42s" / "try again in 42s" in a close reason or error text -> ms. */
export function retryHintFromText(text: string | null | undefined): number | null {
  const m = text ? /(?:retry|try again) in (\d+)\s*s\b/i.exec(text) : null;
  return m ? Math.min(Number(m[1]) * 1000, 86_400_000) : null;
}

/** Human "in 42s" / "in 3 min" / "in 2 h" for user-facing errors. */
export function humanWait(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.ceil(m / 60)} h`;
}
