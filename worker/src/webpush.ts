// Web Push from the Worker / Hub with WebCrypto only (D5, D19): no third-party push service, no npm
// dependency. Implements
//   RFC 8291  Message Encryption for Web Push (aes128gcm, RFC 8188 content coding, one record)
//   RFC 8292  VAPID (ES256 JWT in "Authorization: vapid t=..., k=...")
//   RFC 8030  the push request itself (TTL, Urgency headers)
// Tested against the RFC 8291 example (Section 5 / Appendix A) and the RFC 8292 example JWT.

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// base64url

export function b64uEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url (also accepts standard base64 and padding, as browsers' toJSON may vary). Throws on garbage. */
export function b64uDecode(s: string): Uint8Array {
  const t = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(t)) throw new Error("not base64url");
  const std = t.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF-SHA-256 with one block of output (all lengths here are <= 32). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

// ---------------------------------------------------------------------------
// RFC 8291 payload encryption

/** Record size we declare (RFC 8291: one record; push services must accept 4096-byte bodies). */
export const PUSH_RECORD_SIZE = 4096;
/** salt(16) + rs(4) + idlen(1) + keyid(65). */
const HEADER_BYTES = 86;
/** 4096-byte body - header - 16-byte AES-GCM tag - 1 delimiter octet = 3993 bytes of plaintext (RFC 8291 Section 4). */
export const MAX_PUSH_PLAINTEXT = PUSH_RECORD_SIZE - HEADER_BYTES - 16 - 1;

export interface EncryptOptions {
  /** Fixed salt / sender key pair: test vectors only. Normally both are random per message. */
  salt?: Uint8Array;
  asKeyPair?: CryptoKeyPair;
}

export class PushPayloadTooLarge extends Error {}

/**
 * Encrypt `plaintext` for one subscription (`uaPublic` = keys.p256dh, 65-byte uncompressed P-256
 * point; `authSecret` = keys.auth, 16 bytes). Returns the aes128gcm body (header + one record).
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PUSH_PLAINTEXT) {
    throw new PushPayloadTooLarge(`push payload is ${plaintext.length} bytes; at most ${MAX_PUSH_PLAINTEXT} fit one record`);
  }
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");
  // Importing the point validates that it is on the curve (RFC 8291 Section 7).
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as =
    opts.asKeyPair ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, as.privateKey, 256),
  );
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // Single (last) record: plaintext || 0x02, no padding.
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, concat(plaintext, new Uint8Array([2]))),
  );
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, PUSH_RECORD_SIZE);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, record);
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)

export interface VapidKeys {
  /** Uncompressed public key, base64url (the `k` parameter and the browser's applicationServerKey). */
  publicKey: string;
  privateKey: CryptoKey;
}

const vapidCache = new Map<string, Promise<VapidKeys>>();

/**
 * Import VAPID_PUBLIC_KEY (base64url, 65 bytes) + VAPID_PRIVATE_KEY (base64url, the 32-byte scalar d),
 * the format `npm run vapid` (and most Web Push libraries) print. Checks that they belong together.
 */
export function importVapidKeys(publicB64u: string, privateB64u: string): Promise<VapidKeys> {
  const k = `${publicB64u}|${privateB64u}`;
  let p = vapidCache.get(k);
  if (!p) {
    p = importVapidKeysUncached(publicB64u, privateB64u);
    p.catch(() => vapidCache.delete(k));
    if (vapidCache.size > 4) vapidCache.clear();
    vapidCache.set(k, p);
  }
  return p;
}

async function importVapidKeysUncached(publicB64u: string, privateB64u: string): Promise<VapidKeys> {
  const pub = b64uDecode(publicB64u.trim());
  const d = b64uDecode(privateB64u.trim());
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be a base64url 65-byte uncompressed P-256 public key");
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY must be a base64url 32-byte P-256 private key");
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64uEncode(pub.slice(1, 33)),
    y: b64uEncode(pub.slice(33, 65)),
    d: b64uEncode(d),
    ext: false,
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Make sure the pair matches (a mismatch would make every push service answer 401/403).
  const verifyKey = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const probe = enc.encode("vapid key check");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, probe);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, sig, probe))) {
    throw new Error("VAPID_PRIVATE_KEY does not match VAPID_PUBLIC_KEY");
  }
  return { publicKey: b64uEncode(pub), privateKey };
}

