// Per-tenant Hub Durable Object (D4, D9). One instance per user, addressed by
// env.HUB.idFromName(tenantId). It owns that user's machines, sessions, messages and every
// phone / daemon WebSocket. Nothing in here can address another tenant's Hub.
import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_RATE_LIMITED,
  DaemonToHub,
  HISTORY_PAGE,
  HubToDaemon,
  HubToPhone,
  LaunchInfo,
  LaunchRecord,
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_MACHINE,
  MachineRecord,
  MessageRecord,
  PhoneToHub,
  SessionAnnounce,
  SessionRecord,
  Urgency,
  type UsageInfo,
  byteLength,
  humanWait,
  parseFrame,
} from "@mcp-remote/shared";
import { ATTACHMENT_BUDGET_BYTES, DEFAULT_PLAN, type LimitName, type TenantLimits, limitsFor } from "./budget";
import { timingSafeEqual } from "./crypto";
import { Env, H_EMAIL, H_KIND, H_MACHINE, H_TENANT, H_TOKEN_HASH } from "./env";
import { accountAllowed } from "./oauth";
import { type Bucket, Limiter, type LimiterSnapshot, take } from "./ratelimit";
import { type PendingSnap, USAGE_SCHEMA, type UsageDay, UsageMeter, msUntilUtcMidnight } from "./usage";

/**
 * Rate-limit buckets and unflushed usage counts, carried across hibernation in the attachment of
 * the socket that last changed them (no storage I/O). The newest generation `g` wins on wake.
 */
type HubSnap = { g: number; u?: PendingSnap; b?: LimiterSnapshot };

type Attachment = ({ kind: "phone" } | { kind: "daemon"; machine_id: string }) & { s?: HubSnap };

/** Result of an HTTP-facing RPC that is rate limited per tenant. */
export type Limited<T> = { ok: true; value: T } | { ok: false; retryAfterMs: number };

/** Buckets the Hub keeps in memory (pair_approve is persisted separately in meta). */
type MemLimit = Exclude<LimitName, "pair_approve">;

type MachineRow = {
  machine_id: string;
  name: string;
  token_hash: string | null;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
  /** JSON of the daemon's last `projects` frame (Phase 2); null until reported. */
  launch_caps: string | null;
  /** JSON array of the daemon's last `launches` snapshot. */
  launches_json: string | null;
};

const LaunchCaps = LaunchInfo.omit({ launches: true });

type SessionRow = {
  session_id: string;
  machine_id: string;
  project: string;
  cwd: string | null;
  online: number;
  last_seen: number;
  created_at: number;
};

type MessageRow = {
  id: number;
  session_id: string;
  direction: "in" | "out";
  text: string;
  urgency: string | null;
  created_at: number;
  delivered: number;
};

/** Close codes the daemon understands. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_REPLACED = 4002;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_POLICY = 1008;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_machine ON sessions(machine_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  urgency TEXT,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(session_id, direction, delivered);
CREATE INDEX IF NOT EXISTS messages_dir ON messages(session_id, direction, id);
${USAGE_SCHEMA}`;

/** Max messages per deliver frame (keeps the daemon's ack under DO SQLite's bound-parameter cap too). */
export const DELIVER_MAX_MESSAGES = 90;
/** Sessions kept per machine; beyond this the oldest offline ones (and their history) are evicted. */
export const MAX_STORED_SESSIONS_PER_MACHINE = 50;
/** Messages kept per session (soft: may exceed by < HISTORY_TRIM_SLACK, and while inbound messages are queued). */
export const MAX_HISTORY_PER_SESSION = 1000;
export const HISTORY_TRIM_SLACK = 50;

/** Byte budget for one deliver frame (must fit MAX_FRAME_BYTES once wrapped for IPC). */
const DELIVER_BYTES = MAX_FRAME_BYTES - 4096;
/** Byte budget for one history frame to the phone. */
const HISTORY_BYTES = 512 * 1024;

function msgBytes(m: MessageRecord): number {
  return byteLength(JSON.stringify(m)) + 1;
}

/** Leading items whose encoded size fits the budget (always at least one). */
export function takeWithinBudget(items: MessageRecord[], budget: number, maxCount = Infinity): MessageRecord[] {
  const out: MessageRecord[] = [];
  let used = 0;
  for (const m of items) {
    const b = msgBytes(m);
    if (out.length && (used + b > budget || out.length >= maxCount)) break;
    out.push(m);
    used += b;
  }
  return out;
}

export function chunkWithinBudget(items: MessageRecord[], budget: number, maxCount = Infinity): MessageRecord[][] {
  const out: MessageRecord[][] = [];
  let rest = items;
  while (rest.length) {
    const head = takeWithinBudget(rest, budget, maxCount);
    out.push(head);
    rest = rest.slice(head.length);
  }
  return out;
}

