// The one place for Cloudflare free-plan numbers (D5) and the per-tenant limits derived from them
// (D10). Every Cloudflare number below says where it came from. developers.cloudflare.com was not
// reachable while this was written, so most are marked UNVERIFIED: check them against the doc page
// named next to each one (harness/SETUP.md, "Verify at the desk", lists them all).
//
// Sources that WERE checked (shipped in node_modules, versions as installed):
//   wrangler@4.152.0 config-schema.json, @cloudflare/workers-types@5.20261025.1 index.d.ts,
//   workerd@1.20261019.1 (local runtime probed with a throwaway vitest-pool-workers test).

export const FREE_PLAN = {
  /** UNVERIFIED (D5, from memory). Doc: https://developers.cloudflare.com/workers/platform/limits/ ("Worker requests", Free: 100,000/day). */
  workersRequestsPerDay: 100_000,
  /** UNVERIFIED. Doc: https://developers.cloudflare.com/workers/platform/limits/#cpu-time (Free: 10 ms per invocation). */
  workersCpuMsPerInvocation: 10,
  /** UNVERIFIED. Doc: https://developers.cloudflare.com/durable-objects/platform/pricing/ (Free: 100,000 requests/day). */
  doRequestsPerDay: 100_000,
  /** UNVERIFIED. Doc: https://developers.cloudflare.com/durable-objects/platform/pricing/ (Free: 13,000 GB-s/day duration). */
  doDurationGbSecondsPerDay: 13_000,
  /** UNVERIFIED. Doc: https://developers.cloudflare.com/durable-objects/platform/pricing/ (SQLite storage, Free: 5 million rows read/day). */
  sqliteRowsReadPerDay: 5_000_000,
  /** UNVERIFIED. Same page (Free: 100,000 rows written/day). */
  sqliteRowsWrittenPerDay: 100_000,
  /** UNVERIFIED. Same page (Free: 5 GB stored data in total). */
  sqliteStorageBytes: 5 * 1024 ** 3,
  /**
   * UNVERIFIED (D5). Incoming WebSocket messages billed as requests at 20:1; outgoing messages and
   * the setWebSocketAutoResponse ping/pong assumed not to wake the object (so no duration).
   * Doc: https://developers.cloudflare.com/durable-objects/platform/pricing/ (WebSocket message billing)
   * and https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (auto-response).
   * Whether an auto-responded ping still counts toward the 20:1 request ratio is part of the check.
   */
  wsIncomingMessagesPerBilledRequest: 20,
  /**
   * UNVERIFIED. Doc: https://developers.cloudflare.com/durable-objects/platform/limits/ (WebSocket message size).
   * The shipped workerd binary has a compatibility flag `increase_websocket_message_size`, so a limit
   * exists and has been raised once; local workerd does not enforce one (probed: a 33 MiB frame got
   * through). We stay far below it anyway: MAX_FRAME_BYTES (shared/protocol.ts) is 64 KiB.
   */
  wsMaxMessageBytes: 1024 * 1024,
  /**
   * VERIFIED against local workerd@1.20261019.1: serializeAttachment() throws above 16384 bytes
   * ("A WebSocket 'attachment' cannot be larger than 16384 bytes"). Production may differ (older docs
   * said 2,048 bytes): our snapshots are kept under ATTACHMENT_BUDGET_BYTES to be safe either way.
   */
  wsAttachmentMaxBytes: 16_384,
  /**
   * Workers Rate Limiting binding: VERIFIED to exist in wrangler@4.152.0 config-schema.json
   * (`ratelimits: [{ name, namespace_id, simple: { limit, period: 10 | 60 } }]`) and in workers-types
   * (`RateLimit.limit({ key }) -> { success }`). UNVERIFIED: that it is available (and free) on the
   * Free plan. Doc: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
   * So it is optional here (PAIR_START_RATE_LIMITER, see SETUP.md); the Throttle DO is the default.
   */
  rateLimitBindingPeriodsS: [10, 60] as const,
  /** UNVERIFIED. How long an idle Durable Object stays in memory before hibernating/evicting (~10 s). Doc: https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ */
  doIdleEvictionMs: 10_000,
  /** UNVERIFIED. Cloudflare closes idle WebSockets after ~100 s without traffic; our 30 s ping keeps them open. Doc: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
  wsIdleTimeoutMs: 100_000,
} as const;

/** Snapshots stored in WebSocket attachments stay below this (well under even a 2 KiB limit). */
export const ATTACHMENT_BUDGET_BYTES = 1536;

// ---------------------------------------------------------------------------
// Rates

/** Token bucket: `burst` tokens, refilled continuously at `per` tokens per `perMs`. */
export interface Rate {
  burst: number;
  per: number;
  perMs: number;
}

const UNITS: Record<string, number> = { s: 1000, sec: 1000, min: 60_000, m: 60_000, h: 3_600_000, hour: 3_600_000, day: 86_400_000, d: 86_400_000 };

/** "10,20/min" -> burst 10, 20 tokens per minute. Units: s, min, h, day. */
export function parseRate(v: string): Rate | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\/\s*([a-z]+)\s*$/i.exec(v);
  if (!m) return null;
  const perMs = UNITS[m[3]!.toLowerCase()];
  const burst = Number(m[1]);
  const per = Number(m[2]);
  if (!perMs || !(burst >= 1) || !(per > 0) || burst > 1e6 || per > 1e9) return null;
  return { burst, per, perMs };
}

