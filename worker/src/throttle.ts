// Unauthenticated abuse protection (Phase 3). Per-IP (and per-shard "everyone") token buckets for
// endpoints that would otherwise wake Durable Objects for anyone on the internet, chiefly
// /api/pair/start (each call creates a Pairing DO: a put, an alarm, and a wipe later).
//
// Cost per checked request: one Throttle DO request; ~1 row read when the bucket is not cached in
// memory, and one row written only when the request is ALLOWED (a refused request writes nothing).
// The Worker also remembers refusals in isolate memory, so a client that keeps hammering the same
// isolate is turned away without any DO request at all. Object count is bounded (THROTTLE_SHARDS)
// and rows of buckets that have refilled are deleted opportunistically (no alarms).
import { DurableObject } from "cloudflare:workers";
import { type PublicLimits, type Rate, THROTTLE_SHARDS } from "./budget";
import type { Env } from "./env";
import { type Bucket, fullAt, take } from "./ratelimit";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS buckets (
  k TEXT PRIMARY KEY,
  t REAL NOT NULL,
  at INTEGER NOT NULL,
  full_at INTEGER NOT NULL
) WITHOUT ROWID;
DROP INDEX IF EXISTS buckets_full;
`;

const CACHE_MAX = 4096;
const CLEANUP_EVERY = 32;
const CLEANUP_BATCH = 64;

export interface ThrottleCheck {
  key: string;
  rate: Rate;
}

export interface ThrottleResult {
  ok: boolean;
  retryAfterMs: number;
  /** For tests: SQL cost of this call. */
  rowsRead: number;
  rowsWritten: number;
}

export class Throttle extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly cache = new Map<string, Bucket | null>();
  private writes = 0;
  /** Where the bounded cleanup scan continues (key order; restarts from the top at the end / on wake). */
  private scanFrom = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  /** All-or-nothing: either every check passes and all buckets are charged, or none is. */
  async hit(checks: ThrottleCheck[], now = Date.now()): Promise<ThrottleResult> {
    let rowsRead = 0;
    let rowsWritten = 0;
    const results = checks.map((c) => {
      let b = this.cache.get(c.key);
      if (b === undefined) {
        const cur = this.sql.exec<{ t: number; at: number }>("SELECT t, at FROM buckets WHERE k = ?", c.key);
        const row = cur.toArray()[0];
        rowsRead += cur.rowsRead;
        b = row ? { t: row.t, at: row.at } : null;
        this.remember(c.key, b);
      }
      return { c, r: take(b ?? undefined, c.rate, now) };
    });
    const refused = results.filter((x) => !x.r.ok);
    if (refused.length) {
      return { ok: false, retryAfterMs: Math.max(...refused.map((x) => x.r.retryAfterMs)), rowsRead, rowsWritten };
    }
    for (const { c, r } of results) {
      const cur = this.sql.exec(
        "INSERT INTO buckets (k, t, at, full_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(k) DO UPDATE SET t = ?2, at = ?3, full_at = ?4",
        c.key,
        r.bucket.t,
        r.bucket.at,
        fullAt(r.bucket, c.rate),
      );
      rowsWritten += cur.rowsWritten;
      rowsRead += cur.rowsRead;
      this.remember(c.key, r.bucket);
    }
    if (++this.writes % CLEANUP_EVERY === 0) {
      // A bucket that has refilled is the same as no bucket: forget it. No index on full_at (it would
      // double every write); instead walk the primary key CLEANUP_BATCH rows at a time.
      const scan = this.sql.exec<{ k: string; full_at: number }>(
        "SELECT k, full_at FROM buckets WHERE k > ? ORDER BY k LIMIT ?",
        this.scanFrom,
        CLEANUP_BATCH,
      );
      const rows = scan.toArray();
      rowsRead += scan.rowsRead;
      this.scanFrom = rows.length === CLEANUP_BATCH ? rows[rows.length - 1]!.k : "";
      const dead = rows.filter((x) => x.full_at < now).map((x) => x.k);
      if (dead.length) {
        const del = this.sql.exec("DELETE FROM buckets WHERE k IN (SELECT value FROM json_each(?))", JSON.stringify(dead));
        rowsWritten += del.rowsWritten;
        for (const k of dead) this.cache.delete(k);
      }
    }
    return { ok: true, retryAfterMs: 0, rowsRead, rowsWritten };
  }

  private remember(k: string, b: Bucket | null): void {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(k, b);
  }
}

// ---------------------------------------------------------------------------
// Worker-side helpers

/** Client key from CF-Connecting-IP: IPv4 as is, IPv6 by its /64 (one host usually owns a whole /64). */
export function clientKey(request: Request): string {
  const raw = (request.headers.get("cf-connecting-ip") ?? "").trim().toLowerCase();
  if (!raw) return "ip:unknown";
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (v4) return `ip:${v4[1]}`;
  if (!/^[0-9a-f:]+$/.test(raw) || raw.length > 45) return "ip:invalid";
  const [head = "", tail] = raw.split("::", 2) as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  const prefix = groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, ""));
  while (prefix.length < 4) prefix.push("0");
  return `ip6:${prefix.join(":")}::/64`;
}

/** "ip6:a:b:c:d::/64" -> "ip6:a:b:c::/48"; null for IPv4 / unknown. */
export function ip48(key: string): string | null {
  const m = /^ip6:([0-9a-f]+):([0-9a-f]+):([0-9a-f]+):[0-9a-f]+::\/64$/.exec(key);
  return m ? `ip6:${m[1]}:${m[2]}:${m[3]}::/48` : null;
}

/** FNV-1a, for picking a shard. */
export function shardOf(key: string, shards = THROTTLE_SHARDS): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % shards;
}

/** One shard's share of a limit meant for everyone together. */
export function perShard(r: Rate, shards = THROTTLE_SHARDS): Rate {
  return { burst: Math.max(1, Math.ceil(r.burst / shards)), per: r.per / shards, perMs: r.perMs };
}

/** Isolate-local memory (free, best effort): refusals we already know about, and small local buckets. */
const knownRefusals = new Map<string, number>();
const localBuckets = new Map<string, Bucket>();
const LOCAL_MAX = 4096;

export function resetIsolateThrottles(): void {
  knownRefusals.clear();
  localBuckets.clear();
}

/** Best-effort, zero-cost limiter for endpoints that never touch a DO (per isolate, not global). */
export function localHit(key: string, rate: Rate, now = Date.now()): { ok: boolean; retryAfterMs: number } {
  if (localBuckets.size >= LOCAL_MAX) localBuckets.clear();
  const r = take(localBuckets.get(key), rate, now);
  localBuckets.set(key, r.bucket);
  return { ok: r.ok, retryAfterMs: r.retryAfterMs };
}

/**
 * /api/pair/start gate: optional Workers Rate Limiting binding (UNVERIFIED on the free plan, see
 * budget.ts) -> isolate memory of earlier refusals -> the Throttle shard (per IP + per-shard share
 * of the global limit).
 */
export async function checkPairStart(
  env: Env,
  request: Request,
  limits: PublicLimits,
  now = Date.now(),
): Promise<{ ok: boolean; retryAfterMs: number }> {
  const ip = clientKey(request);
  if (env.PAIR_START_RATE_LIMITER) {
    try {
      const r = await env.PAIR_START_RATE_LIMITER.limit({ key: ip });
      if (!r.success) return { ok: false, retryAfterMs: 60_000 };
    } catch (e) {
      console.error("rate limit binding failed; falling back to the Throttle DO", e);
    }
  }
  const key = `ps:${ip}`;
  const until = knownRefusals.get(key);
  if (until !== undefined) {
    if (until > now) return { ok: false, retryAfterMs: until - now };
    knownRefusals.delete(key);
  }
  // IPv6: one site usually owns a /48 and can rotate through its /64s, so the /48 gets its own (larger)
  // bucket in the same call; sharding by the /48 keeps both keys in one Throttle object.
  const net48 = ip48(ip);
  const shard = shardOf(net48 ?? ip);
  const stub = env.THROTTLE.get(env.THROTTLE.idFromName(`shard:${shard}`));
  const checks: ThrottleCheck[] = [
    { key, rate: limits.pair_start_ip },
    { key: `ps:*`, rate: perShard(limits.pair_start_global) },
  ];
  if (net48) checks.push({ key: `ps:${net48}`, rate: limits.pair_start_ip48 });
  const r = await stub.hit(checks, now);
  if (!r.ok) {
    if (knownRefusals.size >= LOCAL_MAX) knownRefusals.clear();
    knownRefusals.set(key, now + r.retryAfterMs);
  }
  return { ok: r.ok, retryAfterMs: r.retryAfterMs };
}
