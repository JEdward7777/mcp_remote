// Per-tenant usage counters (Phase 3 cost accounting, D10/D13). Lives inside one tenant's Hub and
// only ever reads that Hub's own table (D9). Hot path cost: zero rows read, and one row written per
// USAGE_FLUSH_EVERY counted events (amortized), plus one at socket close / day rollover.
//
// Not-yet-flushed counts survive hibernation inside a WebSocket attachment (see Hub.saveSnap): each
// snapshot carries a generation number `g`, and the usage row stores the generation of its last
// flush, so a stale snapshot (taken before a flush) is never counted twice.
import { USAGE_FLUSH_EVERY, USAGE_KEEP_DAYS } from "./budget";

export const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  messages INTEGER NOT NULL DEFAULT 0,
  launches INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

export interface UsageCounts {
  messages: number;
  launches: number;
  requests: number;
}
export type UsageKind = keyof UsageCounts;

export interface UsageDay extends UsageCounts {
  day: string;
}

/** Pending (unflushed) counts for one day, as stored in a snapshot. */
export interface PendingSnap {
  d: string;
  m: number;
  l: number;
  r: number;
}

const zero = (): UsageCounts => ({ messages: 0, launches: 0, requests: 0 });

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** ms until the next 00:00 UTC. */
export function msUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

type Row = { day: string; messages: number; launches: number; requests: number; gen: number };

export class UsageMeter {
  private loaded = false;
  private day = "";
  /** Persisted totals for `day`. */
  private stored: UsageCounts = zero();
  /** Counted but not yet written, all for `day`. */
  private pending: UsageCounts = zero();
  private events = 0;
  /** Generation of the newest snapshot handed out; > flushedGen means it holds unflushed counts. */
  gen = 0;
  private flushedGen = 0;
  /** SQL statements run (tests assert the hot path stays at zero reads). */
  lastRowsRead = 0;
  lastRowsWritten = 0;

  constructor(private readonly sql: SqlStorage) {}

  /**
   * Called once per wake, before anything is counted. Reads ONE row (the newest day) and merges
   * the newest snapshot found in the open sockets' attachments.
   */
  load(now: number, snap: { g: number; u?: PendingSnap | undefined } | null): void {
    if (this.loaded) return;
    this.loaded = true;
    const cur = this.sql.exec<Row>("SELECT day, messages, launches, requests, gen FROM usage ORDER BY day DESC LIMIT 1");
    const row = cur.toArray()[0];
    this.lastRowsRead = cur.rowsRead;
    this.flushedGen = row?.gen ?? 0;
    this.gen = Math.max(this.flushedGen, snap?.g ?? 0);
    const today = utcDay(now);
    this.day = today;
    this.stored = row && row.day === today ? { messages: row.messages, launches: row.launches, requests: row.requests } : zero();
    const u = snap?.u;
    if (snap && u && snap.g > this.flushedGen) {
      const counts = { messages: num(u.m), launches: num(u.l), requests: num(u.r) };
      if (u.d === today) {
        this.pending = counts;
        this.events = counts.messages + counts.launches + counts.requests;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(u.d)) {
        // Unflushed counts of an earlier day (hibernated across midnight): write them where they belong.
        this.upsert(u.d, counts);
      }
    }
  }

  /** Count events. Returns true when a flush happened (callers don't need to care). */
  add(kind: UsageKind, now: number, n = 1): boolean {
    this.rollover(now);
    this.pending[kind] += n;
    this.events += n;
    if (this.events >= USAGE_FLUSH_EVERY) {
      this.flush();
      return true;
    }
    return false;
  }

  /** Today's totals (stored + pending). */
  today(now: number): UsageDay {
    this.rollover(now);
    return {
      day: this.day,
      messages: this.stored.messages + this.pending.messages,
      launches: this.stored.launches + this.pending.launches,
      requests: this.stored.requests + this.pending.requests,
    };
  }

  /** Write pending counts (one upsert). No-op if nothing is pending. */
  flush(): void {
    this.lastRowsRead = 0;
    this.lastRowsWritten = 0;
    if (!this.events) return;
    this.upsert(this.day, this.pending);
    this.stored = {
      messages: this.stored.messages + this.pending.messages,
      launches: this.stored.launches + this.pending.launches,
      requests: this.stored.requests + this.pending.requests,
    };
    this.pending = zero();
    this.events = 0;
  }

  get hasPending(): boolean {
    return this.events > 0;
  }

  /** Next snapshot (bumps the generation). */
  snapshot(): { g: number; u?: PendingSnap } {
    this.gen++;
    if (!this.events) return { g: this.gen };
    return { g: this.gen, u: { d: this.day, m: this.pending.messages, l: this.pending.launches, r: this.pending.requests } };
  }

  /** Last `days` days, newest first (today includes pending counts). For the tenant / Phase 4b admin. */
  history(now: number, days = USAGE_KEEP_DAYS): UsageDay[] {
    const today = this.today(now);
    const rows = this.sql
      .exec<Row>("SELECT day, messages, launches, requests FROM usage ORDER BY day DESC LIMIT ?", Math.max(1, Math.min(days, USAGE_KEEP_DAYS)))
      .toArray()
      .map((r) => ({ day: r.day, messages: r.messages, launches: r.launches, requests: r.requests }));
    const i = rows.findIndex((r) => r.day === today.day);
    if (i >= 0) rows[i] = today;
    else rows.unshift(today);
    return rows.slice(0, days);
  }

  private rollover(now: number): void {
    const d = utcDay(now);
    if (d === this.day) return;
    if (this.day && this.events) this.upsert(this.day, this.pending);
    this.day = d;
    this.stored = zero();
    this.pending = zero();
    this.events = 0;
    // Once per day: drop rows past the retention window (via the primary key).
    const cutoff = utcDay(now - USAGE_KEEP_DAYS * 86_400_000);
    this.sql.exec("DELETE FROM usage WHERE day < ?", cutoff);
  }

  private upsert(day: string, c: UsageCounts): void {
    const cur = this.sql.exec(
      `INSERT INTO usage (day, messages, launches, requests, gen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET messages = messages + excluded.messages, launches = launches + excluded.launches,
         requests = requests + excluded.requests, gen = excluded.gen`,
      day,
      c.messages,
      c.launches,
      c.requests,
      this.gen,
    );
    this.flushedGen = this.gen;
    this.lastRowsRead = cur.rowsRead;
    this.lastRowsWritten = cur.rowsWritten;
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
