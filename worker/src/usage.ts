// Per-tenant usage counters (Phase 3 cost accounting, D10/D13). Lives inside one tenant's Hub and
// only ever reads that Hub's own table (D9). Hot path cost: zero rows read, and one row written per
// USAGE_FLUSH_EVERY counted events (amortized), plus one at socket close / day rollover.
//
// The counters are also what the daily budget (budget.ts, DailyBudget) is checked against: requests
// (connects + API calls), frames (inbound WebSocket messages), rows read and rows written by the Hub.
//
// Not-yet-flushed counts survive hibernation inside a WebSocket attachment (see Hub.saveSnap): each
// snapshot carries a generation number `g`, and the usage row stores the generation of its last
// flush, so a stale snapshot (taken before a flush) is never counted twice.
import { USAGE_FLUSH_EVERY, USAGE_KEEP_DAYS } from "./budget";

/** Counter name -> [usage column, short key in snapshots]. */
const COUNTERS = {
  messages: "m",
  launches: "l",
  requests: "r",
  frames: "f",
  rows_read: "rr",
  rows_written: "rw",
} as const;

export type UsageKind = keyof typeof COUNTERS;
export type UsageCounts = Record<UsageKind, number>;
const KINDS = Object.keys(COUNTERS) as UsageKind[];

/** Kinds that count as "events" towards the flush threshold (rows are a by-product of events). */
const EVENT_KINDS = new Set<UsageKind>(["messages", "launches", "requests", "frames"]);

export const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  messages INTEGER NOT NULL DEFAULT 0,
  launches INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  frames INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  gen INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`;

/** Columns added after the table first shipped (idempotent migration, see Hub.migrate). */
export const USAGE_ADDED_COLUMNS = ["frames", "rows_read", "rows_written"] as const;

export interface UsageDay extends UsageCounts {
  day: string;
}

/** Pending (unflushed) counts for one day, as stored in a snapshot: { d: day, m: n, l: n, ... }. */
export type PendingSnap = { d: string } & Partial<Record<(typeof COUNTERS)[UsageKind], number>>;

const zero = (): UsageCounts => ({ messages: 0, launches: 0, requests: 0, frames: 0, rows_read: 0, rows_written: 0 });

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** ms until the next 00:00 UTC. */
export function msUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}

type Row = UsageCounts & { day: string; gen: number };
const COLS = KINDS.join(", ");

export class UsageMeter {
  private loaded = false;
  private day = "";
  /** Persisted totals for `day`. */
  private stored: UsageCounts = zero();
  /** Counted but not yet written, all for `day`. */
  private pending: UsageCounts = zero();
  /** Counted events since the last flush (flush threshold). */
  private events = 0;
  private dirty = false;
  /** Generation of the newest snapshot handed out; > flushedGen means it holds unflushed counts. */
  gen = 0;
  private flushedGen = 0;
  /** SQL cost of the last load/flush (tests). */
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
    const cur = this.sql.exec<Row>(`SELECT day, ${COLS}, gen FROM usage ORDER BY day DESC LIMIT 1`);
    const row = cur.toArray()[0];
    this.lastRowsRead = cur.rowsRead;
    this.flushedGen = row?.gen ?? 0;
    this.gen = Math.max(this.flushedGen, snap?.g ?? 0);
    const today = utcDay(now);
    this.day = today;
    this.stored = zero();
    if (row && row.day === today) for (const k of KINDS) this.stored[k] = num(row[k]);
    const u = snap?.u;
    if (snap && u && snap.g > this.flushedGen) {
      const counts = zero();
      for (const k of KINDS) counts[k] = num(u[COUNTERS[k]]);
      if (u.d === today) {
        this.pending = counts;
        this.dirty = KINDS.some((k) => counts[k] > 0);
        this.events = [...EVENT_KINDS].reduce((n, k) => n + counts[k], 0);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(u.d)) {
        // Unflushed counts of an earlier day (hibernated across midnight): write them where they belong.
        this.upsert(u.d, counts);
      }
    }
  }

  /** Count `n` of `kind`. Flushes (one upsert) once USAGE_FLUSH_EVERY events are pending. */
  add(kind: UsageKind, now: number, n = 1): void {
    if (!n) return;
    this.rollover(now);
    this.pending[kind] += n;
    this.dirty = true;
    if (EVENT_KINDS.has(kind)) this.events += n;
    if (this.events >= USAGE_FLUSH_EVERY) this.flush();
  }

  /** Today's totals (stored + pending). */
  today(now: number): UsageDay {
    this.rollover(now);
    const out = { day: this.day } as UsageDay;
    for (const k of KINDS) out[k] = this.stored[k] + this.pending[k];
    return out;
  }

  /** Today's persisted totals only (what survives an eviction). */
  storedToday(now: number): UsageDay {
    this.rollover(now);
    return { day: this.day, ...this.stored };
  }

  /** Write pending counts (one upsert). No-op if nothing is pending. */
  flush(): void {
    this.lastRowsRead = 0;
    this.lastRowsWritten = 0;
    if (!this.dirty) return;
    const p = this.pending;
    this.pending = zero();
    this.events = 0;
    this.dirty = false;
    this.upsert(this.day, p);
    for (const k of KINDS) this.stored[k] += p[k];
  }

  get hasPending(): boolean {
    return this.dirty;
  }

  /** Next snapshot (bumps the generation). */
  snapshot(): { g: number; u?: PendingSnap } {
    this.gen++;
    if (!this.dirty) return { g: this.gen };
    const u: PendingSnap = { d: this.day };
    for (const k of KINDS) if (this.pending[k]) u[COUNTERS[k]] = this.pending[k];
    return { g: this.gen, u };
  }

  /** Last `days` days, newest first (today includes pending counts). For the tenant / Phase 4b admin. */
  history(now: number, days = USAGE_KEEP_DAYS): UsageDay[] {
    const today = this.today(now);
    const rows = this.sql
      .exec<Row>(`SELECT day, ${COLS} FROM usage ORDER BY day DESC LIMIT ?`, Math.max(1, Math.min(days, USAGE_KEEP_DAYS)))
      .toArray()
      .map((r) => {
        const d = { day: r.day } as UsageDay;
        for (const k of KINDS) d[k] = num(r[k]);
        return d;
      });
    const i = rows.findIndex((r) => r.day === today.day);
    if (i >= 0) rows[i] = today;
    else rows.unshift(today);
    return rows.slice(0, days);
  }

  private rollover(now: number): void {
    const d = utcDay(now);
    if (d === this.day) return;
    const old = this.day;
    const p = this.pending;
    const wasDirty = this.dirty;
    this.day = d;
    this.stored = zero();
    this.pending = zero();
    this.events = 0;
    this.dirty = false;
    if (old && wasDirty) this.upsert(old, p);
    // Once per day: drop rows past the retention window (via the primary key).
    const cutoff = utcDay(now - USAGE_KEEP_DAYS * 86_400_000);
    this.sql.exec("DELETE FROM usage WHERE day < ?", cutoff);
  }

  private upsert(day: string, c: UsageCounts): void {
    const cur = this.sql.exec(
      `INSERT INTO usage (day, ${COLS}, gen) VALUES (?, ${KINDS.map(() => "?").join(", ")}, ?)
       ON CONFLICT(day) DO UPDATE SET ${KINDS.map((k) => `${k} = ${k} + excluded.${k}`).join(", ")}, gen = excluded.gen`,
      day,
      ...KINDS.map((k) => c[k]),
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