/** JWT lifetime; RFC 8292 caps `exp` at 24 h. Re-used per push service origin until 1 h before expiry. */
export const VAPID_JWT_TTL_S = 12 * 3600;
const jwtCache = new Map<string, { jwt: string; exp: number }>();

/** Signed ES256 JWT for `audience` (the push service origin). WebCrypto ECDSA already yields JWS r||s. */
export async function vapidJwt(keys: VapidKeys, audience: string, subject: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${keys.publicKey}|${audience}|${subject}`;
  const hit = jwtCache.get(cacheKey);
  if (hit && hit.exp - nowS > 3600) return hit.jwt;
  const exp = nowS + VAPID_JWT_TTL_S;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const input = `${header}.${body}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, enc.encode(input));
  const jwt = `${input}.${b64uEncode(sig)}`;
  if (jwtCache.size > 64) jwtCache.clear();
  jwtCache.set(cacheKey, { jwt, exp });
  return jwt;
}

/** Verify a VAPID JWT with its `k` key (tests; push services do this). */
export async function verifyVapidJwt(jwt: string, publicB64u: string): Promise<Record<string, unknown> | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const key = await crypto.subtle.importKey("raw", b64uDecode(publicB64u), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64uDecode(parts[2]!),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;
  return JSON.parse(new TextDecoder().decode(b64uDecode(parts[1]!))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Subscriptions

/**
 * Push services the Hub will POST to. Browsers hand out endpoints on these hosts (Chrome/Android: FCM;
 * Firefox: Mozilla autopush; Safari: Apple; Edge: WNS). Anything else is refused at subscribe time, so
 * a signed-in user can't make our Worker send requests to arbitrary URLs (SSRF).
 */
export const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
] as const;

export const MAX_ENDPOINT_CHARS = 1024;

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Endpoint check; `extraOrigins` (exact origins, local testing only) may add e.g. http://127.0.0.1:8123. */
export function checkEndpoint(endpoint: string, extraOrigins: readonly string[] = []): string | null {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT_CHARS) return `endpoint must be at most ${MAX_ENDPOINT_CHARS} characters`;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  if (u.username || u.password) return "endpoint must not contain credentials";
  if (extraOrigins.includes(u.origin)) return null;
  if (u.protocol !== "https:" || (u.port !== "" && u.port !== "443")) return "endpoint must be an https URL";
  const host = u.hostname.toLowerCase();
  if (!PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return `endpoint host ${host} is not a known Web Push service`;
  }
  return null;
}

/** Validate a browser's PushSubscription JSON (endpoint + keys). Returns an error sentence or null. */
export async function checkSubscription(s: PushSubscriptionInput, extraOrigins: readonly string[] = []): Promise<string | null> {
  const e = checkEndpoint(s.endpoint, extraOrigins);
  if (e) return e;
  let pub: Uint8Array;
  let auth: Uint8Array;
  try {
    pub = b64uDecode(s.p256dh);
    auth = b64uDecode(s.auth);
  } catch {
    return "keys must be base64url";
  }
  if (auth.length !== 16) return "keys.auth must be 16 bytes";
  if (pub.length !== 65 || pub[0] !== 4) return "keys.p256dh must be a 65-byte uncompressed P-256 point";
  try {
    await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    return "keys.p256dh is not a valid P-256 point";
  }
  return null;
}

/** Short stable id of a subscription (first 16 hex chars of sha256(endpoint)); also shown to the phone. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(endpoint)));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Payloads (what the service worker shows) and urgency mapping (D19)

export type AgentUrgency = "silent" | "normal" | "urgent";

/** Notification text preview length (characters). */
export const PREVIEW_CHARS = 100;

/** RFC 8030 push options per agent urgency; null = no push at all (silent stays in the app). */
export function pushOptionsFor(u: AgentUrgency): { urgency: "normal" | "high"; ttl: number } | null {
  if (u === "silent") return null;
  // A normal message is still worth seeing a few hours later; an urgent one for a day.
  return u === "urgent" ? { urgency: "high", ttl: 24 * 3600 } : { urgency: "normal", ttl: 6 * 3600 };
}

