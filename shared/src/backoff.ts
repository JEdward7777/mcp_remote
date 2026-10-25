/**
 * Exponential backoff with full jitter (D5): delay = random(0, min(cap, base * 2^attempt)),
 * never below `min`. Used by every reconnecting client (daemon, shim, PWA).
 */
export interface BackoffOptions {
  baseMs?: number;
  capMs?: number;
  minMs?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 60_000;
  const min = opts.minMs ?? 250;
  const rnd = opts.random ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.max(min, Math.floor(rnd() * exp));
}
