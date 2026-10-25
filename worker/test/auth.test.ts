import { describe, expect, it } from "vitest";
import {
  makeSessionCookieValue,
  mintMachineToken,
  parseCookies,
  signBlob,
  tenantIdForGoogle,
  verifyBlob,
  verifyMachineToken,
  verifySessionCookieValue,
} from "../src/auth";
import { b64urlDecode, b64urlEncode, hmacSign, hmacVerify } from "../src/crypto";

const SECRET = "unit-test-secret-0123456789-0123456789";

describe("crypto", () => {
  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect([...b64urlDecode(b64urlEncode(bytes))]).toEqual([...bytes]);
    expect(b64urlEncode("??>>")).not.toMatch(/[+/=]/);
    expect(() => b64urlDecode("not base64!")).toThrow();
  });

  it("separates HMAC purposes", async () => {
    const sig = await hmacSign(SECRET, "a", "data");
    expect(await hmacVerify(SECRET, "a", "data", sig)).toBe(true);
    expect(await hmacVerify(SECRET, "b", "data", sig)).toBe(false);
    expect(await hmacVerify(SECRET, "a", "datA", sig)).toBe(false);
    expect(await hmacVerify("other-secret-0123456789-0123456789", "a", "data", sig)).toBe(false);
  });
});

describe("session cookie", () => {
  it("round-trips", async () => {
    const v = await makeSessionCookieValue(SECRET, { tid: "g-123", email: "a@b.c", name: "A" });
    const c = await verifySessionCookieValue(SECRET, v);
    expect(c).toMatchObject({ tid: "g-123", email: "a@b.c", name: "A" });
  });

  it("rejects tampering, wrong secret and expiry", async () => {
    const now = Date.now();
    const v = await makeSessionCookieValue(SECRET, { tid: "g-123", email: "a@b.c" }, now);
    const [ver, payload, sig] = v.split(".");
    const forged = b64urlEncode(JSON.stringify({ tid: "g-999", email: "x@y.z", iat: 0, exp: 9e9 }));
    expect(await verifySessionCookieValue(SECRET, `${ver}.${forged}.${sig}`)).toBeNull();
    expect(await verifySessionCookieValue(SECRET, `${ver}.${payload}.${sig}x`)).toBeNull();
    expect(await verifySessionCookieValue("another-secret-0123456789-0123456789", v)).toBeNull();
    expect(await verifySessionCookieValue(SECRET, v, now + 31 * 24 * 3600 * 1000)).toBeNull();
    expect(await verifySessionCookieValue(SECRET, "garbage")).toBeNull();
  });

  it("does not accept a blob signed for another purpose (e.g. the OAuth state cookie)", async () => {
    const blob = await signBlob(SECRET, "oauth-pending", { tid: "g-1", email: "a@b.c", iat: 0, exp: 9e9 });
    expect(await verifySessionCookieValue(SECRET, blob)).toBeNull();
    expect(await verifyBlob(SECRET, "oauth-pending", blob)).toMatchObject({ tid: "g-1" });
  });
});

describe("machine token", () => {
  it("encodes tenant + machine and verifies", async () => {
    const t = await mintMachineToken(SECRET, "g-123456", "m_abc-1");
    expect(t.startsWith("mrm1.")).toBe(true);
    expect(await verifyMachineToken(SECRET, t)).toEqual({ tid: "g-123456", machineId: "m_abc-1" });
  });

  it("rejects re-targeting to another tenant or machine", async () => {
    const t = await mintMachineToken(SECRET, "g-1", "m1");
    const p = t.split(".");
    const other = [p[0], b64urlEncode("g-2"), p[2], p[3], p[4]].join(".");
    expect(await verifyMachineToken(SECRET, other)).toBeNull();
    const otherMachine = [p[0], p[1], "m2", p[3], p[4]].join(".");
    expect(await verifyMachineToken(SECRET, otherMachine)).toBeNull();
    expect(await verifyMachineToken("x".repeat(40), t)).toBeNull();
    expect(await verifyMachineToken(SECRET, "mrm1.a.b.c")).toBeNull();
  });

  it("is unique per mint", async () => {
    const a = await mintMachineToken(SECRET, "g-1", "m1");
    const b = await mintMachineToken(SECRET, "g-1", "m1");
    expect(a).not.toBe(b);
  });
});

describe("misc", () => {
  it("parses cookies", () => {
    const m = parseCookies("a=1; __Host-mr_session=v1.x.y; b = 2");
    expect(m.get("__Host-mr_session")).toBe("v1.x.y");
    expect(m.get("b")).toBe("2");
  });

  it("derives tenant ids from Google sub", () => {
    expect(tenantIdForGoogle("1234567890")).toBe("g-1234567890");
    expect(() => tenantIdForGoogle("a.b")).toThrow();
  });
});