/** First `n` characters (whole code points), whitespace collapsed, with an ellipsis when cut. */
export function previewText(text: string, n = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cps = Array.from(flat);
  return cps.length <= n ? flat : `${cps.slice(0, n - 1).join("").trimEnd()}…`;
}

/** Payload of a message push. Without preview, nothing about the content or the project is included. */
export interface MessagePush {
  k: "m";
  /** session id (opens its thread) */
  s: string;
  u: "normal" | "urgent";
  /** message id */
  i: number;
  /** project name (preview only) */
  p?: string;
  /** first PREVIEW_CHARS characters (preview only) */
  b?: string;
}

/**
 * Payload of a location request push: the click opens the app, which shares once and answers rid with
 * the request's random token `t` (only a tap on this notification, or Share in the app, answers it).
 */
export interface LocationPush {
  k: "l";
  r: string;
  t: string;
  s: string;
  p?: string;
  b?: string;
}

export type PushPayload = MessagePush | LocationPush;

export function messagePush(m: { session_id: string; id: number; text: string; urgency: "normal" | "urgent"; project: string }, preview: boolean): MessagePush {
  const out: MessagePush = { k: "m", s: m.session_id, u: m.urgency, i: m.id };
  if (preview) {
    out.p = Array.from(m.project).slice(0, 64).join("");
    out.b = previewText(m.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending

export type PushOutcome =
  /** Accepted by the push service. */
  | { kind: "ok"; status: number }
  /** 404 / 410: the subscription is gone; delete it. */
  | { kind: "gone"; status: number }
  /** 429 / 5xx / network: skip this device for `retryAfterMs` (never retried: no retry storm). */
  | { kind: "later"; status: number; retryAfterMs: number }
  /** Other 4xx (bad VAPID key, payload too large, ...): drop this message; log the status. */
  | { kind: "rejected"; status: number };

export function classifyPushResponse(status: number, retryAfter: string | null): PushOutcome {
  if (status >= 200 && status < 300) return { kind: "ok", status };
  if (status === 404 || status === 410) return { kind: "gone", status };
  if (status === 429 || status >= 500 || status === 0) {
    const s = retryAfter && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) * 1000 : 0;
    return { kind: "later", status, retryAfterMs: Math.min(Math.max(s, 60_000), 3_600_000) };
  }
  return { kind: "rejected", status };
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Wall-clock bound on one push request (the Hub stays awake while it waits). */
export const PUSH_TIMEOUT_MS = 5_000;

/** Build the RFC 8030 request (encrypted body, VAPID auth). */
export async function buildPushRequest(
  sub: PushTarget,
  payload: PushPayload,
  opts: { keys: VapidKeys; subject: string; ttl: number; urgency: "very-low" | "low" | "normal" | "high" },
): Promise<Request> {
  const body = await encryptPushPayload(enc.encode(JSON.stringify(payload)), b64uDecode(sub.p256dh), b64uDecode(sub.auth));
  const audience = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(opts.keys, audience, opts.subject);
  return new Request(sub.endpoint, {
    method: "POST",
    // A push service never redirects; following one would send our VAPID-signed request elsewhere.
    redirect: "manual",
    headers: {
      authorization: `vapid t=${jwt}, k=${opts.keys.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(opts.ttl),
      urgency: opts.urgency,
    },
    body,
  });
}

export type FetchLike = (req: Request, init?: { signal?: AbortSignal; redirect?: "manual" }) => Promise<Response>;

/** Send one push; never throws (network errors and timeouts count as "later"). */
export async function sendPush(
  sub: PushTarget,
  payload: PushPayload,
  opts: { keys: VapidKeys; subject: string; ttl: number; urgency: "normal" | "high" },
  fetchFn: FetchLike,
): Promise<PushOutcome> {
  let req: Request;
  try {
    req = await buildPushRequest(sub, payload, opts);
  } catch (e) {
    console.error("could not build push request", e instanceof Error ? e.message : e);
    return { kind: "rejected", status: 0 };
  }
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetchFn(req, { signal: ac.signal, redirect: "manual" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ac.abort();
          reject(new Error("push timeout"));
        }, PUSH_TIMEOUT_MS);
      }),
    ]);
    const out = classifyPushResponse(res.status, res.headers.get("retry-after"));
    await res.body?.cancel().catch(() => {});
    return out;
  } catch {
    return { kind: "later", status: 0, retryAfterMs: 60_000 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
