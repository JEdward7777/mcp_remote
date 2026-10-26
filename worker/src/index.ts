// Worker entry: auth, pairing and routing to the per-tenant Hub (D7, D9, D4).
import { PairApproveRequest, PairStartRequest, type PairStartResponse, humanWait } from "@mcp-remote/shared";
import {
  DEV_USER_RE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_S,
  type SessionClaims,
  clearCookie,
  makeSessionCookieValue,
  mintMachineToken,
  parseCookies,
  setCookie,
  signBlob,
  tenantIdForDev,
  tenantIdForGoogle,
  verifyBlob,
  verifyMachineToken,
  verifySessionCookieValue,
} from "./auth";
import { randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import { type Env, H_EMAIL, H_KIND, H_MACHINE, H_TENANT, H_TOKEN_HASH } from "./env";
import {
  IdTokenError,
  accountAllowed,
  type OAuthPending,
  buildAuthUrl,
  exchangeCode,
  fetchGoogleJwks,
  isAllowed,
  newPending,
  verifyIdToken,
} from "./oauth";
import { publicLimits } from "./budget";
import type { Limited } from "./hub";
import { generateCode, normalizeCode } from "./pairing";
import { checkPairStart, clientKey, localHit } from "./throttle";

export { Hub } from "./hub";
export { Pairing } from "./pairing";
export { Throttle } from "./throttle";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_JSON_BODY = 4096;

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

function err(status: number, error: string): Response {
  return json({ error }, status);
}

/** 429 with Retry-After and a sentence a person can act on. */
function tooMany(retryAfterMs: number, what: string): Response {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return json({ error: `${what}; try again in ${humanWait(retryAfterMs)}`, retry_after_s: secs }, 429, { "retry-after": String(secs) });
}

function unwrap<T>(r: Limited<T>): { value: T } | Response {
  return r.ok ? { value: r.value } : tooMany(r.retryAfterMs, "too many requests for this account");
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

/** Cookie-authenticated, state-changing requests must come from our own origin (CSRF / CSWSH). */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === url.origin;
}

async function getSession(request: Request, env: Env): Promise<SessionClaims | null> {
  const v = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (!v) return null;
  const c = await verifySessionCookieValue(env.SESSION_SECRET, v);
  // Re-check gating on every request: removing someone from ALLOWED_EMAILS signs them out.
  if (c && !accountAllowed(c.tid, c.email, env)) return null;
  return c;
}

function hubFor(env: Env, tid: string): DurableObjectStub<import("./hub").Hub> {
  return env.HUB.get(env.HUB.idFromName(tid));
}

/** Dev auth is opt-in via .dev.vars and refused on any *.workers.dev host as a second guard. */
export function devAuthEnabled(env: Env, url: URL): boolean {
  return env.DEV_AUTH === "1" && !url.hostname.endsWith(".workers.dev");
}

async function issueSession(env: Env, c: { tid: string; email: string; name?: string }, to = "/"): Promise<Response> {
  const value = await makeSessionCookieValue(env.SESSION_SECRET, c);
  return redirect(to, [setCookie(SESSION_COOKIE, value, { maxAge: SESSION_TTL_S })]);
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
      const cookie = await signBlob(env.SESSION_SECRET, "oauth-pending", pending);
      return redirect(location, [setCookie(OAUTH_COOKIE, cookie, { maxAge: 600 })]);
    }
    case "/auth/callback": {
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return err(500, "Google OAuth is not configured");
      const raw = parseCookies(request.headers.get("cookie")).get(OAUTH_COOKIE);
      const pending = raw ? ((await verifyBlob(env.SESSION_SECRET, "oauth-pending", raw)) as OAuthPending | null) : null;
      const clear = clearCookie(OAUTH_COOKIE);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      if (!pending || pending.exp * 1000 < Date.now() || !state || !timingSafeEqual(state, pending.state)) {
        return signInError("Sign-in expired or was tampered with. Please try again.", clear);
      }
      if (!code) return signInError(`Sign-in was cancelled (${url.searchParams.get("error") ?? "no code"}).`, clear);
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
        if (!isAllowed(claims, env.ALLOWED_EMAILS, env.OPEN_SIGNUP)) {
          return signInError("This Google account is not on the sign-up list.", clear, 403);
        }
        const value = await makeSessionCookieValue(env.SESSION_SECRET, {
          tid: tenantIdForGoogle(claims.sub),
          email: claims.email ?? "",
          ...(claims.name ? { name: claims.name } : {}),
        });
        return redirect("/", [clear, setCookie(SESSION_COOKIE, value, { maxAge: SESSION_TTL_S })]);
      } catch (e) {
        const msg = e instanceof IdTokenError ? e.message : "token exchange failed";
        console.error("oauth callback failed", e);
        return signInError(`Sign-in failed: ${msg}`, clear);
      }
    }
    case "/auth/logout": {
      if (request.method !== "POST") return err(405, "use POST");
      // Origin "null" (e.g. a form post under a no-referrer policy) is refused like any foreign origin.
      if (!sameOrigin(request, url)) return err(403, "bad origin");
      if ((request.headers.get("accept") ?? "").includes("application/json")) {
        return json({ ok: true }, 200, { "set-cookie": clearCookie(SESSION_COOKIE) });
      }
      return redirect("/", [clearCookie(SESSION_COOKIE)]);
    }
    case "/auth/dev": {
      // Absent unless DEV_AUTH=1 (only ever set in .dev.vars for local testing).
      if (!devAuthEnabled(env, url)) return new Response("not found", { status: 404 });
      const user = url.searchParams.get("user") ?? "";
      if (!DEV_USER_RE.test(user)) return err(400, "user must match [a-z0-9_-]{1,32}");
      return issueSession(env, { tid: tenantIdForDev(user), email: `${user}@dev.local`, name: user });
    }
  }
  return new Response("not found", { status: 404 });
}

