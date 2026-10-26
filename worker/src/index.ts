// Worker entry: auth, pairing and routing to the per-tenant Hub (D7, D9, D4).
import {
  PairApproveRequest,
  PairRedeemRequest,
  type PairRedeemResponse,
  PairStartRequest,
  type PairStartResponse,
  humanWait,
} from "@mcp-remote/shared";
import {
  DEV_USER_RE,
  INVITE_ID_RE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_S,
  type SessionClaims,
  WAIT_COOKIE,
  clearCookie,
  makeInviteToken,
  makeSessionCookieValue,
  makeWaitCookieValue,
  mintMachineToken,
  parseCookies,
  setCookie,
  signBlob,
  tenantIdForDev,
  tenantIdForGoogle,
  verifyBlob,
  verifyInviteToken,
  verifyMachineToken,
  verifySessionCookieValue,
  verifyWaitCookieValue,
} from "./auth";
import { randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { type Env, H_ADM, H_DEV, H_EMAIL, H_KIND, H_MACHINE, H_TENANT, H_TOKEN_HASH, H_VIS, pushConfigured, pushExtraOrigins } from "./env";
import { checkSubscription, subscriptionId } from "./webpush";
import { z } from "zod";
import {
  IdTokenError,
  accountAllowed,
  type OAuthPending,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleJwks,
  newPending,
  verifyIdToken,
} from "./oauth";
import { PLANS, isOwnerEmail, parseRate, publicLimits } from "./budget";
import type { Limited } from "./hub";
import { SIGNED_CODE_LEN, generateCode, normalizeCode } from "./pairing";
import { type AdminAction, REGISTRY_NAME, type Registry } from "./registry";
import { type AccountStatus, isAllowlisted } from "./signup";
import { checkPairStart, clientKey, localHit } from "./throttle";

export { Hub } from "./hub";
export { Pairing } from "./pairing";
export { Registry } from "./registry";
export { Throttle } from "./throttle";

/**
 * Isolate memory of tenants whose Hub said "disabled" (Phase 4b): their cookie is treated as signed
 * out without waking the Hub again. Short, because an owner may enable the account again.
 */
const disabledTenants = new Map<string, number>();
const DISABLED_TTL_MS = 60_000;
/** Waitlist re-checks per tenant per isolate: at most one Registry call per this interval. */
const waitChecks = new Map<string, { at: number; status: AccountStatus | null }>();
const WAIT_RECHECK_MS = 30_000;
/** Owner (admin) API calls per owner, isolate-local (each one is a Registry request). */
const ADMIN_RATE = parseRate("120,600/h")!;

function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_NAME));
}

/** Isolate memory of machine tokens the Hub refused with 401 (revocation is permanent). Best effort, free. */
const refusedTokens = new Map<string, number>();
const REFUSED_TOKEN_TTL_MS = 10 * 60_000;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_JSON_BODY = 4096;

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function err(status: number, error: string): Response {
  return json({ error }, status);
}

/** 429 with Retry-After and a sentence a person can act on. */
function tooMany(retryAfterMs: number, what: string, saysWhen = false): Response {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const error = saysWhen ? what : `${what}; try again in ${humanWait(retryAfterMs)}`;
  return json({ error, retry_after_s: secs }, 429, { "retry-after": String(secs) });
}

function unwrap<T>(tid: string, r: Limited<T>): { value: T } | Response {
  if (r.ok) return { value: r.value };
  if (r.disabled) return disabledResponse(r.error, tid);
  return tooMany(r.retryAfterMs, r.error, r.says_when);
}

/** The owner disabled this account: 403, signed out (cookie cleared), remembered in this isolate briefly. */
function disabledResponse(error: string, tid?: string): Response {
  if (tid) {
    if (disabledTenants.size >= 4096) disabledTenants.clear();
    disabledTenants.set(tid, Date.now() + DISABLED_TTL_MS);
  }
  return json({ error, disabled: true }, 403, { "set-cookie": clearCookie(SESSION_COOKIE) });
}

class BodyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function secretOk(env: Env): boolean {
  return typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32;
}

/**
 * Small JSON bodies only. Oversize bodies are refused from Content-Length before reading, and a
 * chunked body is read only up to the limit, so nothing large is buffered and no DO is woken.
 */
async function readJson(request: Request): Promise<unknown> {
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("application/json")) throw new BodyError("content-type must be application/json", 415);
  const len = request.headers.get("content-length");
  if (len !== null && !(Number(len) <= MAX_JSON_BODY)) throw new BodyError("body too large", 413);
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const dec = new TextDecoder();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_JSON_BODY) {
        await reader.cancel().catch(() => {});
        throw new BodyError("body too large", 413);
      }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new BodyError("invalid JSON", 400);
  }
}

function bodyErr(e: unknown, fallback: string): Response {
  if (e instanceof BodyError) return err(e.status, e.message);
  return err(400, e instanceof Error && e.message ? fallback : "bad request");
}

