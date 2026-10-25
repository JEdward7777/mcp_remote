// Small Web Crypto helpers (Workers runtime and Node 22 both provide crypto.subtle).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlDecodeText(s: string): string {
  return dec.decode(b64urlDecode(s));
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function randomToken(nBytes = 32): string {
  return b64urlEncode(randomBytes(nBytes));
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * HMAC-SHA256 key for a given purpose. Purposes are domain-separated so a value signed
 * for one use (e.g. the OAuth state cookie) can never be replayed as another (a session cookie).
 */
function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = (async () => {
      const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]);
      const derived = await crypto.subtle.sign("HMAC", root, enc.encode(`mcp-remote:${purpose}`));
      return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    })();
    keyCache.set(id, k);
  }
  return k;
}

export async function hmacSign(secret: string, purpose: string, data: string): Promise<string> {
  const key = await hmacKey(secret, purpose);
  return b64urlEncode(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time verification (crypto.subtle.verify). */
export async function hmacVerify(secret: string, purpose: string, data: string, sig: string): Promise<boolean> {
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    sigBytes = b64urlDecode(sig);
  } catch {
    return false;
  }
  const key = await hmacKey(secret, purpose);
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
}

/** Constant-time string comparison for equal-purpose secrets (e.g. hex hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
