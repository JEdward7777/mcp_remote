// PWA connection logic (web/link.ts) against fake sockets and a manual clock.
import { describe, expect, it } from "vitest";
import { type Clock, PHONE_RECONNECT, PING_INTERVAL_MS, PONG_TIMEOUT_MS, RATE_LIMITED_MIN_MS } from "@mcp-remote/shared/link";
import { type AuthCheck, PhoneLink, type SocketLike, WS_OPEN } from "../web/link";

class FakeClock implements Clock {
  t = 1_000_000;
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
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await flush();
    }
    this.t = end;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: [number?, string?] | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(d: string): void {
    this.sent.push(d);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
    this.readyState = 2; // CLOSING: a half-open socket may stay here for minutes
  }
  // server side helpers
  accept(): void {
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }
  frame(d: string): void {
    this.onmessage?.({ data: d });
  }
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function harness(opts: { auth?: () => AuthCheck | Promise<AuthCheck>; random?: () => number } = {}) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  let visible = true;
  const link = new PhoneLink({
    url: () => "wss://x/api/ws",
    open: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    clock,
    random: opts.random ?? (() => 0.5),
    isVisible: () => visible,
    checkAuth: async () => opts.auth?.() ?? "ok",
    onOpen: () => events.push("open"),
    onFrame: (d) => events.push(`frame:${d}`),
    onDown: () => events.push("down"),
    onSignedOut: () => events.push("signed_out"),
  });
  return {
    clock,
    sockets,
    events,
    link,
    setVisible: (v: boolean) => (visible = v),
    last: () => sockets[sockets.length - 1]!,
  };
}

describe("PhoneLink (PWA)", () => {
  it("pings, ignores pong, and replaces a half-open socket when no pong comes back", async () => {
    const h = harness();
    h.link.start();
    h.last().accept();
    await h.clock.advance(PING_INTERVAL_MS);
    expect(h.last().sent).toEqual(["ping"]);
    h.last().frame("pong");
    await h.clock.advance(PING_INTERVAL_MS);
    expect(h.events.filter((e) => e.startsWith("frame"))).toEqual([]);
    // Second ping is never answered: dropped after PONG_TIMEOUT_MS without waiting for onclose.
    const dead = h.last();
    await h.clock.advance(PONG_TIMEOUT_MS);
    expect(dead.closedWith).not.toBeNull();
    expect(h.events).toContain("down");
    await h.clock.advance(PHONE_RECONNECT.spreadMs);
    expect(h.sockets.length).toBe(2);
    // A late close event from the dead socket changes nothing.
    dead.serverClose(1006);
    expect(h.events.filter((e) => e === "down").length).toBe(1);
  });

  it("probes an open socket when the page comes back to the foreground", async () => {
    const h = harness();
    h.link.start();
    h.last().accept();
    h.setVisible(false);
    await h.clock.advance(10_000);
    h.setVisible(true);
    h.link.wake();
    expect(h.last().sent).toEqual(["ping"]);
    await h.clock.advance(5_000); // no answer within the 5 s probe deadline
    expect(h.events).toContain("down");
    await h.clock.advance(PHONE_RECONNECT.spreadMs);
    expect(h.sockets.length).toBe(2);
  });

  it("does not open a socket if the page went hidden while the reconnect's auth check was in flight (review round 1)", async () => {
    let release!: () => void;
    const h = harness({ auth: () => new Promise<AuthCheck>((r) => (release = () => r("ok"))) });
    h.link.start();
    h.last().accept();
    h.last().serverClose(1006);
    await h.clock.advance(PHONE_RECONNECT.spreadMs); // reconnect timer fires; checkAuth pending
    h.setVisible(false);
    release();
    await flush();
    expect(h.sockets.length).toBe(1);
    h.setVisible(true);
    h.link.wake();
    await h.clock.advance(1);
    release();
    await flush();
    expect(h.sockets.length).toBe(2);
  });

  it("does not reconnect while hidden, and reconnects at once when visible again", async () => {
    const h = harness();
    h.link.start();
    h.last().accept();
    h.setVisible(false);
    h.last().serverClose(1006);
    await h.clock.advance(10 * 60_000);
    expect(h.sockets.length).toBe(1); // no background loop
    h.setVisible(true);
    h.link.wake();
    await h.clock.advance(0);
    expect(h.sockets.length).toBe(2);
  });

  it("honors a 4029 close: waits the hinted time, even across a visibility change", async () => {
    const h = harness({ random: () => 0 });
    h.link.start();
    h.last().accept();
    h.last().serverClose(4029, "rate limited: too many requests; retry in 90s");
    h.link.wake(); // e.g. the user switches back to the tab
    await h.clock.advance(89_000);
    expect(h.sockets.length).toBe(1);
    await h.clock.advance(1_000);
    expect(h.sockets.length).toBe(2);
    expect(h.link.lastDelayMs).toBe(90_000);
  });

  it("a 4029 without a hint waits at least a minute", async () => {
    const h = harness({ random: () => 0 });
    h.link.start();
    h.last().accept();
    h.last().serverClose(4029, "");
    expect(h.link.lastDelayMs).toBe(RATE_LIMITED_MIN_MS);
  });

  it("spreads the first reconnect after a deploy-style drop, then backs off", async () => {
    const delays: number[] = [];
    for (const r of [0, 0.5, 1]) {
      const h = harness({ random: () => r });
      h.link.start();
      h.last().accept();
      h.last().serverClose(1012, "service restart");
      delays.push(h.link.lastDelayMs!);
    }
    expect(delays[0]).toBe(PHONE_RECONNECT.minMs);
    expect(delays[2]).toBe(PHONE_RECONNECT.spreadMs);
    // Failed attempts (never opened) grow.
    const h = harness({ random: () => 0 });
    h.link.start();
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.last().serverClose(1006);
      seen.push(h.link.lastDelayMs!);
      await h.clock.advance(seen[i]!);
    }
    expect(seen[1]!).toBeGreaterThan(seen[0]!);
    expect(seen[3]!).toBeGreaterThan(seen[2]!);
  });

  it("asks /api/me before reconnecting: signed out -> sign-in, 429/5xx -> wait longer", async () => {
    let answer: AuthCheck = { serverError: true };
    const h = harness({ auth: () => answer, random: () => 0 });
    h.link.start();
    h.last().accept();
    h.last().serverClose(1006);
    await h.clock.advance(PHONE_RECONNECT.spreadMs);
    expect(h.sockets.length).toBe(1); // 5xx: rescheduled, no socket
    expect(h.link.lastDelayMs).toBeGreaterThanOrEqual(5000);
    answer = "signed_out";
    await h.clock.advance(h.link.lastDelayMs!);
    expect(h.events).toContain("signed_out");
    expect(h.sockets.length).toBe(1);
  });

  it("1008 / 4401 closes go back to sign-in without a reconnect loop", async () => {
    const h = harness();
    h.link.start();
    h.last().accept();
    h.last().serverClose(1008, "policy");
    expect(h.events).toContain("signed_out");
    await h.clock.advance(60_000);
    expect(h.sockets.length).toBe(1);
  });
});