/** Body of POST /api/push/subscribe: the browser's PushSubscription.toJSON(). */
const PushSubscribeBody = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  expirationTime: z.number().nullable().optional(),
});
/** Body of DELETE /api/push/subscribe. */
const PushUnsubscribeBody = z.union([
  z.object({ endpoint: z.string().min(1).max(2048) }),
  z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) }),
  z.object({ all: z.literal(true) }),
]);

/** "Chrome on Android" from a User-Agent: shown in the phone's device list (no other use, no fingerprint). */
export function deviceLabel(ua: string | null): string {
  const u = ua ?? "";
  const browser = /Edg\//.test(u)
    ? "Edge"
    : /SamsungBrowser\//.test(u)
      ? "Samsung Internet"
      : /Firefox\//.test(u)
        ? "Firefox"
        : /Chrome\//.test(u)
          ? "Chrome"
          : /Safari\//.test(u)
            ? "Safari"
            : "Browser";
  const os = /Android/.test(u) ? "Android" : /iPhone|iPad/.test(u) ? "iOS" : /Windows/.test(u) ? "Windows" : /Mac OS X/.test(u) ? "macOS" : /Linux/.test(u) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Cookie-authenticated, state-changing requests must come from our own origin (CSRF / CSWSH). */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === url.origin;
}

async function getSession(request: Request, env: Env): Promise<SessionClaims | null> {
  const v = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (!v) return null;
  const c = await verifySessionCookieValue(env.SESSION_SECRET, v);
  // Re-check gating on every request: removing someone from ALLOWED_EMAILS signs them out (accounts
  // admitted by the Registry, adm "reg", are governed by it: the owner disables them in Admin).
  if (c && !accountAllowed(c.tid, c.email, env, c.adm)) return null;
  if (c) {
    const until = disabledTenants.get(c.tid);
    if (until !== undefined) {
      if (until > Date.now()) return null;
      disabledTenants.delete(c.tid);
    }
  }
  return c;
}

/** Owner(s) = OWNER_EMAILS (D23), checked server-side on every admin call. */
function isOwner(session: SessionClaims, env: Env): boolean {
  return isOwnerEmail(session.email, env as unknown as Record<string, unknown>);
}

function hubFor(env: Env, tid: string): DurableObjectStub<import("./hub").Hub> {
  return env.HUB.get(env.HUB.idFromName(tid));
}

/** Dev auth is opt-in via .dev.vars and refused on any *.workers.dev host as a second guard. */
export function devAuthEnabled(env: Env, url: URL): boolean {
  return env.DEV_AUTH === "1" && !url.hostname.endsWith(".workers.dev");
}

/**
 * After the identity is verified (Google, or local dev sign-in): ask the Registry whether this account
 * may use the service (signup.ts has the precedence) and hand out the matching cookie.
 *  - active: a session cookie (with how it was admitted, `adm`);
 *  - waitlisted: only a waitlist cookie (the app shows the waiting screen; /api/me re-checks);
 *  - refused: an error page.
 * If the Registry can't be reached, owners and ALLOWED_EMAILS still get in (they need no Registry
 * decision: fail open for them); everyone else is told to try again (fail closed: no cap check possible).
 */
async function finishSignIn(
  env: Env,
  who: { tid: string; email: string; name?: string | undefined; emailVerified: boolean; inviteId?: string | null; dev?: boolean },
  extraCookies: string[] = [],
): Promise<Response> {
  const name = who.name ? { name: who.name } : {};
  let result: Awaited<ReturnType<Registry["signIn"]>>;
  try {
    result = await registry(env).signIn({
      tid: who.tid,
      email: who.email,
      name: who.name ?? null,
      emailVerified: who.emailVerified,
      inviteId: who.inviteId ?? null,
      dev: !!who.dev,
    });
  } catch (e) {
    console.error("registry sign-in failed", e instanceof Error ? e.message : String(e));
    const e2 = env as unknown as Record<string, unknown>;
    if (who.emailVerified && (who.dev || isOwnerEmail(who.email, e2) || isAllowlisted(who.email, e2))) {
      result = { status: "active", adm: "env", via: who.dev ? "dev" : "allowlist", plan: "free" };
    } else {
      return signInError("Sign-up is temporarily unavailable. Please try again in a minute.", extraCookies, 503);
    }
  }
  disabledTenants.delete(who.tid);
  waitChecks.delete(who.tid);
  if (result.status === "active") {
    const value = await makeSessionCookieValue(env.SESSION_SECRET, { tid: who.tid, email: who.email, ...name, adm: result.adm });
    return redirect("/", [...extraCookies, setCookie(SESSION_COOKIE, value, { maxAge: SESSION_TTL_S }), clearCookie(WAIT_COOKIE)]);
  }
  if (result.status === "waitlisted") {
    const value = await makeWaitCookieValue(env.SESSION_SECRET, { tid: who.tid, email: who.email, ...name });
    return redirect("/", [...extraCookies, setCookie(WAIT_COOKIE, value, { maxAge: SESSION_TTL_S }), clearCookie(SESSION_COOKIE)]);
  }
  return signInError(result.text, [...extraCookies, clearCookie(WAIT_COOKIE)], 403);
}

