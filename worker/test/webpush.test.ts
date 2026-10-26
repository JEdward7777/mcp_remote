// Web Push primitives (RFC 8291 encryption, RFC 8292 VAPID), inside workerd's WebCrypto.
import { describe, expect, it } from "vitest";
import {
  MAX_PUSH_PLAINTEXT,
  PushPayloadTooLarge,
  b64uDecode,
  b64uEncode,
  buildPushRequest,
  checkEndpoint,
  checkSubscription,
  classifyPushResponse,
  encryptPushPayload,
  importVapidKeys,
  messagePush,
  previewText,
  pushOptionsFor,
  vapidJwt,
  verifyVapidJwt,
} from "../src/webpush";
import { TEST_VAPID } from "./push-helpers";

// RFC 8291 Section 5 and Appendix A (example "When I grow up, I want to be a watermelon"). The values
// were copied from the webpush-wg draft source (draft-ietf-webpush-encryption-latest, the text that
// became RFC 8291; rfc-editor.org was not reachable from the build environment).
const V = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function ecdhPair(pubB64: string, privB64: string): Promise<CryptoKeyPair> {
  const pub = b64uDecode(pubB64);
  const jwk = { kty: "EC", crv: "P-256", x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33)), d: privB64 };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

/** Receiver side of RFC 8291 (what the browser does), to round-trip our own output. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, uaPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, ua.privateKey, 256));
  const hmac = async (k: Uint8Array, d: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const cat = (...p: Uint8Array[]) => {
    const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let i = 0;
    for (const x of p) (o.set(x, i), (i += x.length));
    return o;
  };
  const te = new TextEncoder();
  const ikm = await hmac(await hmac(auth, secret), cat(te.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("RFC 8291 message encryption", () => {
  it("reproduces the RFC 8291 example body byte for byte", async () => {
    const out = await encryptPushPayload(new TextEncoder().encode(V.plaintext), b64uDecode(V.uaPublic), b64uDecode(V.auth), {
      salt: b64uDecode(V.salt),
      asKeyPair: await ecdhPair(V.asPublic, V.asPrivate),
    });
    expect(b64uEncode(out)).toBe(V.body);
    expect(out.length).toBe(144); // 86-byte header + 41 + 1 + 16
  });

  it("round-trips with a fresh sender key and salt, and the receiver (user agent) can decrypt it", async () => {
    const ua = await ecdhPair(V.uaPublic, V.uaPrivate);
    const msg = "héllo \u{1F30D} ".repeat(20);
    const a = await encryptPushPayload(new TextEncoder().encode(msg), b64uDecode(V.uaPublic), b64uDecode(V.auth));
    const b = await encryptPushPayload(new TextEncoder().encode(msg), b64uDecode(V.uaPublic), b64uDecode(V.auth));
    expect(b64uEncode(a)).not.toBe(b64uEncode(b)); // random salt + ephemeral key every time
    expect(await decrypt(a, ua, b64uDecode(V.uaPublic), b64uDecode(V.auth))).toBe(msg);
    expect(new DataView(a.buffer).getUint32(16)).toBe(4096);
  });

  it("enforces the one-record size limit (3993 bytes of plaintext) and rejects bad keys", async () => {
    const ua = b64uDecode(V.uaPublic);
    const auth = b64uDecode(V.auth);
    const max = await encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT), ua, auth);
    expect(max.length).toBe(4096);
    await expect(encryptPushPayload(new Uint8Array(MAX_PUSH_PLAINTEXT + 1), ua, auth)).rejects.toBeInstanceOf(PushPayloadTooLarge);
    await expect(encryptPushPayload(new Uint8Array(1), ua.slice(1), auth)).rejects.toThrow(/65-byte/);
    await expect(encryptPushPayload(new Uint8Array(1), ua, auth.slice(1))).rejects.toThrow(/16 bytes/);
    const offCurve = ua.slice();
    offCurve[64] = offCurve[64]! ^ 1;
    await expect(encryptPushPayload(new Uint8Array(1), offCurve, auth)).rejects.toThrow();
  });
});

describe("VAPID (RFC 8292)", () => {
  it("accepts the RFC 8292 example token with its key (JWS r||s signature format, base64url)", async () => {
    const t =
      "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0." +
      "i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
    const k = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
    expect(await verifyVapidJwt(t, k)).toEqual({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
    expect(await verifyVapidJwt(t.replace("i3CYb7", "i3CYb8"), k)).toBeNull();
  });

  it("signs a JWT for the push service origin that verifies with the public key, cached per audience", async () => {
    const keys = await importVapidKeys(TEST_VAPID.publicKey, TEST_VAPID.privateKey);
    const now = 1_800_000_000;
    const jwt = await vapidJwt(keys, "https://fcm.googleapis.com", "mailto:me@example.com", now);
    const [h] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = await verifyVapidJwt(jwt, TEST_VAPID.publicKey);
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: now + 12 * 3600, sub: "mailto:me@example.com" });
    expect(await vapidJwt(keys, "https://fcm.googleapis.com", "mailto:me@example.com", now + 60)).toBe(jwt);
    // Within an hour of expiry a new one is made; exp never exceeds 24 h (RFC 8292).
    const later = await vapidJwt(keys, "https://fcm.googleapis.com", "mailto:me@example.com", now + 11.5 * 3600);
    expect(later).not.toBe(jwt);
  });

  it("refuses a private key that does not belong to the public key", async () => {
    const other = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    await expect(importVapidKeys(TEST_VAPID.publicKey, other)).rejects.toThrow();
    await expect(importVapidKeys("AAAA", TEST_VAPID.privateKey)).rejects.toThrow(/65-byte/);
  });

  it("builds the RFC 8030 request: aes128gcm body, TTL, Urgency, vapid authorization", async () => {
    const keys = await importVapidKeys(TEST_VAPID.publicKey, TEST_VAPID.privateKey);
    const req = await buildPushRequest(
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: V.uaPublic, auth: V.auth },
      { k: "m", s: "sess", u: "urgent", i: 1 },
      { keys, subject: "https://x.workers.dev", ttl: 60, urgency: "high" },
    );
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-encoding")).toBe("aes128gcm");
    expect(req.headers.get("ttl")).toBe("60");
    expect(req.headers.get("urgency")).toBe("high");
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.get("authorization") ?? "");
    expect(m?.[2]).toBe(TEST_VAPID.publicKey);
    expect((await verifyVapidJwt(m![1]!, TEST_VAPID.publicKey))?.aud).toBe("https://fcm.googleapis.com");
    const body = new Uint8Array(await req.arrayBuffer());
    const json = await decrypt(body, await ecdhPair(V.uaPublic, V.uaPrivate), b64uDecode(V.uaPublic), b64uDecode(V.auth));
    expect(JSON.parse(json)).toEqual({ k: "m", s: "sess", u: "urgent", i: 1 });
  });
});

describe("push policy helpers", () => {
  it("maps agent urgency to push behavior: silent = no push, normal = normal, urgent = high", () => {
    expect(pushOptionsFor("silent")).toBeNull();
    expect(pushOptionsFor("normal")).toEqual({ urgency: "normal", ttl: 21600 });
    expect(pushOptionsFor("urgent")).toEqual({ urgency: "high", ttl: 86400 });
  });

  it("previews at most 100 characters (whole code points) and only when allowed", () => {
    expect(previewText("  a\n\nb  ")).toBe("a b");
    const long = "\u{1F600}".repeat(150);
    const p = previewText(long);
    expect(Array.from(p).length).toBe(100);
    expect(p.endsWith("…")).toBe(true);
    const m = { session_id: "s1", id: 7, text: "secret plan ".repeat(50), urgency: "normal" as const, project: "proj" };
    expect(messagePush(m, false)).toEqual({ k: "m", s: "s1", u: "normal", i: 7 });
    const withPreview = messagePush(m, true);
    expect(withPreview.p).toBe("proj");
    expect(Array.from(withPreview.b!).length).toBeLessThanOrEqual(100);
    // A worst-case payload (long project name, 100 emoji) is far below one record.
    const worst = JSON.stringify(messagePush({ ...m, project: "\u{1F600}".repeat(128), text: long, session_id: "x".repeat(64) }, true));
    expect(new TextEncoder().encode(worst).length).toBeLessThan(1000);
  });

  it("classifies push service answers: 404/410 delete, 429/5xx wait (never retried), other 4xx drop", () => {
    expect(classifyPushResponse(201, null)).toEqual({ kind: "ok", status: 201 });
    expect(classifyPushResponse(410, null).kind).toBe("gone");
    expect(classifyPushResponse(404, null).kind).toBe("gone");
    expect(classifyPushResponse(429, "120")).toEqual({ kind: "later", status: 429, retryAfterMs: 120_000 });
    expect(classifyPushResponse(503, null)).toEqual({ kind: "later", status: 503, retryAfterMs: 60_000 });
    expect(classifyPushResponse(429, "999999").kind === "later" && classifyPushResponse(429, "999999")).toMatchObject({ retryAfterMs: 3_600_000 });
    expect(classifyPushResponse(403, null).kind).toBe("rejected");
    expect(classifyPushResponse(413, null).kind).toBe("rejected");
  });

  it("only accepts endpoints of known push services (no SSRF), https, no credentials", async () => {
    expect(checkEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBeNull();
    expect(checkEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBeNull();
    expect(checkEndpoint("https://web.push.apple.com/x")).toBeNull();
    expect(checkEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBeNull();
    expect(checkEndpoint("https://evil.example/fcm")).toMatch(/not a known Web Push service/);
    expect(checkEndpoint("https://fcm.googleapis.com.evil.example/x")).toMatch(/not a known/);
    expect(checkEndpoint("http://fcm.googleapis.com/x")).toMatch(/https/);
    expect(checkEndpoint("https://fcm.googleapis.com:8443/x")).toMatch(/https/);
    expect(checkEndpoint("https://u:p@fcm.googleapis.com/x")).toMatch(/credentials/);
    expect(checkEndpoint("https://fcm.googleapis.com/" + "x".repeat(1100))).toMatch(/at most/);
    expect(checkEndpoint("http://127.0.0.1:9/x")).toMatch(/https/);
    expect(checkEndpoint("http://127.0.0.1:9/x", ["http://127.0.0.1:9"])).toBeNull();
    const ok = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: V.uaPublic, auth: V.auth };
    expect(await checkSubscription(ok)).toBeNull();
    expect(await checkSubscription({ ...ok, auth: "AAAA" })).toMatch(/16 bytes/);
    expect(await checkSubscription({ ...ok, p256dh: "!!" })).toMatch(/base64url/);
    const bad = b64uDecode(V.uaPublic);
    bad[64] = bad[64]! ^ 1;
    expect(await checkSubscription({ ...ok, p256dh: b64uEncode(bad) })).toMatch(/not a valid P-256 point/);
  });
});