function signInError(message: string, cookie: string, status = 400): Response {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  h.append("set-cookie", cookie);
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Sign-in</title><p>${esc}</p><p><a href="/">Back</a></p>`,
    { status, headers: h },
  );
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
    const code = normalizeCode(url.searchParams.get("code") ?? "");
    if (!code) return err(400, "bad code");
    const pid = url.searchParams.get("pairing_id") ?? "";
    const authz = request.headers.get("authorization") ?? "";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(pid) || !/^Bearer [A-Za-z0-9_-]{16,128}$/.test(authz)) {
      return err(400, "bad pairing request");
    }
    const w = localHit(`pw:${clientKey(request)}`, publicLimits(env as unknown as Record<string, unknown>).pair_wait_ip);
    if (!w.ok) return tooMany(w.retryAfterMs, "too many pairing requests from your network");
    const stub = env.PAIRING.get(env.PAIRING.idFromName(`pair:${code}`));
    const fwd = new Request(`https://pairing/wait?pairing_id=${encodeURIComponent(url.searchParams.get("pairing_id") ?? "")}`, {
      headers: {
        upgrade: request.headers.get("upgrade") ?? "",
        authorization: request.headers.get("authorization") ?? "",
      },
    });
    return stub.fetch(fwd);
  }

  if (path === "/api/daemon/ws") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected websocket");
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const parts = token ? await verifyMachineToken(env.SESSION_SECRET, token) : null;
    if (!parts) return err(401, "invalid machine token");
    const fwd = new Request("https://hub/daemon", {
      headers: {
        upgrade: "websocket",
        [H_KIND]: "daemon",
        [H_TENANT]: parts.tid,
        [H_MACHINE]: parts.machineId,
        [H_TOKEN_HASH]: await sha256Hex(token),
      },
    });
    return hubFor(env, parts.tid).fetch(fwd);
  }

  // --- phone-facing, cookie -------------------------------------------------------------
  const session = await getSession(request, env);
  if (!session) return err(401, "not signed in");

  if (path === "/api/me" && request.method === "GET") {
    return json({ tenant: session.tid, email: session.email, name: session.name ?? null, dev: session.tid.startsWith("dev-") });
  }

  if (path === "/api/ws") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected websocket");
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    const fwd = new Request("https://hub/phone", {
      headers: { upgrade: "websocket", [H_KIND]: "phone", [H_TENANT]: session.tid, [H_EMAIL]: session.email },
    });
    return hubFor(env, session.tid).fetch(fwd);
  }

  if (path === "/api/machines" && request.method === "GET") {
    const r = unwrap(await hubFor(env, session.tid).listMachines());
    return r instanceof Response ? r : json({ machines: r.value });
  }

  if (path === "/api/usage" && request.method === "GET") {
    return json(await hubFor(env, session.tid).usage());
  }

  const revoke = /^\/api\/machines\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (revoke && request.method === "DELETE") {
    if (!sameOrigin(request, url)) return err(403, "bad origin");
    const r = unwrap(await hubFor(env, session.tid).revokeMachine(revoke[1]!));
    if (r instanceof Response) return r;
    return r.value ? json({ ok: true }) : err(404, "no such machine");
  }

  if (path === "/api/state" && request.method === "GET") {
    const r = unwrap(await hubFor(env, session.tid).snapshot());
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
    if (!allowed.ok) return tooMany(allowed.retryAfterMs, "too many pairing approvals on this account");
    const pairing = env.PAIRING.get(env.PAIRING.idFromName(`pair:${code}`));
    const claim = await pairing.beginApprove(publicLimits(env as unknown as Record<string, unknown>).approve_attempts_per_code);
    if (!claim.ok) return err(claim.status ?? 404, claim.error);
    const machineId = randomToken(12);
    let added = false;
    try {
      const name = body.machine_name || claim.hostname;
      const token = await mintMachineToken(env.SESSION_SECRET, session.tid, machineId);
      const machine = await hubFor(env, session.tid).addMachine(machineId, name, await sha256Hex(token), session.email);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
