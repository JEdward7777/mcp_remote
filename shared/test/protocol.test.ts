import { describe, expect, it } from "vitest";
import {
  DaemonToHub,
  HubToPhone,
  MAX_FRAME_BYTES,
  MAX_TEXT_CHARS,
  PhoneToHub,
  ShimToDaemon,
  backoffDelay,
  byteLength,
  parseFrame,
} from "../src/index";

describe("parseFrame", () => {
  it("accepts a valid phone send frame", () => {
    const r = parseFrame(PhoneToHub, JSON.stringify({ t: "send", session_id: "sess-a", text: "hi" }));
    expect(r).toEqual({ ok: true, value: { t: "send", session_id: "sess-a", text: "hi" } });
  });

  it("rejects invalid JSON, unknown types and binary frames", () => {
    expect(parseFrame(PhoneToHub, "{nope").ok).toBe(false);
    expect(parseFrame(PhoneToHub, JSON.stringify({ t: "launch_missiles" })).ok).toBe(false);
    expect(parseFrame(PhoneToHub, new ArrayBuffer(4)).ok).toBe(false);
  });

  it("rejects frames over MAX_FRAME_BYTES, counting UTF-8 bytes", () => {
    const big = JSON.stringify({ t: "send", session_id: "s", text: "x".repeat(MAX_FRAME_BYTES) });
    expect(parseFrame(PhoneToHub, big)).toEqual({ ok: false, error: "frame too large" });
    // 30k 3-byte chars = 90 KB even though .length is ~30k
    const wide = JSON.stringify({ t: "send", session_id: "s", text: "€".repeat(30_000) });
    expect(wide.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(parseFrame(PhoneToHub, wide)).toEqual({ ok: false, error: "frame too large" });
  });

  it("enforces text limits and non-blank text", () => {
    const long = { t: "send", session_id: "s", text: "x".repeat(MAX_TEXT_CHARS + 1) };
    expect(parseFrame(PhoneToHub, JSON.stringify(long)).ok).toBe(false);
    expect(parseFrame(PhoneToHub, JSON.stringify({ t: "send", session_id: "s", text: "   " })).ok).toBe(false);
  });

  it("restricts session ids to identifier-ish characters", () => {
    for (const bad of ["", "a b", "../x", "x".repeat(65), "a.b"]) {
      expect(parseFrame(PhoneToHub, JSON.stringify({ t: "send", session_id: bad, text: "hi" })).ok).toBe(false);
    }
  });

  it("only allows the three urgency levels", () => {
    const f = (urgency: string) =>
      parseFrame(DaemonToHub, JSON.stringify({ t: "send", req_id: "r1", session_id: "s", text: "t", urgency }));
    expect(f("silent").ok).toBe(true);
    expect(f("normal").ok).toBe(true);
    expect(f("urgent").ok).toBe(true);
    expect(f("panic").ok).toBe(false);
  });

  it("validates hello and ack frames", () => {
    expect(parseFrame(DaemonToHub, JSON.stringify({ t: "hello", v: 1, sessions: [] })).ok).toBe(true);
    expect(parseFrame(DaemonToHub, JSON.stringify({ t: "hello", v: 2, sessions: [] })).ok).toBe(false);
    expect(parseFrame(DaemonToHub, JSON.stringify({ t: "ack", session_id: "s", ids: [] })).ok).toBe(false);
    expect(
      parseFrame(ShimToDaemon, JSON.stringify({ t: "register", v: 1, session: { session_id: "s", project: "p" } })).ok,
    ).toBe(true);
  });

  it("parses hub->phone state frames", () => {
    const r = parseFrame(HubToPhone, JSON.stringify({ t: "state", machines: [], sessions: [] }));
    expect(r.ok).toBe(true);
  });
});

describe("byteLength", () => {
  it("matches UTF-8 encoding", () => {
    const cases: [string, number][] = [
      ["", 0],
      ["abc", 3],
      ["é", 2],
      ["€", 3],
      ["\u{1F600}", 4],
      ["a\u{1F600}bé", 8],
      ["\ud800", 3], // lone surrogate is encoded as U+FFFD (3 bytes)
    ];
    for (const [s, n] of cases) expect(byteLength(s)).toBe(n);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially, is capped and jittered", () => {
    expect(backoffDelay(0, { random: () => 0.999, baseMs: 1000, minMs: 0 })).toBe(999);
    expect(backoffDelay(3, { random: () => 0.999, baseMs: 1000, minMs: 0 })).toBe(7992);
    expect(backoffDelay(50, { random: () => 0.999, baseMs: 1000, capMs: 30_000, minMs: 0 })).toBe(29_970);
    expect(backoffDelay(5, { random: () => 0, minMs: 250 })).toBe(250);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(i % 20, { capMs: 60_000 });
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });
});
