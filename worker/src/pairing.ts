// Pending device pairings (D4). One Durable Object per pairing code, addressed by
// env.PAIRING.idFromName("pair:" + code). This lives outside every tenant Hub: nothing about
// a pairing touches a Hub until a signed-in user approves it.
import { DurableObject } from "cloudflare:workers";
import type { PairResult } from "@mcp-remote/shared";
import { sha256Hex, timingSafeEqual } from "./crypto";
import type { Env } from "./env";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** No I, L, O, 0, 1: easy to read off a terminal and type on a phone. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LEN = 8;
/**
 * Codes of pairings a signed-in user started from the app (Phase 4b one-line install): pre-approved, so
 * whoever redeems one gets a machine token for that account. They are only ever copy-pasted, so they are
 * twice as long (~79 bits) and can't be confused with the 8-character codes a computer prints.
 */
export const SIGNED_CODE_LEN = 16;

export function generateCode(len = CODE_LEN): string {
  // Rejection sampling keeps the distribution uniform.
  const out: string[] = [];
  const buf = new Uint8Array(32);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && out.length < len) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < len; i += 4) groups.push(out.slice(i, i + 4).join(""));
  return groups.join("-");
}

/** Canonical form used as the DO name: uppercase, alphabet only, no separators. */
export function normalizeCode(input: string, len = CODE_LEN): string | null {
  if (input.length > 64) return null;
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== len) return null;
  for (const ch of c) if (!CODE_ALPHABET.includes(ch)) return null;
  return c;
}

interface PairingState {
  pairing_id: string;
  poll_hash: string;
  hostname: string;
  expires_at: number;
  /** "presigned": started by a signed-in user (Phase 4b), waiting for a computer to redeem it. */
  status: "presigned" | "pending" | "approving" | "approved";
  /** Started by a signed-in user: `tid`/`email` are set from the start. */
  signed?: boolean;
  email?: string;
  /** How the starting account was admitted (session cookie claim), handed to the Hub with the machine. */
  adm?: "env" | "reg";
  /** Approve attempts on this code (Phase 3: locks after approve_attempts_per_code). */
  attempts?: number;
  result?: Extract<PairResult, { t: "approved" }>;
  /** Tenant that approved; used to drop the machine again if the token is never claimed. */
  tid?: string;
}

export class Pairing extends DurableObject<Env> {
  /** Frames that reached this instance, and how many of them read storage (tests: a flood stops at one). */
  framesHandled = 0;
  storageReads = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private async load(): Promise<PairingState | null> {
    const s = await this.ctx.storage.get<PairingState>("state");
    if (!s) return null;
    if (s.expires_at <= Date.now()) {
      await this.wipe();
      return null;
    }
    return s;
  }

