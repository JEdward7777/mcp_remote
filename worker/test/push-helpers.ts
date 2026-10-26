// Web Push test helpers: the run's VAPID pair (generated in vitest.config.ts), browser-like
// subscriptions with real keys, and a fake push service injected into a Hub (no network).
import { b64uEncode } from "../src/webpush";
import { E, withHub } from "./helpers";

export const TEST_VAPID = {
  get publicKey(): string {
    return E.VAPID_PUBLIC_KEY!;
  },
  get privateKey(): string {
    return E.VAPID_PRIVATE_KEY!;
  },
};

export interface FakeSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The browser's private key (to decrypt what was pushed). */
  ua: CryptoKeyPair;
  uaPublic: Uint8Array;
  auth: Uint8Array;
}

export async function fakeSubscription(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`): Promise<FakeSub> {
  const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, keys: { p256dh: b64uEncode(uaPublic), auth: b64uEncode(auth) }, ua, uaPublic, auth };
}

export interface PushCall {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Replace the Hub's outbound fetch for pushes. `answer` picks the status per call (default 201).
 * Returns the live list of calls (shared with the DO: same isolate under vitest-pool-workers).
 */
export async function fakePushService(user: string, answer: (c: PushCall, n: number) => number | Response = () => 201): Promise<PushCall[]> {
  const calls: PushCall[] = [];
  await withHub(user, (hub) => {
    hub.pushFetch = async (req: Request) => {
      const c: PushCall = {
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: new Uint8Array(await req.arrayBuffer()),
      };
      calls.push(c);
      const a = answer(c, calls.length);
      return typeof a === "number" ? new Response(null, { status: a }) : a;
    };
  });
  return calls;
}

/** RFC 8291 receiver side: decrypt a pushed body with the subscription's keys. */
export async function decryptPush(sub: FakeSub, body: Uint8Array): Promise<unknown> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as never, sub.ua.privateKey, 256));
  const hmac = async (k: Uint8Array, d: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const cat = (...p: Uint8Array[]) => {
    const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
    let i = 0;
    for (const x of p) (o.set(x, i), (i += x.length));
    return o;
  };
  const te = new TextEncoder();
  const one = new Uint8Array([1]);
  const ikm = await hmac(await hmac(sub.auth, secret), cat(te.encode("WebPush: info\0"), sub.uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}