/** The invite id from `?invite=<token>` if the token is genuine and unexpired (no Durable Object). */
async function inviteFrom(env: Env, url: URL): Promise<string | null> {
  const t = url.searchParams.get("invite");
  if (!t) return null;
  return (await verifyInviteToken(env.SESSION_SECRET, t))?.id ?? null;
}

// ---------------------------------------------------------------------------

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/auth/login" || url.pathname === "/auth/callback") {
    // These never touch a Durable Object; a free, isolate-local limit is enough to blunt floods.
    const r = localHit(`auth:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).auth_ip);
    if (!r.ok) {
      const secs = Math.ceil(r.retryAfterMs / 1000);
      const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": String(secs) });
      return new Response(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign-in</title><p>Too many sign-in attempts from your network. Try again in ${humanWait(r.retryAfterMs)}.</p>`,
        { status: 429, headers: h },
      );
    }
  }
  switch (url.pathname) {
    case "/auth/login": {
      if (!env.GOOGLE_CLIENT_ID) return err(500, "GOOGLE_CLIENT_ID is not configured");
      const pending = newPending();
      const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/callback`;
      const location = await buildAuthUrl(env.GOOGLE_CLIENT_ID, redirectUri, pending);
      // An invite link (Phase 4b) rides along in the signed pending cookie, checked by the Registry later.
      const inv = await inviteFrom(env, url);
      const cookie = await signBlob(env.SESSION_SECRET, "oauth-pending", inv ? { ...pending, inv } : pending);
      return redirect(location, [setCookie(OAUTH_COOKIE, cookie, { maxAge: 600 })]);
    }
    case "/auth/callback": {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return err(500, "Google OAuth is not configured");
      const raw = parseCookies(request.headers.get("cookie")).get(OAUTH_COOKIE);
      const pending = raw ? ((await verifyBlob(env.SESSION_SECRET, "oauth-pending", raw)) as (OAuthPending & { inv?: string }) | null) : null;
      const clear = clearCookie(OAUTH_COOKIE);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (!pending || pending.exp * 1000 < Date.now() || !state || !timingSafeEqual(state, pending.state)) {
        return signInError("Sign-in expired or was tampered with. Please try again.", [clear]);
      }
      if (!code) return signInError(`Sign-in was cancelled (${url.searchParams.get("error") ?? "no code"}).`, [clear]);
      try {
        const redirectUri = env.GOOGLE_REDIRECT_URI || `${url.origin}/auth/callback`;
        const { id_token } = await exchangeCode({
          code,
          verifier: pending.verifier,
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          redirectUri,
        });
        const claims = await verifyIdToken(id_token, {
          clientId: env.GOOGLE_CLIENT_ID,
          nonce: pending.nonce,
          jwks: fetchGoogleJwks,
        });
        return await finishSignIn(
          env,
          {
            tid: tenantIdForGoogle(claims.sub),
            email: claims.email ?? "",
            name: claims.name,
            emailVerified: claims.email_verified === true || claims.email_verified === "true",
            inviteId: typeof pending.inv === "string" && INVITE_ID_RE.test(pending.inv) ? pending.inv : null,
          },
          [clear],
        );
      } catch (e) {
        const msg = e instanceof IdTokenError ? e.message : "token exchange failed";
        console.error("oauth callback failed", e);
        return signInError(`Sign-in failed: ${msg}`, [clear]);
      }
    }
    case "/auth/logout": {
      if (request.method !== "POST") return err(405, "use POST");
      // Origin "null" (e.g. a form post under a no-referrer policy) is refused like any foreign origin.
      if (!sameOrigin(request, url)) return err(403, "bad origin");
      if ((request.headers.get("accept") ?? "").includes("application/json")) {
        const h = new Headers(JSON_HEADERS);
        h.append("set-cookie", clearCookie(SESSION_COOKIE));
        h.append("set-cookie", clearCookie(WAIT_COOKIE));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: h });
      }
      return redirect("/", [clearCookie(SESSION_COOKIE), clearCookie(WAIT_COOKIE)]);
    }
    case "/auth/dev": {
      // Absent unless DEV_AUTH=1 (only ever set in .dev.vars for local testing).
      if (!devAuthEnabled(env, url)) return new Response("not found", { status: 404 });
      const user = url.searchParams.get("user") ?? "";
      if (!DEV_USER_RE.test(user)) return err(400, "user must match [a-z0-9_-]{1,32}");
      // ?gate=1 runs the full sign-up gating (cap, waitlist, invites) as for a Google account (e2e).
      return finishSignIn(env, {
        tid: tenantIdForDev(user),
        email: `${user}@dev.local`,
        name: user,
        emailVerified: true,
        inviteId: await inviteFrom(env, url),
        dev: url.searchParams.get("gate") !== "1",
      });
    }
  }
  return new Response("not found", { status: 404 });
}

function signInError(message: string, cookies: string[], status = 400): Response {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign-in</title><p>${esc}</p><p><a href="/">Back</a></p>`,
    { status, headers: h },
  );
}