export function formatRate(r: Rate): string {
  const unit = Object.entries(UNITS).find(([, ms]) => ms === r.perMs)?.[0] ?? `${r.perMs}ms`;
  return `${r.burst},${r.per}/${unit}`;
}

const rate = (s: string): Rate => parseRate(s)!;

// ---------------------------------------------------------------------------
// Per-tenant limits (D10), enforced in the tenant's Hub. Owner-tunable via env vars.

/**
 * Daily per-tenant budget on the real cost drivers, as a share of each free daily limit: whatever one
 * tenant does, it can use at most `share` of the deployment's DO requests, rows read and rows written
 * per UTC day. When any of them is used up, the tenant's Hub refuses work until 00:00 UTC.
 */
export interface DailyBudget {
  /** DO requests: connects + HTTP API calls + inbound WebSocket frames / wsIncomingMessagesPerBilledRequest. */
  do_requests: number;
  rows_read: number;
  rows_written: number;
}

export function dailyBudget(sharePercent: number): DailyBudget {
  const f = sharePercent / 100;
  return {
    do_requests: Math.floor(FREE_PLAN.doRequestsPerDay * f),
    rows_read: Math.floor(FREE_PLAN.sqliteRowsReadPerDay * f),
    rows_written: Math.floor(FREE_PLAN.sqliteRowsWrittenPerDay * f),
  };
}

/**
 * Two layers per tenant:
 *  - per-minute token buckets below bound bursts (one noisy client, a loop);
 *  - the daily budget (`daily`, default 10% of each free daily limit) bounds the whole day. The
 *    per-minute rates alone do NOT (rate x 1440 is far above a fair daily share for frames, history
 *    and HTTP), which is why the daily budget exists.
 * Exhausting the shared free quota takes accounts whose shares add up to 100%: e.g. ten free accounts at
 * 10% each, or the owner (50%) plus five free accounts. Normal use (hundreds of messages a day) stays far
 * below a share.
 */
export interface TenantLimits {
  /** Phone -> session messages. */
  phone_send: Rate;
  /** Agent send_message (all sessions of the tenant together). */
  agent_send: Rate;
  /** launch / launch_stop / launch_restart / launch_dismiss from the phone. */
  launch: Rate;
  /** History page fetches (each reads up to HISTORY_PAGE rows; also charged to daily rows_read). */
  history: Rate;
  /** Any phone frame (refresh, forget, ...): exceeding it closes the socket with 4029. */
  phone_frames: Rate;
  /** Any daemon frame, all machines together: exceeding it closes the socket with 4029. */
  daemon_frames: Rate;
  /** WebSocket connects to the Hub (phones + daemons). */
  connects: Rate;
  /** Cookie-authenticated HTTP API calls that reach the Hub. */
  http: Rate;
  /** Pairing approvals (successful or not), persisted so hibernation can't reset it. */
  pair_approve: Rate;
  /** Messages (in + out) per UTC day. */
  daily_messages: number;
  /**
   * Computers (paired, plus revoked ones that still have sessions) per account. Also what bounds the cost
   * of any single call: a state frame reads at most max_machines x MAX_STORED_SESSIONS_PER_MACHINE sessions.
   */
  max_machines: number;
  /** Phone connects while the daily budget is used up (each one only gets the reason, no SQL). */
  blocked_connects: Rate;
  /** Share (%) of each free daily limit this tenant may use; `daily` is derived from it. */
  daily_share_percent: number;
  daily: DailyBudget;
}

export type LimitName = Exclude<keyof TenantLimits, "daily_messages" | "daily_share_percent" | "daily" | "max_machines">;

const FREE_SHARE = 10;
const OWNER_SHARE = 50;