function toMessage(r: MessageRow): MessageRecord {
  const u = Urgency.safeParse(r.urgency);
  return {
    id: r.id,
    session_id: r.session_id,
    direction: r.direction,
    text: r.text,
    urgency: u.success ? u.data : null,
    created_at: r.created_at,
    delivered: r.delivered === 1,
  };
}

/** Stored launch columns -> LaunchInfo (null if never reported or unreadable). */
function launchInfo(m: MachineRow): LaunchInfo | null {
  if (!m.launch_caps) return null;
  try {
    const caps = LaunchCaps.safeParse(JSON.parse(m.launch_caps));
    if (!caps.success) return null;
    const l = m.launches_json ? LaunchRecord.array().safeParse(JSON.parse(m.launches_json)) : null;
    return { ...caps.data, launches: l?.success ? l.data : [] };
  } catch {
    return null;
  }
}

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;
  private limits: TenantLimits;
  private plan = DEFAULT_PLAN;
  private readonly limiter: Limiter<MemLimit>;
  readonly meter: UsageMeter;
  private woke = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    this.migrate();
    // Keepalive pings are answered by the runtime without waking the object (D5).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.limits = limitsFor(DEFAULT_PLAN, env as unknown as Record<string, unknown>);
    this.limiter = new Limiter<MemLimit>(this.limits);
    this.meter = new UsageMeter(this.sql);
  }

  // -------------------------------------------------------------------------
  // Per-tenant limits and usage (Phase 3, D10)

  /**
   * Once per wake: pick the tenant's plan, restore buckets + unflushed usage from the newest socket
   * attachment, and read today's usage row. Costs ~2 rows read per wake, nothing per message.
   */
  private wake(now: number): void {
    if (this.woke) return;
    this.woke = true;
    this.plan = this.getMeta("plan") ?? DEFAULT_PLAN;
    this.limits = limitsFor(this.plan, this.env as unknown as Record<string, unknown>);
    this.limiter.setRates(this.limits);
    let best: HubSnap | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const s = (ws.deserializeAttachment() as Attachment | null)?.s;
      if (s && typeof s.g === "number" && (!best || s.g > best.g)) best = s;
    }
    this.limiter.restore(best?.b);
    this.meter.load(now, best);
  }

  /**
   * Reconnect storms (a buggy client, many tabs) cost a DO request + a state frame each: cap them.
   * Returns the refusal response, or null when the connect may proceed.
   */
  private connectLimited(kind: "phone" | "daemon", now: number): Response | null {
    const wait = this.limited("connects", now);
    if (wait === null) return null;
    this.saveSnap(undefined, now);
    const secs = Math.ceil(wait / 1000);
    if (kind === "phone") {
      // A browser can't read an HTTP status on a failed upgrade: accept, then close with a reason.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(CLOSE_RATE_LIMITED, `too many connections; retry in ${secs}s`);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(`too many connections for this account; retry in ${secs}s`, {
      status: 429,
      headers: { "retry-after": String(secs) },
    });
  }

  /** Take one token; returns ms to wait when limited, else null. */
  private limited(name: MemLimit, now: number): number | null {
    const r = this.limiter.take(name, now);
    return r.ok ? null : r.retryAfterMs;
  }

  /** Remaining messages today under the plan's daily cap: ms until reset when exhausted, else null. */
  private overDailyCap(now: number): number | null {
    return this.meter.today(now).messages >= this.limits.daily_messages ? msUntilUtcMidnight(now) : null;
  }

  private dailyCapText(now: number): string {
    return (
      `daily message limit reached (${this.limits.daily_messages} messages per day on the "${this.plan}" plan, ` +
      `phone and agent together); it resets at 00:00 UTC, in ${humanWait(msUntilUtcMidnight(now))}`
    );
  }

  /** Carry limiter + usage state in this socket's attachment (survives hibernation; no storage). */
  private saveSnap(ws: WebSocket | undefined, now: number): void {
    const target = ws ?? this.ctx.getWebSockets()[0];
    if (!target) {
      // Nothing can carry the state across hibernation: write the counts now (rare: RPC with no sockets).
      this.meter.flush();
      return;
    }
    const att = target.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const u = this.meter.snapshot();
    const snap: HubSnap = { ...u, b: this.limiter.snapshot(now) };
    if (JSON.stringify(snap).length > ATTACHMENT_BUDGET_BYTES) delete snap.b; // never risk the attachment limit
    try {
      target.serializeAttachment({ ...att, s: snap } satisfies Attachment);
    } catch (e) {
      console.error("could not save hub snapshot", e);
    }
  }

  usageInfo(now = Date.now()): UsageInfo {
    this.wake(now);
    const t = this.meter.today(now);
    return {
      plan: this.plan,
      day: t.day,
      messages: t.messages,
      message_cap: this.limits.daily_messages,
      launches: t.launches,
      requests: t.requests,
    };
  }

  /** This tenant's usage, newest day first (for the phone and Phase 4b's admin view; never cross-tenant). */
  async usage(days = 35): Promise<Limited<{ plan: string; message_cap: number; days: UsageDay[] }>> {
    const now = Date.now();
    const wait = this.httpGate(now);
    if (wait !== null) return { ok: false, retryAfterMs: wait };
    return { ok: true, value: { plan: this.plan, message_cap: this.limits.daily_messages, days: this.meter.history(now, days) } };
  }

  /** Counts an HTTP-facing RPC and applies the tenant's `http` bucket. */
  private httpGate(now: number): number | null {
    this.wake(now);
    this.meter.add("requests", now);
    const wait = this.limited("http", now);
    this.saveSnap(undefined, now);
    return wait;
  }

  /**
   * Pairing approvals: a persisted bucket (one meta row; read 1, write 1 only when allowed), so a
   * hibernation can't hand out a fresh burst to someone guessing codes.
   */
  async allowPairApprove(now = Date.now()): Promise<{ ok: boolean; retryAfterMs: number }> {
    this.wake(now);
    this.meter.add("requests", now);
    let b: Bucket | undefined;
    try {
      const raw = this.getMeta("rl_pair_approve");
      const v = raw ? (JSON.parse(raw) as Bucket) : undefined;
      if (v && typeof v.t === "number" && typeof v.at === "number") b = v;
    } catch {
      /* corrupt: start full */
    }
    const r = take(b, this.limits.pair_approve, now);
    if (r.ok) {
      this.sql.exec(
        "INSERT INTO meta (k, v) VALUES ('rl_pair_approve', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        JSON.stringify(r.bucket),
      );
    }
    this.saveSnap(undefined, now);
    return { ok: r.ok, retryAfterMs: r.retryAfterMs };
  }

  /** Idempotent schema upgrades for Hubs created by earlier versions. */
  private migrate(): void {
    try {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN msg_count INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
    for (const col of ["launch_caps", "launches_json"]) {
      try {
        this.sql.exec(`ALTER TABLE machines ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists */
      }
    }
    if (!this.getMeta("msg_count_v1")) {
      // One-time backfill (per session, via the (session_id, id) index); guarded by the meta flag.
      this.sql.exec(
        "UPDATE sessions SET msg_count = (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.session_id)",
      );
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('msg_count_v1', '1')");
    }
  }

  // -------------------------------------------------------------------------
  // RPC used by the Worker (never reachable from outside it)

  async addMachine(machineId: string, name: string, tokenHash: string, email?: string): Promise<MachineRecord> {
    const now = Date.now();
    if (email) this.rememberEmail(email);
    this.sql.exec(
      "INSERT INTO machines (machine_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
      machineId,
      name,
      tokenHash,
      now,
    );
    this.broadcastState();
    return { machine_id: machineId, name, created_at: now, last_seen: null, online: false, revoked: false, launch: null };
  }

  /**
   * Called when a pairing expires without the daemon ever claiming its token: drop the machine
   * if it never connected, so no orphan record is left behind.
   */
  async removeUnclaimedMachine(machineId: string): Promise<boolean> {
    const n = this.sql
      .exec(
        "DELETE FROM machines WHERE machine_id = ? AND last_seen IS NULL AND NOT EXISTS (SELECT 1 FROM sessions WHERE machine_id = ?)",
        machineId,
        machineId,
      ).rowsWritten;
    if (n) this.broadcastState();
    return n > 0;
  }

  async listMachines(): Promise<Limited<MachineRecord[]>> {
    const wait = this.httpGate(Date.now());
    if (wait !== null) return { ok: false, retryAfterMs: wait };
    return { ok: true, value: this.machineRecords() };
  }

  async revokeMachine(machineId: string): Promise<Limited<boolean>> {
    const wait = this.httpGate(Date.now());
    if (wait !== null) return { ok: false, retryAfterMs: wait };
    return { ok: true, value: this.revoke(machineId) };
  }

  private revoke(machineId: string): boolean {
    const row = this.sql
      .exec<MachineRow>("SELECT * FROM machines WHERE machine_id = ? AND revoked_at IS NULL", machineId)
      .toArray()[0];
    if (!row) return false;
    const now = Date.now();
    this.sql.exec("UPDATE machines SET token_hash = NULL, revoked_at = ? WHERE machine_id = ?", now, machineId);
    this.sql.exec("UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1", now, machineId);
    for (const ws of this.ctx.getWebSockets(`m:${machineId}`)) {
      try {
        ws.close(CLOSE_REVOKED, "machine revoked");
      } catch {
        /* already closing */
      }
    }
    // Its session ids are free now: ask the other live daemons to re-announce, so a session that
    // was refused because of the collision is picked up without any polling.
    this.resyncDaemons(machineId);
    this.broadcastState();
    return true;
  }

  async snapshot(): Promise<Limited<{ machines: MachineRecord[]; sessions: SessionRecord[]; usage: UsageInfo }>> {
    const now = Date.now();
    const wait = this.httpGate(now);
    if (wait !== null) return { ok: false, retryAfterMs: wait };
    return { ok: true, value: { machines: this.machineRecords(), sessions: this.sessionRecords(), usage: this.usageInfo(now) } };
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade (forwarded by the Worker after it authenticated the caller)

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const kind = request.headers.get(H_KIND);
    const tenant = request.headers.get(H_TENANT);
    const now = Date.now();
    this.wake(now);
    this.meter.add("requests", now);
    if (tenant) this.rememberTenant(tenant);

    if (kind === "phone") {
      // The Worker already checked the session cookie and Origin.
      const limited = this.connectLimited(kind, now);
      if (limited) return limited;
      const email = request.headers.get(H_EMAIL);
      if (email) this.rememberEmail(email);
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["phone"]);
      server.serializeAttachment({ kind: "phone" } satisfies Attachment);
      this.saveSnap(server, now);
      this.sendPhone(server, this.stateFrame());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (kind === "daemon") {
      const machineId = request.headers.get(H_MACHINE) ?? "";
      const tokenHash = request.headers.get(H_TOKEN_HASH) ?? "";
      const row = this.sql
        .exec<MachineRow>("SELECT * FROM machines WHERE machine_id = ?", machineId)
        .toArray()[0];
      if (!row || row.revoked_at !== null || !row.token_hash || !timingSafeEqual(row.token_hash, tokenHash)) {
        return new Response("machine token revoked or unknown", { status: 401 });
      }
      // Sign-up gating is re-checked on every daemon connect, so removing an account from
      // ALLOWED_EMAILS also locks out its machines (D7/D9).
      const tid = tenant ?? this.getMeta("tenant") ?? "";
      if (!accountAllowed(tid, this.getMeta("email"), this.env)) {
        return new Response("account is no longer allowed to sign in", { status: 403 });
      }
      // Charged only after the token checked out, so a revoked/stolen token can't use up the budget.
      const limited = this.connectLimited(kind, now);
      if (limited) return limited;
      // One live socket per machine: a reconnecting daemon replaces a stale one.
      for (const old of this.ctx.getWebSockets(`m:${machineId}`)) {
        try {
          old.close(CLOSE_REPLACED, "replaced by a newer connection");
        } catch {
          /* ignore */
        }
      }
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["daemon", `m:${machineId}`]);
      server.serializeAttachment({ kind: "daemon", machine_id: machineId } satisfies Attachment);
      this.saveSnap(server, now);
      this.sql.exec("UPDATE machines SET last_seen = ? WHERE machine_id = ?", now, machineId);
      this.sendDaemon(server, { t: "welcome", machine_id: machineId, name: row.name });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("bad request", { status: 400 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) {
      ws.close(CLOSE_POLICY, "unknown socket");
      return;
    }
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      ws.close(CLOSE_TOO_BIG, "frame too large");
      return;
    }
    const now = Date.now();
    this.wake(now);
    this.meter.add("requests", now);
    try {
      this.onFrame(ws, att, message, now);
    } finally {
      this.saveSnap(ws, now);
    }
  }

  private onFrame(ws: WebSocket, att: Attachment, message: string | ArrayBuffer, now: number): void {
    // Coarse per-tenant frame budget: a client that floods is disconnected (it reconnects later,
    // after at least the hinted wait; see shared/link.ts).
    const flood = this.limited(att.kind === "phone" ? "phone_frames" : "daemon_frames", now);
    if (flood !== null) {
      ws.close(CLOSE_RATE_LIMITED, `rate limited: too many requests; retry in ${Math.ceil(flood / 1000)}s`);
      return;
    }
    if (att.kind === "phone") {
      const r = parseFrame(PhoneToHub, message);
      if (!r.ok) {
        if (r.error === "frame too large") ws.close(CLOSE_TOO_BIG, r.error);
        else this.sendPhone(ws, { t: "error", error: r.error });
        return;
      }
      this.onPhone(ws, r.value);
    } else {
      if (!this.machineActive(att.machine_id)) {
        ws.close(CLOSE_REVOKED, "machine revoked");
        return;
      }
      const r = parseFrame(DaemonToHub, message);
      if (!r.ok) {
        if (r.error === "frame too large") ws.close(CLOSE_TOO_BIG, r.error);
        else this.sendDaemon(ws, { t: "error", error: r.error });
        return;
      }
      this.onDaemon(ws, att.machine_id, r.value);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.wake(Date.now());
    this.onSocketGone(ws);
    // This socket may hold the newest snapshot: write unflushed counts now (one row; closes are rare).
    this.meter.flush();
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.wake(Date.now());
    this.onSocketGone(ws);
    this.meter.flush();
  }

  // -------------------------------------------------------------------------
  // Phone frames

  private onPhone(ws: WebSocket, f: PhoneToHub): void {
    const now = Date.now();
    switch (f.t) {
      case "refresh":
        this.sendPhone(ws, this.stateFrame());
        return;
      case "history": {
        const wait = this.limited("history", now);
        if (wait !== null) {
          this.sendPhone(ws, {
            t: "error",
            error: `rate limited: too many history requests; try again in ${humanWait(wait)}`,
            retry_after_s: Math.ceil(wait / 1000),
          });
          return;
        }
        const rows = this.sql
          .exec<MessageRow>(
            "SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
            f.session_id,
            f.before_id ?? Number.MAX_SAFE_INTEGER,
            HISTORY_PAGE + 1,
          )
          .toArray();
        // Newest first; stop at the page size or the byte budget, whichever comes first.
        const page = takeWithinBudget(rows.slice(0, HISTORY_PAGE).map(toMessage), HISTORY_BYTES);
        const has_more = rows.length > page.length;
        this.sendPhone(ws, { t: "history", session_id: f.session_id, messages: page.reverse(), has_more });
        return;
      }
      case "send": {
        const cap = this.overDailyCap(now);
        if (cap !== null) {
          this.sendPhone(ws, { t: "error", error: this.dailyCapText(now), client_id: f.client_id, retry_after_s: Math.ceil(cap / 1000) });
          return;
        }
        const wait = this.limited("phone_send", now);
        if (wait !== null) {
          this.sendPhone(ws, {
            t: "error",
            error: `rate limited: too many messages; try again in ${humanWait(wait)}`,
            client_id: f.client_id,
            retry_after_s: Math.ceil(wait / 1000),
          });
          return;
        }
        const s = this.getSession(f.session_id);
        if (!s) {
          this.sendPhone(ws, { t: "error", error: "unknown session", client_id: f.client_id });
          return;
        }
        if (!this.machineActive(s.machine_id)) {
          this.sendPhone(ws, {
            t: "error",
            error: "this session's computer was revoked; messages can no longer reach it",
            client_id: f.client_id,
          });
          return;
        }
        const row = this.insertMessage(f.session_id, "in", f.text, null, now, 0).row;
        this.meter.add("messages", now);
        const msg = toMessage(row);
        this.broadcastPhones({ t: "message", message: msg, client_id: f.client_id });
        // Deliver now if the session is live; otherwise it waits for session_up/hello.
        if (s.online === 1) {
          const d = this.daemonSocket(s.machine_id);
          if (d) this.sendDaemon(d, { t: "deliver", session_id: s.session_id, messages: [msg] });
        }
        return;
      }
      case "launch":
      case "launch_stop":
      case "launch_restart":
      case "launch_dismiss": {
        const wait = this.limited("launch", now);
        if (wait !== null) {
          this.sendPhone(ws, {
            t: "launch_result",
            client_id: f.client_id,
            ok: false,
            error: `rate limited: too many start/stop requests; try again in ${humanWait(wait)}`,
            retry_after_s: Math.ceil(wait / 1000),
          });
          return;
        }
        // Only routes the request; the daemon is the authority on which project ids it will launch.
        const m = this.sql
          .exec<{ revoked_at: number | null }>("SELECT revoked_at FROM machines WHERE machine_id = ?", f.machine_id)
          .toArray()[0];
        const d = m && m.revoked_at === null ? this.daemonSocket(f.machine_id) : undefined;
        if (!d) {
          this.sendPhone(ws, {
            t: "launch_result",
            client_id: f.client_id,
            ok: false,
            error: !m ? "unknown computer" : m.revoked_at !== null ? "this computer was revoked" : "this computer is offline",
          });
          return;
        }
        const req_id = f.client_id;
        const out: HubToDaemon =
          f.t === "launch"
            ? { t: "launch", req_id, project_id: f.project_id, continue: f.continue, ...(f.auto_restart !== undefined ? { auto_restart: f.auto_restart } : {}) }
            : f.t === "launch_restart"
              ? { t: "launch_restart", req_id, launch_id: f.launch_id, continue: f.continue }
              : { t: f.t, req_id, launch_id: f.launch_id };
        this.sendDaemon(d, out);
        if (f.t === "launch" || f.t === "launch_restart") this.meter.add("launches", now);
        return;
      }
      case "forget_session": {
        const s = this.getSession(f.session_id);
        if (!s) return;
        if (s.online === 1 && this.daemonSocket(s.machine_id)) {
          this.sendPhone(ws, { t: "error", error: "cannot forget an online session" });
          return;
        }
        this.sql.exec("DELETE FROM messages WHERE session_id = ?", f.session_id);
        this.sql.exec("DELETE FROM sessions WHERE session_id = ?", f.session_id);
        this.resyncDaemons(); // the id is free now; a computer refused it may claim it
        this.broadcastState();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Daemon frames

  private onDaemon(ws: WebSocket, machineId: string, f: DaemonToHub): void {
    const now = Date.now();
    switch (f.t) {
      case "hello": {
        this.sql.exec("UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1", now, machineId);
        for (const s of f.sessions) {
          const err = this.upsertSession(machineId, s, now);
          if (err) this.sendDaemon(ws, { t: "error", error: err, session_id: s.session_id });
        }
        for (const s of f.sessions) this.flushPending(ws, machineId, s.session_id);
        this.broadcastState();
        return;
      }
      case "session_up": {
        const err = this.upsertSession(machineId, f.session, now);
        if (err) {
          this.sendDaemon(ws, { t: "error", error: err, session_id: f.session.session_id });
          return;
        }
        this.flushPending(ws, machineId, f.session.session_id);
        this.broadcastState();
        return;
      }
      case "session_down": {
        this.sql.exec(
          "UPDATE sessions SET online = 0, last_seen = ? WHERE session_id = ? AND machine_id = ?",
          now,
          f.session_id,
          machineId,
        );
        this.broadcastState();
        return;
      }
      case "send": {
        const cap = this.overDailyCap(now);
        if (cap !== null) {
          this.sendDaemon(ws, { t: "error", error: this.dailyCapText(now), req_id: f.req_id, retry_after_s: Math.ceil(cap / 1000) });
          return;
        }
        const wait = this.limited("agent_send", now);
        if (wait !== null) {
          this.sendDaemon(ws, {
            t: "error",
            error: `rate limited: too many messages from your sessions (${this.rateText("agent_send")}); try again in ${humanWait(wait)}`,
            req_id: f.req_id,
            retry_after_s: Math.ceil(wait / 1000),
          });
          return;
        }
        const s = this.getSession(f.session_id);
        if (!s || s.machine_id !== machineId) {
          this.sendDaemon(ws, { t: "error", error: "unknown session", req_id: f.req_id });
          return;
        }
        const delivered = this.ctx.getWebSockets("phone").length > 0 ? 1 : 0;
        const row = this.insertMessage(f.session_id, "out", f.text, f.urgency, now, delivered).row;
        this.meter.add("messages", now);
        const msg = toMessage(row);
        this.sendDaemon(ws, { t: "sent", req_id: f.req_id, message_id: msg.id });
        this.broadcastPhones({ t: "message", message: msg });
        return;
      }
      case "projects": {
        const caps = { projects: f.projects, available: f.available, launch_error: f.launch_error, max_sessions: f.max_sessions };
        // Sent on every reconnect; only a real change costs a state broadcast.
        const w = this.sql.exec(
          "UPDATE machines SET launch_caps = ?1 WHERE machine_id = ?2 AND launch_caps IS NOT ?1",
          JSON.stringify(caps),
          machineId,
        ).rowsWritten;
        if (w) this.broadcastState();
        return;
      }
      case "launches": {
        // One row write, no reads; phones get a small frame instead of a full state.
        const w = this.sql.exec(
          "UPDATE machines SET launches_json = ?1 WHERE machine_id = ?2 AND launches_json IS NOT ?1",
          JSON.stringify(f.launches),
          machineId,
        ).rowsWritten;
        if (w) this.broadcastPhones({ t: "launches", machine_id: machineId, launches: f.launches });
        return;
      }
      case "launch_result": {
        this.broadcastPhones({ t: "launch_result", client_id: f.req_id, ok: f.ok, ...(f.error ? { error: f.error } : {}) });
        return;
      }
      case "ack": {
        const s = this.getSession(f.session_id);
        if (!s || s.machine_id !== machineId) return;
        // One JSON parameter instead of one per id: DO SQLite caps bound parameters at 100.
        const ids = [...new Set(f.ids)];
        const updated = this.sql
          .exec<{ id: number }>(
            "UPDATE messages SET delivered = 1 WHERE session_id = ? AND direction = 'in' AND delivered = 0 AND id IN (SELECT value FROM json_each(?)) RETURNING id",
            f.session_id,
            JSON.stringify(ids),
          )
          .toArray()
          .map((r) => r.id);
        if (updated.length) this.broadcastPhones({ t: "delivered", session_id: f.session_id, ids: updated });
        return;
      }
    }
  }

  /**
   * The only message write path. Keeps sessions.msg_count in step and trims history only once every
   * HISTORY_TRIM_SLACK inserts above the cap, so the amortized rows read per insert stay small
   * (a trim walks ~HISTORY_TRIM_SLACK index entries from the oldest end). Undelivered inbound
   * messages are never trimmed: the cap is soft while messages are queued for an offline session.
   * Returns rowsRead for tests.
   */
  insertMessage(
    sessionId: string,
    direction: "in" | "out",
    text: string,
    urgency: string | null,
    now: number,
    delivered: 0 | 1,
  ): { row: MessageRow; rowsRead: number } {
    const ins = this.sql.exec<MessageRow>(
      "INSERT INTO messages (session_id, direction, text, urgency, created_at, delivered) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      sessionId,
      direction,
      text,
      urgency,
      now,
      delivered,
    );
    const row = ins.one();
    let rowsRead = ins.rowsRead;
    const upd = this.sql.exec<{ msg_count: number }>(
      "UPDATE sessions SET msg_count = msg_count + 1, last_seen = ? WHERE session_id = ? RETURNING msg_count",
      now,
      sessionId,
    );
    const count = upd.one().msg_count;
    rowsRead += upd.rowsRead;
    if (count > MAX_HISTORY_PER_SESSION && count % HISTORY_TRIM_SLACK === 0) {
      const del = this.sql.exec<{ id: number }>(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE session_id = ? AND NOT (direction = 'in' AND delivered = 0)
           ORDER BY id ASC LIMIT ?) RETURNING id`,
        sessionId,
        count - MAX_HISTORY_PER_SESSION,
      );
      const removed = del.toArray().length;
      rowsRead += del.rowsRead;
      if (removed) {
        const dec = this.sql.exec("UPDATE sessions SET msg_count = msg_count - ? WHERE session_id = ?", removed, sessionId);
        rowsRead += dec.rowsRead;
      }
    }
    return { row, rowsRead };
  }

  private upsertSession(machineId: string, s: SessionAnnounce, now: number): string | null {
    const existing = this.getSession(s.session_id);
    if (existing && existing.machine_id !== machineId && this.machineActive(existing.machine_id)) {
      // Only a revoked owner gives a session id up (e.g. re-pairing a computer). Two active
      // computers announcing the same id is a configuration error: refuse it rather than
      // bouncing the session (and its pending messages) between them.
      const owner = this.sql
        .exec<{ name: string }>("SELECT name FROM machines WHERE machine_id = ?", existing.machine_id)
        .toArray()[0]?.name;
      return (
        `session id "${s.session_id}" is already used by another computer on this account ` +
        `("${owner ?? existing.machine_id}"). If that computer was re-paired or is gone, revoke it on the phone ` +
        "under Machines; otherwise give each computer its own MCP_REMOTE_SESSION_ID (or unset it)"
      );
    }
    if (!existing || existing.machine_id !== machineId) {
      // New to this machine (brand new, or taken over from a revoked one): apply the same limits.
      const count = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE machine_id = ? AND online = 1", machineId)
        .one().n;
      if (count >= MAX_SESSIONS_PER_MACHINE) return "too many live sessions on this machine";
      this.evictOldSessions(machineId, MAX_STORED_SESSIONS_PER_MACHINE - 1);
    }
    if (!existing) {
      this.sql.exec(
        "INSERT INTO sessions (session_id, machine_id, project, cwd, online, last_seen, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        s.session_id,
        machineId,
        s.project,
        s.cwd ?? null,
        now,
        now,
      );
    } else {
      this.sql.exec(
        "UPDATE sessions SET machine_id = ?, project = ?, cwd = ?, online = 1, last_seen = ? WHERE session_id = ?",
        machineId,
        s.project,
        s.cwd ?? null,
        now,
        s.session_id,
      );
    }
    return null;
  }

  /**
   * Keep at most `keep` sessions for a machine by deleting offline ones: first those that never had a
   * message (e.g. sessions that came and went without anyone writing), then the least recently active.
   */
  private evictOldSessions(machineId: string, keep: number): void {
    const victims = this.sql
      .exec<{ session_id: string }>(
        `SELECT s.session_id FROM sessions s WHERE s.machine_id = ? AND s.online = 0
         ORDER BY s.msg_count > 0 ASC,
           MAX(s.last_seen, COALESCE((SELECT created_at FROM messages m WHERE m.session_id = s.session_id ORDER BY id DESC LIMIT 1), 0)) ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM sessions WHERE machine_id = ?) - ?)`,
        machineId,
        machineId,
        keep,
      )
      .toArray();
    for (const v of victims) {
      this.sql.exec("DELETE FROM messages WHERE session_id = ?", v.session_id);
      this.sql.exec("DELETE FROM sessions WHERE session_id = ?", v.session_id);
    }
    // Freed ids may be what another computer was refused; the evicting machine already knows.
    if (victims.length) this.resyncDaemons(machineId);
  }

  /**
   * Ask live daemons (except `exceptMachine`) to re-send hello because a session id may have
   * become free. Only sent on revoke/forget/evict, never in reply to a hello, so it cannot loop.
   */
  private resyncDaemons(exceptMachine?: string): void {
    for (const ws of this.ctx.getWebSockets("daemon")) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.kind === "daemon" && a.machine_id !== exceptMachine) this.sendDaemon(ws, { t: "resync" });
    }
  }

  private flushPending(ws: WebSocket, machineId: string, sessionId: string): void {
    const s = this.getSession(sessionId);
    if (!s || s.machine_id !== machineId || s.online !== 1) return;
    const rows = this.sql
      .exec<MessageRow>(
        "SELECT * FROM messages WHERE session_id = ? AND direction = 'in' AND delivered = 0 ORDER BY id LIMIT 2000",
        sessionId,
      )
      .toArray();
    // Several frames if needed: each must fit the daemon -> shim IPC frame limit.
    for (const batch of chunkWithinBudget(rows.map(toMessage), DELIVER_BYTES, DELIVER_MAX_MESSAGES)) {
      this.sendDaemon(ws, { t: "deliver", session_id: sessionId, messages: batch });
    }
  }

  private onSocketGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.kind !== "daemon") return;
    // Only mark the machine offline if no other (newer) socket for it is still open.
    const others = this.ctx
      .getWebSockets(`m:${att.machine_id}`)
      .filter((o) => o !== ws && o.readyState === WebSocket.OPEN);
    if (others.length) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1",
      now,
      att.machine_id,
    );
    this.sql.exec("UPDATE machines SET last_seen = ? WHERE machine_id = ?", now, att.machine_id);
    this.broadcastState(ws);
  }

  // -------------------------------------------------------------------------
  // Queries / helpers

  private rememberTenant(tenant: string): void {
    // The tenant record (D10): its id and its plan, which selects the limits (only "free" exists yet;
    // a future billing step changes this row). Both are no-ops once set.
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('tenant', ?), ('plan', ?)", tenant, DEFAULT_PLAN);
  }

  private rememberEmail(email: string): void {
    // No write when unchanged (this runs on every phone connect).
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES ('email', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE v IS NOT excluded.v",
      email,
    );
  }

  private getMeta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private machineActive(machineId: string): boolean {
    return (
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM machines WHERE machine_id = ? AND revoked_at IS NULL",
          machineId,
        )
        .one().n > 0
    );
  }

  private getSession(sessionId: string): SessionRow | undefined {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", sessionId).toArray()[0];
  }

  private daemonSocket(machineId: string, exclude?: WebSocket): WebSocket | undefined {
    return this.ctx
      .getWebSockets(`m:${machineId}`)
      .find((w) => w !== exclude && w.readyState === WebSocket.OPEN);
  }

  private liveMachines(exclude?: WebSocket): Set<string> {
    const live = new Set<string>();
    for (const w of this.ctx.getWebSockets("daemon")) {
      if (w === exclude || w.readyState !== WebSocket.OPEN) continue;
      const a = w.deserializeAttachment() as Attachment | null;
      if (a?.kind === "daemon") live.add(a.machine_id);
    }
    return live;
  }

  private machineRecords(exclude?: WebSocket): MachineRecord[] {
    const live = this.liveMachines(exclude);
    return this.sql
      .exec<MachineRow>("SELECT * FROM machines ORDER BY created_at")
      .toArray()
      .map((m) => ({
        machine_id: m.machine_id,
        name: m.name,
        created_at: m.created_at,
        last_seen: m.last_seen,
        online: m.revoked_at === null && live.has(m.machine_id),
        revoked: m.revoked_at !== null,
        launch: launchInfo(m),
      }));
  }

  private sessionRecords(exclude?: WebSocket): SessionRecord[] {
    const live = this.liveMachines(exclude);
    type Row = SessionRow & { last_message_at: number | null; last_urgency: string | null; pending_in: number };
    return this.sql
      .exec<Row>(
        `SELECT s.*,
           (SELECT created_at FROM messages m WHERE m.session_id = s.session_id ORDER BY id DESC LIMIT 1) AS last_message_at,
           (SELECT urgency FROM messages m WHERE m.session_id = s.session_id AND m.direction = 'out' ORDER BY id DESC LIMIT 1) AS last_urgency,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id AND m.direction = 'in' AND m.delivered = 0) AS pending_in
         FROM sessions s ORDER BY s.machine_id, s.project, s.created_at`,
      )
      .toArray()
      .map((s) => {
        const u = Urgency.safeParse(s.last_urgency);
        return {
          session_id: s.session_id,
          machine_id: s.machine_id,
          project: s.project,
          cwd: s.cwd,
          online: s.online === 1 && live.has(s.machine_id),
          last_seen: s.last_seen,
          last_message_at: s.last_message_at,
          last_urgency: u.success ? u.data : null,
          pending_in: s.pending_in,
        };
      });
  }

  private stateFrame(exclude?: WebSocket): HubToPhone {
    return { t: "state", machines: this.machineRecords(exclude), sessions: this.sessionRecords(exclude), usage: this.usageInfo() };
  }

  /** "20 per minute" for error texts. */
  private rateText(name: MemLimit): string {
    const r = this.limits[name];
    const unit = r.perMs === 60_000 ? "minute" : r.perMs === 3_600_000 ? "hour" : r.perMs === 1000 ? "second" : r.perMs === 86_400_000 ? "day" : `${r.perMs} ms`;
    return `${r.per} per ${unit}`;
  }

  private broadcastState(exclude?: WebSocket): void {
    if (this.ctx.getWebSockets("phone").length === 0) return;
    this.broadcastPhones(this.stateFrame(exclude));
  }

  private broadcastPhones(frame: HubToPhone): void {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets("phone")) {
      try {
        ws.send(data);
      } catch {
        /* socket closing */
      }
    }
  }

  private sendPhone(ws: WebSocket, frame: HubToPhone): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closing */
    }
  }

  private sendDaemon(ws: WebSocket, frame: HubToDaemon): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closing */
    }
  }
}