// ---------------------------------------------------------------------------
// Pairing wait socket (Phase 3 review round 4)

/** code / pairing_id from the query, poll secret from Authorization; validated without any DO. */
function pairingParams(request: Request, url: URL): { code: string; pairingId: string; authz: string } | Response {
  const raw = url.searchParams.get("code") ?? "";
  // 8 characters: printed by `mcp-remote pair`; 16: a signed-in user's one-line install (Phase 4b).
  const code = normalizeCode(raw) ?? normalizeCode(raw, SIGNED_CODE_LEN);
  if (!code) return err(400, "bad code");
  const pairingId = url.searchParams.get("pairing_id") ?? "";
  const authz = request.headers.get("authorization") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(pairingId) || !/^Bearer [A-Za-z0-9_-]{16,128}$/.test(authz)) {
    return err(400, "bad pairing request");
  }
  return { code, pairingId, authz };
}

/** At most one keepalive "ping" per this interval is answered; anything else closes the socket. */
const PAIR_PING_MIN_GAP_MS = 5_000;

/**
 * The daemon's wait socket is accepted by the Worker itself, never by the Pairing DO: client frames
 * then cost only this invocation's CPU (and the CPU limit ends a flood), not a DO request each. The
 * Worker holds its own link to the DO (a hibernatable WebSocket on the DO's side, so the DO sleeps
 * while it waits) and only forwards what the DO sends: "pending", "approved" or "expired".
 */