export const PLANS: Record<string, TenantLimits> = {
  free: {
    phone_send: rate("10,20/min"),
    agent_send: rate("10,20/min"),
    launch: rate("20,20/min"),
    history: rate("20,20/min"),
    phone_frames: rate("60,60/min"),
    daemon_frames: rate("200,120/min"),
    connects: rate("20,10/min"),
    http: rate("30,30/min"),
    pair_approve: rate("5,10/h"),
    daily_messages: 500,
    max_machines: 10,
    blocked_connects: rate("5,6/h"),
    daily_share_percent: FREE_SHARE,
    daily: dailyBudget(FREE_SHARE),
  },
  /**
   * The deployer's own account(s) (OWNER_EMAILS, or meta.plan = "owner"): roomier, but still capped
   * (default 50% of each free daily limit) so a runaway loop can't take the whole quota.
   */
  owner: {
    phone_send: rate("30,60/min"),
    agent_send: rate("30,60/min"),
    launch: rate("30,30/min"),
    history: rate("40,60/min"),
    phone_frames: rate("120,240/min"),
    daemon_frames: rate("400,600/min"),
    connects: rate("40,30/min"),
    http: rate("60,120/min"),
    pair_approve: rate("10,20/h"),
    daily_messages: 5000,
    max_machines: 30,
    blocked_connects: rate("10,12/h"),
    daily_share_percent: OWNER_SHARE,
    daily: dailyBudget(OWNER_SHARE),
  },
};

export const DEFAULT_PLAN = "free";
export const OWNER_PLAN = "owner";

/** Env var that overrides each limit of the free plan, e.g. LIMIT_PHONE_SEND="10,20/min". */
export const LIMIT_ENV: Record<LimitName, string> = {
  phone_send: "LIMIT_PHONE_SEND",
  agent_send: "LIMIT_AGENT_SEND",
  launch: "LIMIT_LAUNCH",
  history: "LIMIT_HISTORY",
  phone_frames: "LIMIT_PHONE_FRAMES",
  daemon_frames: "LIMIT_DAEMON_FRAMES",
  connects: "LIMIT_CONNECTS",
  http: "LIMIT_HTTP",
  pair_approve: "LIMIT_PAIR_APPROVE",
  blocked_connects: "LIMIT_BLOCKED_CONNECTS",
};
export const MAX_MACHINES_ENV = "MAX_MACHINES";
export const DAILY_CAP_ENV = "DAILY_MESSAGE_CAP";
/** % of each free daily limit one free-plan tenant may use (1-100). */
export const SHARE_ENV = "TENANT_DAILY_SHARE_PERCENT";
/** % for owner-plan tenants (1-100). */
export const OWNER_SHARE_ENV = "OWNER_DAILY_SHARE_PERCENT";
/** Comma-separated emails whose accounts get the owner plan. */
export const OWNER_EMAILS_ENV = "OWNER_EMAILS";

type EnvLike = Record<string, unknown>;
const warned = new Set<string>();
function warnOnce(key: string, v: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`ignoring invalid ${key}=${JSON.stringify(v)}; using the default`);
}

function sharePercent(env: EnvLike, key: string, dflt: number): number {
  const v = env[key];
  if (typeof v !== "string" || v === "") return dflt;
  const n = Number(v.trim());
  if (/^\d{1,3}(\.\d+)?$/.test(v.trim()) && n > 0 && n <= 100) return n;
  warnOnce(key, v);
  return dflt;
}

/** True if `email` is listed in OWNER_EMAILS (case-insensitive). */
export function isOwnerEmail(email: string | null | undefined, env: EnvLike): boolean {
  const list = env[OWNER_EMAILS_ENV];
  if (!email || typeof list !== "string") return false;
  const e = email.trim().toLowerCase();
  return list.split(",").some((x) => x.trim().toLowerCase() === e && e !== "");
}

/** The plan a tenant runs on: owner by email, else its stored plan if known, else free. */
export function resolvePlan(stored: string | null | undefined, email: string | null | undefined, env: EnvLike): string {
  if (isOwnerEmail(email, env)) return OWNER_PLAN;
  return stored && PLANS[stored] ? stored : DEFAULT_PLAN;
}

/**
 * Limits for a plan. Free: defaults + LIMIT_* / DAILY_MESSAGE_CAP / TENANT_DAILY_SHARE_PERCENT overrides
 * (they apply to free-plan tenants only). Owner: its own defaults + OWNER_DAILY_SHARE_PERCENT. Never throws.
 */
