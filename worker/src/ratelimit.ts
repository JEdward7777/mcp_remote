// Token buckets (D10). Pure functions over a tiny state, so the same math backs the Hub's in-memory
// limiters, the persisted pairing-approval bucket and the Throttle DO. Time is always passed in.
import type { Rate } from "./budget";

/** Bucket state: tokens left at time `at` (ms). */
export interface Bucket {
  t: number;
  at: number;
}

export interface TakeResult {
  ok: boolean;
  bucket: Bucket;
  /** When !ok: ms until `cost` tokens are available again. */
  retryAfterMs: number;
}

/** Refill to `now`, then try to take `cost` tokens. A missing bucket starts full. */
export function take(b: Bucket | undefined, r: Rate, now: number, cost = 1): TakeResult {
  let t = b ? b.t : r.burst;
  const at = b ? b.at : now;
  if (now > at) t = Math.min(r.burst, t + ((now - at) * r.per) / r.perMs);
  // Clock went backwards (should not happen on Workers): keep the later reference point.
  const bucket = { t, at: Math.max(now, at) };
  if (t >= cost) {
    bucket.t = t - cost;
    return { ok: true, bucket, retryAfterMs: 0 };
  }
  return { ok: false, bucket, retryAfterMs: Math.ceil(((cost - t) * r.perMs) / r.per) };
}

/** Time at which a bucket would be full again (it can then be forgotten: a missing bucket is full). */
export function fullAt(b: Bucket, r: Rate): number {
  return b.at + Math.ceil(((r.burst - b.t) * r.perMs) / r.per);
}

/** Compact serialized form: name -> [tokens (2 decimals), at]. */
export type LimiterSnapshot = Record<string, [number, number]>;

/**
 * Named buckets for one tenant, in memory. `snapshot()` / `restore()` let the Hub carry the state
 * across hibernation inside a WebSocket attachment (no storage reads or writes).
 */
export class Limiter<N extends string> {
  private readonly buckets = new Map<N, Bucket>();

  constructor(private rates: Record<N, Rate>) {}

  setRates(rates: Record<N, Rate>): void {
    this.rates = rates;
  }

  take(name: N, now: number, cost = 1): TakeResult {
    const r = take(this.buckets.get(name), this.rates[name], now, cost);
    this.buckets.set(name, r.bucket);
    return r;
  }

  /** Buckets that are not full (a full one is the same as a missing one). */
  snapshot(now: number): LimiterSnapshot {
    const out: LimiterSnapshot = {};
    for (const [name, b] of this.buckets) {
      const rate = this.rates[name];
      if (!rate || fullAt(b, rate) <= now) continue;
      out[name] = [Math.floor(b.t * 100) / 100, b.at];
    }
    return out;
  }

  restore(s: LimiterSnapshot | undefined | null): void {
    this.buckets.clear();
    if (!s || typeof s !== "object") return;
    for (const [name, v] of Object.entries(s)) {
      if (!Array.isArray(v) || v.length !== 2) continue;
      const [t, at] = v;
      if (typeof t !== "number" || typeof at !== "number" || !(name in this.rates)) continue;
      this.buckets.set(name as N, { t, at });
    }
  }
}