export function relayPairingWait(link: WebSocket): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  link.accept();
  let lastPing = 0;
  let done = false;
  const shut = (code: number, reason: string) => {
    if (done) return;
    done = true;
    server.removeEventListener("message", onClient);
    try {
      server.close(code, reason);
    } catch {
      /* already closed */
    }
    try {
      link.close(1000, "client gone");
    } catch {
      /* already closed */
    }
  };
  const onClient = (ev: MessageEvent) => {
    if (ev.data === "ping" && Date.now() - lastPing >= PAIR_PING_MIN_GAP_MS) {
      lastPing = Date.now();
      try {
        server.send("pong");
      } catch {
        /* closing */
      }
      return;
    }
    // "claimed" is an HTTP POST now; nothing else is expected from the daemon.
    shut(1008, "unexpected frame");
  };
  server.addEventListener("message", onClient);
  server.addEventListener("close", () => shut(1000, "bye"));
  server.addEventListener("error", () => shut(1011, "error"));
  link.addEventListener("message", (ev) => {
    try {
      server.send(ev.data as string);
    } catch {
      /* client gone */
    }
  });
  link.addEventListener("close", (ev) => {
    if (done) return;
    done = true;
    server.removeEventListener("message", onClient);
    try {
      server.close(ev.code === 1005 || ev.code === 1006 ? 1000 : ev.code, ev.reason);
    } catch {
      /* already closed */
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}

// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  // --- daemon-facing, no cookie ---------------------------------------------------------
  if (path === "/api/pair/start" && request.method === "POST") {
    let hostname = "computer";
    try {
      const body = PairStartRequest.parse(await readJson(request));
      if (body.hostname) hostname = body.hostname;
    } catch (e) {
      return bodyErr(e, "expected {hostname?}");
    }
    // Each start creates a Pairing DO (put + alarm + wipe): throttle per IP and overall first.
    const gate = await checkPairStart(env, request, publicLimits(env as unknown as Record<string, unknown>));
    if (!gate.ok) return tooMany(gate.retryAfterMs, "too many pairing attempts from your network");
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      const pairingId = randomToken(16);
      const pollSecret = randomToken(32);
      const stub = env.PAIRING.get(env.PAIRING.idFromName(`pair:${normalizeCode(code)}`));
      const r = await stub.init(pairingId, pollSecret, hostname);
      if (r.ok) {
        const res: PairStartResponse = { code, pairing_id: pairingId, poll_secret: pollSecret, expires_at: r.expires_at };
        return json(res);
      }
    }
    return err(503, "could not allocate a pairing code");
  }

  if (path === "/api/pair/wait") {
    // Everything that can be checked without the Pairing DO is checked first.
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected websocket");
    const p = pairingParams(request, url);
    if (p instanceof Response) return p;
    const w = localHit(`pw:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).pair_wait_ip);
    if (!w.ok) return tooMany(w.retryAfterMs, "too many pairing requests from your network");
    const stub = env.PAIRING.get(env.PAIRING.idFromName(`pair:${p.code}`));
    const upstream = await stub.fetch(
      new Request(`https://pairing/wait?pairing_id=${encodeURIComponent(p.pairingId)}`, {
        headers: { upgrade: "websocket", authorization: p.authz },
      }),
    );
    if (!upstream.webSocket) return upstream; // 404 unknown/expired, wrong secret
    return relayPairingWait(upstream.webSocket);
  }

  if (path === "/api/pair/redeem" && request.method === "POST") {
    // One-line install (Phase 4b): a computer redeems a pairing a signed-in user started in the app.
    let body: { code: string; hostname?: string | undefined };
    try {
      body = PairRedeemRequest.parse(await readJson(request));
    } catch (e) {
      return e instanceof BodyError && e.status !== 400 ? bodyErr(e, "") : err(400, "expected {code, hostname?}");
    }
    const code = normalizeCode(body.code, SIGNED_CODE_LEN);
    if (!code) return err(400, "that does not look like an install code (XXXX-XXXX-XXXX-XXXX)");
    // Free, isolate-local limit first (shared with the pairing wait/claim bucket); a wrong code wakes a fresh DO.
    const w = localHit(`pw:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).pair_wait_ip);
    if (!w.ok) return tooMany(w.retryAfterMs, "too many pairing requests from your network");
    const pairing = env.PAIRING.get(env.PAIRING.idFromName(`pair:${code}`));
    const pairingId = randomToken(16);
    const pollSecret = randomToken(32);
    const hostname = (body.hostname || "computer").slice(0, 64);
    const r = await pairing.redeem(pairingId, pollSecret, hostname, publicLimits(env as unknown as Record<string, unknown>).approve_attempts_per_code);
    if (!r.ok) return err(r.status, r.error);
    const machineId = randomToken(12);
    let added = false;
    try {
      const token = await mintMachineToken(env.SESSION_SECRET, r.tid, machineId);
      const machine = await hubFor(env, r.tid).addMachine(machineId, hostname, await sha256Hex(token), r.email || undefined, r.adm);
      if ("error" in machine) {
        await pairing.abortApprove();
        return err(409, machine.error);
      }
      added = true;
      await pairing.complete({ t: "approved", token, machine_id: machineId, machine_name: hostname, account: r.email }, r.tid);
      const res: PairRedeemResponse = { token, machine_id: machineId, machine_name: hostname, account: r.email, pairing_id: pairingId, poll_secret: pollSecret };
      return json(res);
    } catch (e) {
      console.error("redeem failed", e);
      if (added) await hubFor(env, r.tid).removeUnclaimedMachine(machineId).catch(() => false);
      await pairing.abortApprove().catch(() => {});
      return err(500, "pairing failed");
    }
  }

  if (path === "/api/invite" && request.method === "GET") {
    // The sign-in page checks an invite link (signature + expiry only; no Durable Object).
    const r = localHit(`auth:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).auth_ip);
    if (!r.ok) return tooMany(r.retryAfterMs, "too many requests from your network");
    const t = url.searchParams.get("token") ?? "";
    const v = t ? await verifyInviteToken(env.SESSION_SECRET, t) : null;
    return v ? json({ valid: true, expires_at: v.expiresAt }) : json({ valid: false });
  }

  if (path === "/api/pair/claim" && request.method === "POST") {
    // The daemon saved its token: the pairing can be forgotten (authenticated by the poll secret).
    const p = pairingParams(request, url);
    if (p instanceof Response) return p;
    const w = localHit(`pw:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).pair_wait_ip);
    if (!w.ok) return tooMany(w.retryAfterMs, "too many pairing requests from your network");
    const r = await env.PAIRING.get(env.PAIRING.idFromName(`pair:${p.code}`)).claim(p.pairingId, p.authz.slice(7));
    return r.ok ? json({ ok: true }) : err(r.status, r.error);
  }

  if (path === "/api/daemon/ws") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected websocket");
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const parts = token ? await verifyMachineToken(env.SESSION_SECRET, token) : null;
    if (!parts) return err(401, "invalid machine token");
    const tokenHash = await sha256Hex(token);
    // A token the Hub already refused (revoked: permanent) is turned away here, without waking the Hub.
    const refusedUntil = refusedTokens.get(tokenHash);
    if (refusedUntil !== undefined && refusedUntil > Date.now()) return err(401, "invalid machine token");
    const fwd = new Request("https://hub/daemon", {
      headers: {
        upgrade: "websocket",
        [H_KIND]: "daemon",
        [H_TENANT]: parts.tid,
        [H_MACHINE]: parts.machineId,
        [H_TOKEN_HASH]: tokenHash,
      },
    });
    const res = await hubFor(env, parts.tid).fetch(fwd);
    if (res.status === 401) {
      if (refusedTokens.size >= 4096) refusedTokens.clear();
      refusedTokens.set(tokenHash, Date.now() + REFUSED_TOKEN_TTL_MS);
    }
    return res;
  }

  // --- phone-facing, cookie -------------------------------------------------------------
  const session = await getSession(request, env);
  if (!session) {
    if (path === "/api/me" && request.method === "GET") return waitlistMe(request, env);
    return err(401, "not signed in");
  }

  if (path === "/api/me" && request.method === "GET") return json(meBody(session, env));

  if (path.startsWith("/api/admin/")) return handleAdmin(request, env, url, session);

  if (path === "/api/pair/start-signed" && request.method === "POST") {
    // One-line install (Phase 4b): the signed-in user starts a pre-approved pairing, charged to their
    // own account (bucket, daily budget, machine cap) instead of the global unauthenticated cap.
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    const allowed = await hubFor(env, session.tid).allowPairStart();
    if (!allowed.ok) {
      if (allowed.disabled) return disabledResponse(allowed.error ?? "account disabled", session.tid);
      if (allowed.status === 409) return err(409, allowed.error ?? "too many computers on this account");
      return tooMany(allowed.retryAfterMs, allowed.error ?? "too many install commands for this account", allowed.says_when);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode(SIGNED_CODE_LEN);
      const stub = env.PAIRING.get(env.PAIRING.idFromName(`pair:${normalizeCode(code, SIGNED_CODE_LEN)}`));
      const r = await stub.initSigned(session.tid, session.email, session.adm ?? "env");
      if (r.ok) return json({ code, expires_at: r.expires_at, url: url.origin });
    }
    return err(503, "could not allocate a pairing code");
  }

  if (path === "/api/push/subscribe" && (request.method === "POST" || request.method === "DELETE")) {
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    if (!pushConfigured(env)) return err(503, "notifications are not set up on this server (VAPID keys missing; see SETUP)");
    // Everything that can be checked without the Hub is checked first (body size, shape, push service, keys).
    if (request.method === "DELETE") {
      let body: z.infer<typeof PushUnsubscribeBody>;
      try {
        body = PushUnsubscribeBody.parse(await readJson(request));
      } catch (e) {
        return e instanceof BodyError && e.status !== 400 ? bodyErr(e, "") : err(400, "expected {endpoint} or {id} or {all: true}");
      }
      const target = "all" in body ? "all" : "id" in body ? body.id : await subscriptionId(body.endpoint);
      const r = unwrap(session.tid, await hubFor(env, session.tid).pushUnsubscribe(target));
      return r instanceof Response ? r : json({ ok: true, ...r.value });
    }
    let body: z.infer<typeof PushSubscribeBody>;
    try {
      body = PushSubscribeBody.parse(await readJson(request));
    } catch (e) {
      return e instanceof BodyError && e.status !== 400 ? bodyErr(e, "") : err(400, "expected a push subscription {endpoint, keys: {p256dh, auth}}");
    }
    const sub = { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth };
    const bad = await checkSubscription(sub, pushExtraOrigins(env));
    if (bad) return err(400, bad);
    const id = await subscriptionId(sub.endpoint);
    const r = unwrap(session.tid, await hubFor(env, session.tid).pushSubscribe({ id, ...sub, label: deviceLabel(request.headers.get("user-agent")) }, url.origin));
    return r instanceof Response ? r : json({ ok: true, id, ...r.value });
  }

  if (path === "/api/ws") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected websocket");
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    // ?vis=1: the page was visible when it connected (else it counts as hidden for push decisions);
    // ?dev=<id>: this browser's push subscription (no push to it while its page is visible).
    const dev = url.searchParams.get("dev") ?? "";
    const fwd = new Request("https://hub/phone", {
      headers: {
        upgrade: "websocket",
        [H_KIND]: "phone",
        [H_TENANT]: session.tid,
        [H_EMAIL]: session.email,
        [H_ADM]: session.adm ?? "env",
        [H_VIS]: url.searchParams.get("vis") === "1" ? "1" : "0",
        ...(/^[0-9a-f]{16}$/.test(dev) ? { [H_DEV]: dev } : {}),
      },
    });
    return hubFor(env, session.tid).fetch(fwd);
  }

  if (path === "/api/machines" && request.method === "GET") {
    const r = unwrap(session.tid, await hubFor(env, session.tid).listMachines());
    return r instanceof Response ? r : json({ machines: r.value });
  }

  if (path === "/api/usage" && request.method === "GET") {
    const r = unwrap(session.tid, await hubFor(env, session.tid).usage());
    return r instanceof Response ? r : json(r.value);
  }

  const revoke = /^\/api\/machines\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    const r = unwrap(session.tid, await hubFor(env, session.tid).revokeMachine(revoke[1]!));
    if (r instanceof Response) return r;
    return r.value ? json({ ok: true }) : err(404, "no such machine");
  }

  if (path === "/api/state" && request.method === "GET") {
    const r = unwrap(session.tid, await hubFor(env, session.tid).snapshot());
    return r instanceof Response ? r : json(r.value);
  }

  if (path === "/api/pair/approve" && request.method === "POST") {
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    let body: { code: string; machine_name?: string | undefined };
    try {
      body = PairApproveRequest.parse(await readJson(request));
    } catch (e) {
      return e instanceof BodyError && e.status !== 400 ? bodyErr(e, "") : err(400, "expected {code, machine_name?}");
    }
    const code = normalizeCode(body.code);
    if (!code) return err(400, "that does not look like a pairing code");
    // Per-tenant guess limit before any Pairing DO is woken (a wrong code wakes a fresh one).
    const allowed = await hubFor(env, session.tid).allowPairApprove();
    if (!allowed.ok) {
      if (allowed.disabled) return disabledResponse(allowed.error ?? "account disabled", session.tid);
      if (allowed.status === 409) return err(409, allowed.error ?? "too many computers on this account");
      return tooMany(allowed.retryAfterMs, allowed.error ?? "too many pairing approvals on this account", allowed.says_when);
    }
    const pairing = env.PAIRING.get(env.PAIRING.idFromName(`pair:${code}`));
    const claim = await pairing.beginApprove(publicLimits(env as unknown as Record<string, unknown>).approve_attempts_per_code);
    if (!claim.ok) return err(claim.status ?? 404, claim.error);
    const machineId = randomToken(12);
    let added = false;
    try {
      const name = body.machine_name || claim.hostname;
      const token = await mintMachineToken(env.SESSION_SECRET, session.tid, machineId);
      const machine = await hubFor(env, session.tid).addMachine(machineId, name, await sha256Hex(token), session.email, session.adm ?? "env");
      if ("error" in machine) {
        await pairing.abortApprove();
        return err(409, machine.error);
      }
      added = true;
      await pairing.complete(
        { t: "approved", token, machine_id: machineId, machine_name: name, account: session.email },
        session.tid,
      );
      return json({ ok: true, machine });
    } catch (e) {
      console.error("approve failed", e);
      // E.g. the code expired between beginApprove and complete: don't leave an orphan machine.
      if (added) await hubFor(env, session.tid).removeUnclaimedMachine(machineId).catch(() => false);
      await pairing.abortApprove();
      return err(500, "approval failed");
    }
  }

  return err(404, "not found");
}

// ---------------------------------------------------------------------------
// /api/me (also for waitlisted accounts) and the owner's admin API (Phase 4b)

function meBody(session: SessionClaims, env: Env): Record<string, unknown> {
  return {
    tenant: session.tid,
    email: session.email,
    name: session.name ?? null,
    dev: session.tid.startsWith("dev-"),
    // Web Push (Phase 4): the browser subscribes with this applicationServerKey; null = not configured.
    push_key: pushConfigured(env) ? (env.VAPID_PUBLIC_KEY ?? "").trim() : null,
    // The app shows the Admin tab; every /api/admin/* call checks OWNER_EMAILS again.
    owner: isOwner(session, env),
  };
}

/**
 * No session: a waitlisted account (waitlist cookie) gets its status. Re-checked with the Registry at
 * most every WAIT_RECHECK_MS per account per isolate (and per-IP limited); once the owner approved it,
 * this hands out the session cookie.
 */
async function waitlistMe(request: Request, env: Env): Promise<Response> {
  const raw = parseCookies(request.headers.get("cookie")).get(WAIT_COOKIE);
  const w = raw ? await verifyWaitCookieValue(env.SESSION_SECRET, raw) : null;
  if (!w) return err(401, "not signed in");
  const waiting = (since?: number) =>
    json({ error: "this account is on the waitlist", waitlisted: true, email: w.email, since: since ?? w.iat * 1000 }, 403);
  const now = Date.now();
  let cached = waitChecks.get(w.tid);
  if (!cached || now - cached.at >= WAIT_RECHECK_MS) {
    const ip = localHit(`auth:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).auth_ip);
    if (!ip.ok) return waiting();
    let status: AccountStatus | null;
    let adm: "env" | "reg" = "reg";
    try {
      const r = await registry(env).status(w.tid);
      status = r?.status ?? null;
      if (r) adm = r.adm;
    } catch {
      return waiting();
    }
    cached = { at: now, status };
    if (waitChecks.size >= 4096) waitChecks.clear();
    waitChecks.set(w.tid, cached);
    if (status === "active") {
      waitChecks.delete(w.tid);
      const session = { tid: w.tid, email: w.email, ...(w.name ? { name: w.name } : {}), adm };
      const value = await makeSessionCookieValue(env.SESSION_SECRET, session);
      const h = new Headers(JSON_HEADERS);
      h.append("set-cookie", setCookie(SESSION_COOKIE, value, { maxAge: SESSION_TTL_S }));
      h.append("set-cookie", clearCookie(WAIT_COOKIE));
      const me = meBody({ ...session, iat: 0, exp: 0 }, env);
      return new Response(JSON.stringify({ ...me, approved: true }), { status: 200, headers: h });
    }
  }
  if (cached.status === "waitlisted") return waiting();
  // Denied, disabled or gone: sign-in again shows the reason.
  const h = new Headers(JSON_HEADERS);
  h.append("set-cookie", clearCookie(WAIT_COOKIE));
  return new Response(JSON.stringify({ error: "not signed in" }), { status: 401, headers: h });
}

