// Session cookies, machine tokens and tenant ids.
import { b64urlDecodeText, b64urlEncode, hmacSign, hmacVerify, randomToken } from "./crypto";

export const SESSION_COOKIE = "__Host-mr_session";
export const OAUTH_COOKIE = "__Host-mr_oauth";
export const SESSION_TTL_S = 30 * 24 * 3600;

/** Tenant ids are derived from the identity provider subject (D9). Never contain '.'. */
export function tenantIdForGoogle(sub: string): string {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(sub)) throw new Error("unexpected Google sub format");
  return `g-${sub}`;
}

export function tenantIdForDev(user: string): string {
  return `dev-${user}`;
}

export const DEV_USER_RE = /^[a-z0-9_-]{1,32}$/;

export interface SessionClaims {
  tid: string;
  email: string;
  name?: string;
  iat: number;
  exp: number;
}

function isSessionClaims(x: unknown): x is SessionClaims {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.tid === "string" &&
    o.tid.length > 0 &&
    typeof o.email === "string" &&
    typeof o.iat === "number" &&
    typeof o.exp === "number" &&
    (o.name === undefined || typeof o.name === "string")
  );
}

/** Generic signed, expiring JSON blob: `v1.<payload>.<sig>`. */
export async function signBlob(secret: string, purpose: string, payload: object): Promise<string> {
  const body = `v1.${b64urlEncode(JSON.stringify(payload))}`;
  return `${body}.${await hmacSign(secret, purpose, body)}`;
}

export async function verifyBlob(secret: string, purpose: string, value: string): Promise<unknown | null> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const body = `${parts[0]}.${parts[1]}`;
  if (!(await hmacVerify(secret, purpose, body, parts[2]!))) return null;
  try {
    return JSON.parse(b64urlDecodeText(parts[1]!));
  } catch {
    return null;
  }
}

export async function makeSessionCookieValue(
  secret: string,
  c: { tid: string; email: string; name?: string },
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const claims: SessionClaims = { ...c, iat, exp: iat + SESSION_TTL_S };
  return signBlob(secret, "session", claims);
}

export async function verifySessionCookieValue(
  secret: string,
  value: string,
  now = Date.now(),
): Promise<SessionClaims | null> {
  const c = await verifyBlob(secret, "session", value);
  if (!isSessionClaims(c)) return null;
  if (c.exp * 1000 <= now) return null;
  return c;
}

// ---------------------------------------------------------------------------
// Machine tokens: mrm1.<b64url(tenant)>.<machine_id>.<random>.<hmac>
//
// The HMAC lets the Worker reject forged tokens without waking any Durable Object and tells it
// which Hub to route to. The Hub then checks sha256(token) against its machines table, which is
// what makes revocation work. Only the hash is stored.

export interface MachineTokenParts {
  tid: string;
  machineId: string;
}

export async function mintMachineToken(secret: string, tid: string, machineId: string): Promise<string> {
  const body = `mrm1.${b64urlEncode(tid)}.${machineId}.${randomToken(32)}`;
  return `${body}.${await hmacSign(secret, "machine-token", body)}`;
}

export async function verifyMachineToken(secret: string, token: string): Promise<MachineTokenParts | null> {
  if (token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "mrm1") return null;
  const body = parts.slice(0, 4).join(".");
  if (!(await hmacVerify(secret, "machine-token", body, parts[4]!))) return null;
  let tid: string;
  try {
    tid = b64urlDecodeText(parts[1]!);
  } catch {
    return null;
  }
  const machineId = parts[2]!;
  if (!tid || !/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) return null;
  return { tid, machineId };
}

// ---------------------------------------------------------------------------
// Cookies

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!out.has(k)) out.set(k, v);
  }
  return out;
}

export function setCookie(name: string, value: string, opts: { maxAge: number; path?: string }): string {
  // __Host- cookies must be Secure, Path=/ and have no Domain.
  return `${name}=${value}; Path=${opts.path ?? "/"}; Max-Age=${opts.maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