export function limitsFor(plan: string | null | undefined, env: EnvLike): TenantLimits {
  const name = plan && PLANS[plan] ? plan : DEFAULT_PLAN;
  const base = PLANS[name]!;
  if (name === OWNER_PLAN) {
    const share = sharePercent(env, OWNER_SHARE_ENV, base.daily_share_percent);
    return { ...base, daily_share_percent: share, daily: dailyBudget(share) };
  }
  const out: TenantLimits = { ...base };
  for (const [n, key] of Object.entries(LIMIT_ENV) as [LimitName, string][]) {
    const v = env[key];
    if (typeof v !== "string" || v === "") continue;
    const r = parseRate(v);
    if (r) out[n] = r;
    else warnOnce(key, v);
  }
  const mm = env[MAX_MACHINES_ENV];
  if (typeof mm === "string" && mm !== "") {
    if (/^\d{1,4}$/.test(mm.trim()) && Number(mm.trim()) >= 1) out.max_machines = Number(mm.trim());
    else warnOnce(MAX_MACHINES_ENV, mm);
  }
  const cap = env[DAILY_CAP_ENV];
  if (typeof cap === "string" && cap !== "") {
    if (/^\d{1,9}$/.test(cap.trim())) out.daily_messages = Number(cap.trim());
    else warnOnce(DAILY_CAP_ENV, cap);
  }
  out.daily_share_percent = sharePercent(env, SHARE_ENV, base.daily_share_percent);
  out.daily = dailyBudget(out.daily_share_percent);
  return out;
}

// ---------------------------------------------------------------------------
// Unauthenticated endpoints (Worker level). Keyed by client IP (CF-Connecting-IP; IPv6 by /64).

export interface PublicLimits {
  /** /api/pair/start per IP: each start creates a Pairing DO (put + alarm + wipe later). */
  pair_start_ip: Rate;
  /** /api/pair/start per IPv6 /48 (one site can rotate through many /64s). */
  pair_start_ip48: Rate;
  /** /api/pair/start for everyone together (split across THROTTLE_SHARDS shards). */
  pair_start_global: Rate;
  /** /api/pair/wait per IP, isolate-local only (a DO check would cost as much as the wait itself). */
  pair_wait_ip: Rate;
  /** /auth/login + /auth/callback per IP, isolate-local only (they never touch a DO). */
  auth_ip: Rate;
  /** Approve attempts on one existing pairing code before it locks (Pairing DO, persisted). */
  approve_attempts_per_code: number;
}

/**
 * Rows written by one pairing start, end to end (Throttle bucket row, Pairing DO state put + alarm, the
 * wipe at expiry). ESTIMATE: ~7 measured by the Phase 3 round-2 reviewer in local workerd; 8 for margin.
 */
export const PAIR_START_ROWS_WRITTEN_EST = 8;
/** Share (%) of the free plan's daily rows written that unauthenticated pairing starts may use, all together. */
export const PAIR_START_GLOBAL_SHARE = 10;
const PAIR_START_GLOBAL_BURST = 20;
/** 10% of 100,000 rows/day / 8 rows per start / 24 h = 52 starts per hour for everyone together. */
export function pairStartGlobalPerHour(): number {
  return Math.floor((FREE_PLAN.sqliteRowsWrittenPerDay * PAIR_START_GLOBAL_SHARE) / 100 / PAIR_START_ROWS_WRITTEN_EST / 24);
}

export const PUBLIC_DEFAULTS: PublicLimits = {
  pair_start_ip: rate("5,10/h"),
  pair_start_ip48: rate("15,30/h"),
  pair_start_global: rate(`${PAIR_START_GLOBAL_BURST},${pairStartGlobalPerHour()}/h`),
  pair_wait_ip: rate("30,120/h"),
  auth_ip: rate("30,120/h"),
  approve_attempts_per_code: 5,
};

export const PUBLIC_ENV: Record<Exclude<keyof PublicLimits, "approve_attempts_per_code">, string> = {
  pair_start_ip: "LIMIT_PAIR_START_IP",
  pair_start_ip48: "LIMIT_PAIR_START_IP48",
  pair_start_global: "LIMIT_PAIR_START_GLOBAL",
  pair_wait_ip: "LIMIT_PAIR_WAIT_IP",
  auth_ip: "LIMIT_AUTH_IP",
};

export function publicLimits(env: EnvLike): PublicLimits {
  const out: PublicLimits = { ...PUBLIC_DEFAULTS };
  for (const [name, key] of Object.entries(PUBLIC_ENV) as [keyof typeof PUBLIC_ENV, string][]) {
    const v = env[key];
    if (typeof v !== "string" || v === "") continue;
    const r = parseRate(v);
    if (r) out[name] = r;
    else warnOnce(key, v);
  }
  return out;
}

/** Throttle DO shards for unauthenticated limits: bounded object count, spreads hot keys. */
export const THROTTLE_SHARDS = 4;

// ---------------------------------------------------------------------------
// Usage accounting (Hub)

/** Flush the Hub's in-memory usage counters to SQLite after this many counted events (1 row write). */
export const USAGE_FLUSH_EVERY = 50;
/** Days of per-tenant usage rows kept (for Phase 4b's admin view). */
export const USAGE_KEEP_DAYS = 35;
