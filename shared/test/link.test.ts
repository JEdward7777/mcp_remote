import { describe, expect, it } from "vitest";
import {
  DAEMON_RECONNECT,
  Heartbeat,
  PHONE_RECONNECT,
  RATE_LIMITED_MIN_MS,
  SERVER_ERROR_MIN_MS,
  humanWait,
  parseRetryAfter,
  reconnectDelay,
  retryHintFromText,
  type Clock,
} from "../src/link";

/** Manual clock: timers fire only when the test advances time. */
export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.timers.delete(h as number);
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
    }
    this.t = end;
  }
  get pending(): number {
    return this.timers.size;
  }
}

describe("Heartbeat", () => {
  it("pings every interval and declares the link dead when nothing answers", () => {
    const clock = new FakeClock();
    let pings = 0;
    let dead = 0;
    const hb = new Heartbeat({ clock, intervalMs: 30_000, timeoutMs: 15_000, ping: () => (pings++, true), onDead: () => dead++ });
    hb.start();
    clock.advance(29_999);
    expect(pings).toBe(0);
    clock.advance(1);
    expect(pings).toBe(1);
    clock.advance(14_999);
    expect(dead).toBe(0);
    clock.advance(1);
    expect(dead).toBe(1);
    // Stopped itself: no more pings, no second onDead.
    clock.advance(120_000);
    expect(pings).toBe(1);
    expect(dead).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("any inbound frame (pong or data) keeps the link alive", () => {
    const clock = new FakeClock();
    let dead = 0;
    let pings = 0;
    const hb = new Heartbeat({ clock, intervalMs: 30_000, timeoutMs: 15_000, ping: () => (pings++, true), onDead: () => dead++ });
    hb.start();
    for (let i = 0; i < 10; i++) {
      clock.advance(30_000);
      clock.advance(200);
      hb.received(); // the "pong"
    }
    expect(pings).toBe(10);
    expect(dead).toBe(0);
    hb.stop();
    expect(clock.pending).toBe(0);
  });

  it("probe() pings at once with a short deadline (page back in the foreground)", () => {
    const clock = new FakeClock();
    let dead = 0;
    let pings = 0;
    const hb = new Heartbeat({ clock, intervalMs: 30_000, timeoutMs: 15_000, ping: () => (pings++, true), onDead: () => dead++ });
    hb.start();
    clock.advance(1000);
    hb.probe(5000);
    expect(pings).toBe(1);
    clock.advance(5000);
    expect(dead).toBe(1);
  });

  it("does not arm a deadline when the socket is not open", () => {
    const clock = new FakeClock();
    let dead = 0;
    const hb = new Heartbeat({ clock, intervalMs: 1000, timeoutMs: 500, ping: () => false, onDead: () => dead++ });
    hb.start();
    clock.advance(10_000);
    expect(dead).toBe(0);
    hb.stop();
  });
});

describe("reconnectDelay", () => {
  it("spreads a mass disconnect (deploy) over the spread window instead of one second", () => {
    // 1000 daemons dropped at the same instant: count how many come back in any 1 s window.
    const delays = Array.from({ length: 1000 }, () => reconnectDelay(0, DAEMON_RECONNECT));
    const min = Math.min(...delays);
    const max = Math.max(...delays);
    expect(min).toBeGreaterThanOrEqual(DAEMON_RECONNECT.minMs);
    expect(max).toBeLessThanOrEqual(DAEMON_RECONNECT.spreadMs);
    const perSecond = new Map<number, number>();
    for (const d of delays) perSecond.set(Math.floor(d / 1000), (perSecond.get(Math.floor(d / 1000)) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThan(150); // ~1000/15 expected; was all 1000 in ~1 s before
    for (let i = 0; i < 100; i++) expect(reconnectDelay(0, PHONE_RECONNECT)).toBeLessThanOrEqual(PHONE_RECONNECT.spreadMs);
  });

  it("grows with every failed attempt (equal jitter) up to the cap", () => {
    const lo = (a: number) => reconnectDelay(a, DAEMON_RECONNECT, {}, () => 0);
    const hi = (a: number) => reconnectDelay(a, DAEMON_RECONNECT, {}, () => 0.999999);
    expect(lo(1)).toBe(2000);
    expect(hi(1)).toBe(3999);
    expect(lo(3)).toBe(8000);
    expect(lo(2)).toBeGreaterThan(hi(1) - 1);
    expect(lo(20)).toBe(DAEMON_RECONNECT.capMs / 2);
    expect(hi(20)).toBeLessThanOrEqual(DAEMON_RECONNECT.capMs);
  });

  it("server hints only lengthen the wait and carry their own jitter", () => {
    expect(reconnectDelay(0, PHONE_RECONNECT, { retryAfterMs: 42_000 }, () => 0)).toBe(42_000);
    expect(reconnectDelay(0, PHONE_RECONNECT, { retryAfterMs: 42_000 }, () => 0.5)).toBe(42_000 + PHONE_RECONNECT.spreadMs / 2);
    expect(reconnectDelay(0, PHONE_RECONNECT, { rateLimited: true }, () => 0)).toBe(RATE_LIMITED_MIN_MS);
    expect(reconnectDelay(0, PHONE_RECONNECT, { serverError: true }, () => 0)).toBe(SERVER_ERROR_MIN_MS);
    // A long backoff is not shortened by a small hint.
    expect(reconnectDelay(10, DAEMON_RECONNECT, { retryAfterMs: 1000 }, () => 0)).toBe(60_000);
  });
});

describe("hint parsing", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("7")).toBe(7000);
    expect(parseRetryAfter(" 120 ")).toBe(120_000);
    const now = Date.UTC(2026, 0, 1);
    expect(parseRetryAfter(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("99999999")).toBe(86_400_000);
  });

  it("reads 'retry in Ns' / 'try again in Ns' from reasons and errors", () => {
    expect(retryHintFromText("rate limited: too many requests; retry in 9s")).toBe(9000);
    expect(retryHintFromText("rate limited: too many messages; try again in 12s")).toBe(12_000);
    expect(retryHintFromText("try again in 3 min")).toBeNull();
    expect(retryHintFromText(undefined)).toBeNull();
  });

  it("formats waits for people", () => {
    expect(humanWait(400)).toBe("1s");
    expect(humanWait(42_000)).toBe("42s");
    expect(humanWait(5 * 60_000)).toBe("5 min");
    expect(humanWait(5 * 3600_000)).toBe("5 h");
  });
});