const AdminInviteBody = z.object({
  days: z.number().int().min(1).max(30).optional(),
  max_uses: z.number().int().min(1).max(1000).nullable().optional(),
  note: z.string().max(100).optional(),
});
const TID_RE = /^[A-Za-z0-9_-]{1,300}$/;

async function handleAdmin(request: Request, env: Env, url: URL, session: SessionClaims): Promise<Response> {
  // Server-side owner check on EVERY admin call (the Admin tab in the app is only a convenience).
  if (!isOwner(session, env)) return err(403, "owner only");
  if (request.method !== "GET" && !sameOrigin(request, url)) return err(403, "bad origin");
  const lim = localHit(`adm:${session.tid}`, ADMIN_RATE);
  if (!lim.ok) return tooMany(lim.retryAfterMs, "too many admin requests");
  const path = url.pathname;
  const reg = registry(env);
  const actor = session.email;
  const inviteLink = async (id: string, expiresAt: number) => `${url.origin}/?invite=${await makeInviteToken(env.SESSION_SECRET, id, expiresAt)}`;

  if (path === "/api/admin/overview" && request.method === "GET") return json(await reg.overview());

  if (path === "/api/admin/tenants" && request.method === "GET") {
    const st = url.searchParams.get("status") ?? "all";
    if (!["all", "active", "waitlisted", "denied", "disabled"].includes(st)) return err(400, "bad status");
    return json({ tenants: await reg.listTenants(st as AccountStatus | "all") });
  }

  const t = /^\/api\/admin\/tenants\/([^/]+)\/(approve|deny|disable|enable|plan|forget)$/.exec(path);
  if (t && request.method === "POST") {
    const tid = decodeURIComponent(t[1]!);
    if (!TID_RE.test(tid)) return err(400, "bad account id");
    let action: AdminAction;
    if (t[2] === "plan") {
      let body: { plan?: unknown };
      try {
        body = (await readJson(request)) as { plan?: unknown };
      } catch (e) {
        return bodyErr(e, "expected {plan}");
      }
      if (typeof body.plan !== "string" || !PLANS[body.plan]) return err(400, `plan must be one of: ${Object.keys(PLANS).join(", ")}`);
      action = { t: "plan", tid, plan: body.plan };
    } else {
      action = { t: t[2] as "approve" | "deny" | "disable" | "enable" | "forget", tid };
    }
    const r = await reg.act(actor, action);
    if (r.ok && action.t === "enable") disabledTenants.delete(tid);
    if (r.ok) waitChecks.delete(tid); // an approved account gets in on its next /api/me (this isolate at once)
    return r.ok ? json(r) : err(r.status, r.error);
  }

  if (path === "/api/admin/signups" && request.method === "POST") {
    let body: { paused?: unknown };
    try {
      body = (await readJson(request)) as { paused?: unknown };
    } catch (e) {
      return bodyErr(e, "expected {paused}");
    }
    if (typeof body.paused !== "boolean") return err(400, "expected {paused: true|false}");
    const r = await reg.act(actor, { t: "pause", paused: body.paused });
    return r.ok ? json(r) : err(r.status, r.error);
  }

  if (path === "/api/admin/invites" && request.method === "GET") {
    const now = Date.now();
    const invites = await reg.listInvites();
    return json({
      invites: await Promise.all(
        invites.map(async (i) => ({
          ...i,
          open: i.revoked_at === null && i.expires_at > now && (i.max_uses === null || i.uses < i.max_uses),
          link: i.revoked_at === null && i.expires_at > now ? await inviteLink(i.id, i.expires_at) : null,
        })),
      ),
    });
  }

  if (path === "/api/admin/invites" && request.method === "POST") {
    let body: z.infer<typeof AdminInviteBody>;
    try {
      body = AdminInviteBody.parse(await readJson(request));
    } catch (e) {
      return e instanceof BodyError && e.status !== 400 ? bodyErr(e, "") : err(400, "expected {days?: 1-30, max_uses?: 1-1000|null, note?}");
    }
    const r = await reg.createInvite(actor, { id: randomToken(16), days: body.days ?? 7, max_uses: body.max_uses === undefined ? 5 : body.max_uses, note: body.note ?? "" });
    if (!r.ok) return err(r.status, r.error);
    return json({ invite: { ...r.invite, open: true, link: await inviteLink(r.invite.id, r.invite.expires_at) } });
  }

  const inv = /^\/api\/admin\/invites\/([A-Za-z0-9_-]{16,32})$/.exec(path);
  if (inv && request.method === "DELETE") {
    return (await reg.revokeInvite(actor, inv[1]!)) ? json({ ok: true }) : err(404, "no such open invite");
  }

  if (path === "/api/admin/audit" && request.method === "GET") return json({ audit: await reg.auditLog(100) });

  return err(404, "not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The owner's page lives in the app (#/admin); every admin API call is checked server-side.
    if (url.pathname === "/admin" || url.pathname === "/admin/") return redirect("/#/admin");
    const isAuth = url.pathname.startsWith("/auth/");
    const isApi = url.pathname.startsWith("/api/");
    if (!isAuth && !isApi) return env.ASSETS.fetch(request);
    if (!secretOk(env)) return err(500, "SESSION_SECRET is not configured (need >= 32 chars)");
    try {
      return isAuth ? await handleAuth(request, env, url) : await handleApi(request, env, url);
    } catch (e) {
      console.error("unhandled", e);
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
