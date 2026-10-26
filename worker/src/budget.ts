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
 * Sizing (free plan shared by every tenant, D9): a phone message costs ~1/20 request (inbound WS
 * frame), a handful of rows written (message row + indexes + session counter) and the Hub
 * broadcast; so ~100k rows written/day is the first wall at roughly 15-20k messages/day for the
 * whole deployment. 500 messages per tenant per day lets ~20-30 active tenants share it.
 */
export interface TenantLimits {
  /** Phone -> session messages. */
  phone_send: Rate;
  /** Agent send_message (all sessions of the tenant together). */
  agent_send: Rate;
  /** launch / launch_stop / launch_restart / launch_dismiss from the phone. */
  launch: Rate;
  /** History page fetches. */
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
}

export type LimitName = Exclude<keyof TenantLimits, "daily_messages">;

export const PLANS: Record<string, TenantLimits> = {
  free: {
    phone_send: rate("10,20/min"),
    agent_send: rate("10,20/min"),
    launch: rate("20,20/min"),
    history: rate("20,60/min"),
    phone_frames: rate("60,120/min"),
    daemon_frames: rate("200,600/min"),
    connects: rate("20,20/min"),
    http: rate("30,60/min"),
    pair_approve: rate("5,10/h"),
    daily_messages: 500,
  },
};

export const DEFAULT_PLAN = "free";

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
};
export const DAILY_CAP_ENV = "DAILY_MESSAGE_CAP";

type EnvLike = Record<string, unknown>;
const warned = new Set<string>();
function warnOnce(key: string, v: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`ignoring invalid ${key}=${JSON.stringify(v)}; using the default`);
}

/** Limits for a plan: the plan's defaults, with env overrides applied to the free plan. Never throws. */
export function limitsFor(plan: string | null | undefined, env: EnvLike): TenantLimits {
  const base = PLANS[plan ?? DEFAULT_PLAN] ?? PLANS[DEFAULT_PLAN]!;
  if ((plan ?? DEFAULT_PLAN) !== DEFAULT_PLAN && PLANS[plan!]) return base;
  const out: TenantLimits = { ...base };
  for (const [name, key] of Object.entries(LIMIT_ENV) as [LimitName, string][]) {
    const v = env[key];
    if (typeof v !== "string" || v === "") continue;
    const r = parseRate(v);
    if (r) out[name] = r;
    else warnOnce(key, v);
  }
  const cap = env[DAILY_CAP_ENV];
  if (typeof cap === "string" && cap !== "") {
    if (/^\d{1,9}$/.test(cap.trim())) out.daily_messages = Number(cap.trim());
    else warnOnce(DAILY_CAP_ENV, cap);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unauthenticated endpoints (Worker level). Keyed by client IP (CF-Connecting-IP; IPv6 by /64).

export interface PublicLimits {
  /** /api/pair/start per IP: each start creates a Pairing DO (put + alarm + wipe later). */
  pair_start_ip: Rate;
  /** /api/pair/start for everyone together (split across THROTTLE_SHARDS shards). */
  pair_start_global: Rate;
  /** /api/pair/wait per IP, isolate-local only (a DO check would cost as much as the wait itself). */
  pair_wait_ip: Rate;
  /** /auth/login + /auth/callback per IP, isolate-local only (they never touch a DO). */
  auth_ip: Rate;
  /** Approve attempts on one existing pairing code before it locks (Pairing DO, persisted). */
  approve_attempts_per_code: number;
}

export const PUBLIC_DEFAULTS: PublicLimits = {
  pair_start_ip: rate("5,10/h"),
  pair_start_global: rate("80,120/h"),
  pair_wait_ip: rate("30,120/h"),
  auth_ip: rate("30,120/h"),
  approve_attempts_per_code: 5,
};

export const PUBLIC_ENV: Record<Exclude<keyof PublicLimits, "approve_attempts_per_code">, string> = {
  pair_start_ip: "LIMIT_PAIR_START_IP",
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
export const THROTTLE_SHARDS = 8;

// ---------------------------------------------------------------------------
// Usage accounting (Hub)

/** Flush the Hub's in-memory usage counters to SQLite after this many counted events (1 row write). */
export const USAGE_FLUSH_EVERY = 50;
/** Days of per-tenant usage rows kept (for Phase 4b's admin view). */
export const USAGE_KEEP_DAYS = 35;