  private async wipe(): Promise<void> {
    const s = await this.ctx.storage.get<PairingState>("state");
    if (s?.status === "approved" && s.result && s.tid) {
      // Approved but never claimed: remove the orphan machine (only if it never connected).
      try {
        await this.env.HUB.get(this.env.HUB.idFromName(s.tid)).removeUnclaimedMachine(s.result.machine_id);
      } catch (e) {
        console.error("could not remove unclaimed machine", e);
      }
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: "expired" } satisfies PairResult));
        ws.close(1000, "expired");
      } catch {
        /* ignore */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Returns false if this code is already in use (caller picks another). */
  async init(pairingId: string, pollSecret: string, hostname: string): Promise<{ ok: boolean; expires_at: number }> {
    if (await this.load()) return { ok: false, expires_at: 0 };
    const expires_at = Date.now() + PAIRING_TTL_MS;
    const state: PairingState = {
      pairing_id: pairingId,
      poll_hash: await sha256Hex(pollSecret),
      hostname,
      expires_at,
      status: "pending",
    };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(expires_at);
    return { ok: true, expires_at };
  }

  /**
   * A signed-in user started this pairing from the app (pre-approved for `tid`). The Worker charged it
   * to that account's Hub first; the global unauthenticated pair-start cap doesn't apply.
   */
  async initSigned(tid: string, email: string, adm: "env" | "reg" = "env"): Promise<{ ok: boolean; expires_at: number }> {
    if (await this.load()) return { ok: false, expires_at: 0 };
    const expires_at = Date.now() + PAIRING_TTL_MS;
    const state: PairingState = { pairing_id: "", poll_hash: "", hostname: "", expires_at, status: "presigned", signed: true, tid, email, adm };
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.setAlarm(expires_at);
    return { ok: true, expires_at };
  }

  /**
   * A computer redeems a signed code (`mcp-remote pair --code`): atomically moves it to "approving" and
   * records the computer's pairing id + poll secret hash (for the later claim). Locks after `maxAttempts`.
   */
  async redeem(
    pairingId: string,
    pollSecret: string,
    hostname: string,
    maxAttempts = Number.POSITIVE_INFINITY,
  ): Promise<{ ok: true; tid: string; email: string; adm: "env" | "reg" } | { ok: false; status: number; error: string }> {
    const s = await this.load();
    if (!s || !s.signed || !s.tid) return { ok: false, status: 404, error: "unknown or expired code; get a new install command from the app (Machines)" };
    const attempts = (s.attempts ?? 0) + 1;
    if (attempts > maxAttempts) return { ok: false, status: 429, error: "too many attempts for this code; get a new install command from the app" };
    s.attempts = attempts;
    if (s.status !== "presigned") {
      await this.ctx.storage.put("state", s);
      return { ok: false, status: 409, error: "this code was already used; get a new install command from the app" };
    }
    s.status = "approving";
    s.pairing_id = pairingId;
    s.poll_hash = await sha256Hex(pollSecret);
    s.hostname = hostname;
    await this.ctx.storage.put("state", s);
    return { ok: true, tid: s.tid, email: s.email ?? "", adm: s.adm ?? "env" };
  }

  /**
   * Atomically claim a pending pairing for approval. A code that has seen `maxAttempts` approve
   * attempts is locked (the computer must start a new pairing); a wrong code writes nothing.
   */
  async beginApprove(
    maxAttempts = Number.POSITIVE_INFINITY,
  ): Promise<{ ok: true; hostname: string } | { ok: false; error: string; status?: number }> {
    const s = await this.load();
    if (!s || s.signed) return { ok: false, error: "unknown or expired code" };
    const attempts = (s.attempts ?? 0) + 1;
    if (attempts > maxAttempts) {
      return {
        ok: false,
        status: 429,
        error: "too many approval attempts for this code; run `mcp-remote pair` on the computer again for a new code",
      };
    }
    s.attempts = attempts;
    if (s.status !== "pending") {
      await this.ctx.storage.put("state", s);
      return { ok: false, error: "code already used" };
    }
    s.status = "approving";
    await this.ctx.storage.put("state", s);
    return { ok: true, hostname: s.hostname };
  }

  async abortApprove(): Promise<void> {
    const s = await this.load();
    if (s && s.status === "approving") {
      s.status = s.signed ? "presigned" : "pending";
      await this.ctx.storage.put("state", s);
    }
  }

  async complete(result: Extract<PairResult, { t: "approved" }>, tid: string): Promise<void> {
    const s = await this.load();
    if (!s || s.status !== "approving") throw new Error("pairing not in approving state");
    s.status = "approved";
    s.result = result;
    s.tid = tid;
    await this.ctx.storage.put("state", s);
    const data = JSON.stringify(result);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  /** Daemon waits here over a hibernatable WebSocket (no polling). */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const s = await this.load();
    if (s?.signed) return new Response("unknown or expired pairing", { status: 404 });
    const url = new URL(request.url);
    const pairingId = url.searchParams.get("pairing_id") ?? "";
    const auth = request.headers.get("authorization") ?? "";
    const secret = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!s || !timingSafeEqual(s.pairing_id, pairingId) || !timingSafeEqual(s.poll_hash, await sha256Hex(secret))) {
      return new Response("unknown or expired pairing", { status: 404 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    const first: PairResult = s.status === "approved" && s.result ? s.result : { t: "pending", expires_at: s.expires_at };
    pair[1].send(JSON.stringify(first));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Only the Worker holds sockets to this object (see relayPairingWait in index.ts); it never sends
   * anything, so any frame is unexpected and closes that link without reading storage.
   */
  override async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    this.framesHandled++;
    this.closeSocket(ws, 1008, "unexpected frame");
  }

  /**
   * The daemon saved its token (HTTP POST /api/pair/claim, authenticated by pairing id + poll secret):
   * forget the pairing and close the wait links.
   */
  async claim(pairingId: string, pollSecret: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    this.storageReads++;
    const s = await this.load();
    if (!s || !timingSafeEqual(s.pairing_id, pairingId) || !timingSafeEqual(s.poll_hash, await sha256Hex(pollSecret))) {
      return { ok: false, status: 404, error: "unknown or expired pairing" };
    }
    if (s.status !== "approved") return { ok: false, status: 409, error: "not approved yet" };
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    for (const w of this.ctx.getWebSockets()) this.closeSocket(w, 1000, "done");
    return { ok: true };
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* ignore */
    }
  }

  override async alarm(): Promise<void> {
    await this.wipe();
  }
}
