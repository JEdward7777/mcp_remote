// Google OAuth 2.0 / OIDC, authorization-code flow with PKCE (D7).
import { b64urlDecode, b64urlDecodeText, b64urlEncode, randomToken } from "./crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export interface OAuthPending {
  state: string;
  verifier: string;
  nonce: string;
  exp: number;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function newPending(now = Date.now()): OAuthPending {
  return {
    state: randomToken(24),
    verifier: randomToken(48), // 64 chars, within RFC 7636's 43..128
    nonce: randomToken(24),
    exp: Math.floor(now / 1000) + 600,
  };
}

export async function buildAuthUrl(clientId: string, redirectUri: string, p: OAuthPending): Promise<string> {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", await pkceChallenge(p.verifier));
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

export interface IdClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

export type JwksFetcher = () => Promise<{ keys: Jwk[] }>;

let jwksCache: { at: number; keys: Jwk[] } | null = null;

export const fetchGoogleJwks: JwksFetcher = async () => {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return { keys: jwksCache.keys };
  const r = await fetch(GOOGLE_JWKS_URL);
  if (!r.ok) throw new Error(`JWKS fetch failed: ${r.status}`);
  const j = (await r.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys: j.keys };
  return j;
};

export class IdTokenError extends Error {}

/**
 * Verify a Google ID token: RS256 signature against Google's JWKS, then iss, aud, exp and nonce.
 */
export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; jwks: JwksFetcher; now?: number },
): Promise<IdClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new IdTokenError("malformed id_token");
  let header: { alg?: string; kid?: string };
  let claims: IdClaims;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]!));
    claims = JSON.parse(b64urlDecodeText(parts[1]!));
  } catch {
    throw new IdTokenError("malformed id_token");
  }
  if (header.alg !== "RS256" || !header.kid) throw new IdTokenError("unexpected id_token alg");
  const { keys } = await opts.jwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new IdTokenError("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new IdTokenError("bad id_token signature");
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new IdTokenError("bad iss");
  if (claims.aud !== opts.clientId) throw new IdTokenError("bad aud");
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) throw new IdTokenError("id_token expired");
  if (claims.nonce !== opts.nonce) throw new IdTokenError("bad nonce");
  if (typeof claims.sub !== "string" || !claims.sub) throw new IdTokenError("missing sub");
  return claims;
}

export async function exchangeCode(opts: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ id_token: string }> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
    code_verifier: opts.verifier,
  });
  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status}`);
  const j = (await r.json()) as { id_token?: string };
  if (!j.id_token) throw new Error("token response missing id_token");
  return { id_token: j.id_token };
}

/**
 * Re-check gating for an existing tenant (cookie or machine token), so removing an email from
 * ALLOWED_EMAILS takes effect without waiting for the 30-day cookie to expire. Dev tenants
 * (only mintable with DEV_AUTH) are not subject to the Google allowlist.
 */
export function accountAllowed(
  tid: string,
  email: string | null | undefined,
  env: { ALLOWED_EMAILS?: string | undefined; OPEN_SIGNUP?: string | undefined },
): boolean {
  if (tid.startsWith("dev-")) return true;
  if (env.OPEN_SIGNUP === "true") return true;
  if (!email) return false;
  return isAllowed({ email, email_verified: true }, env.ALLOWED_EMAILS, env.OPEN_SIGNUP);
}

/** Sign-up gating (Phase 1): OPEN_SIGNUP=true, or the verified email is in ALLOWED_EMAILS. */
export function isAllowed(
  claims: Pick<IdClaims, "email" | "email_verified">,
  allowedEmails: string | undefined,
  openSignup: string | undefined,
): boolean {
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!claims.email || !verified) return false;
  if (openSignup === "true") return true;
  const list = (allowedEmails ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(claims.email.toLowerCase());
}
