// Global Registry (D13): the ONE sanctioned cross-tenant store (refines D9). A single SQLite-backed
// Durable Object, addressed by env.REGISTRY.idFromName("registry").
//
// It holds ONLY tenant metadata and counters:
//   tenants  id, email, name, created, status, how they got in, plan, last active day
//   daily    per tenant per UTC day: aggregate counters (requests, rows, messages, pushes, launches,
//            machines, sessions) as reported by that tenant's Hub
//   days     per UTC day: deployment totals (sum of `daily` + the Registry's own cost), sign-ups, DAU
//   invites  owner-created invite links (id, expiry, max uses, uses, revoked)
//   audit    every owner action
// Never message content, session names, machine names or locations.
//
// Why one Durable Object and not D1: everything else already runs on SQLite-backed Durable Objects
// (no new product, binding or `wrangler d1 create` step), a single object serializes the user-cap
// count and invite uses without races, and its traffic is small and bounded (one call per sign-in,
// one per tenant per USAGE_REPORT_MINUTES at most, owner page loads). D1's free-plan limits were not
// checked (developers.cloudflare.com unreachable): UNVERIFIED either way, see SETUP's desk checklist.
// Its own requests and rows are metered like a Hub's and added to the day's totals.
//
// Only the Worker (sign-in, owner-only /api/admin/*) and Hubs (usage reports) call it, over RPC; it
// has no fetch handler, so nothing outside can reach it.
import { DurableObject } from "cloudflare:workers";
import { DEFAULT_PLAN, PLANS, USAGE_KEEP_DAYS, isOwnerEmail } from "./budget";
import type { Env } from "./env";
import {
  type AccountStatus,
  type Adm,
  type GuardLevel,
  type GuardState,
  METRIC_LABEL,
  type SignupConfig,
  type Totals,
  type Via,
  FREE_DAILY,
  admFor,
  decideSignup,
  guardLevel,
  guardState,
  newAlertThresholds,
  refusalText,
  signupConfig,
} from "./signup";
import { utcDay } from "./usage";

export const REGISTRY_NAME = "registry";

/** Counters a Hub reports for one UTC day (its own totals so far; the Registry stores the latest). */
export type ReportCounts = {
  do_requests: number;
  messages: number;
  launches: number;
  pushes: number;
  rows_read: number;
  rows_written: number;
  machines: number;
  sessions: number;
};
export const REPORT_KEYS: (keyof ReportCounts)[] = ["do_requests", "messages", "launches", "pushes", "rows_read", "rows_written", "machines", "sessions"];

export interface UsageReport {
  tid: string;
  email: string | null;
  /** The plan stored in the Hub (meta.plan), not the effective one. */
  plan: string;
  day: string;
  counts: ReportCounts;
  /** Final counts of an earlier day this Hub had not fully reported (e.g. it was idle over midnight). */
  prev?: { day: string; counts: ReportCounts } | undefined;
}

/** The Registry's answer to a report: the account's state, so the Hub can repair any drift. */
export interface ReportAnswer {
  status: AccountStatus;
  adm: Adm;
  plan: string;
  guard: GuardState;
}

/**
 * Cost of one report in the Registry, charged to the reporting tenant (rows) by its Hub. Measured in
 * the registry test ("report cost"): <= 4 rows read and <= 3 rows written per reported day, plus one
 * row written for the tenant's first report of a day.
 */
export const REPORT_ROWS_READ_EST = 5;
export const REPORT_ROWS_WRITTEN_EST = 4;

export type SignInResult =
  | { status: "active"; adm: Adm; via: Via; plan: string }
  | { status: "waitlisted"; since: number }
  | { status: "refused"; reason: string; text: string };

export type TenantRow = {
  tid: string;
  email: string;
  name: string | null;
  status: AccountStatus;
  via: Via;
  plan: string;
  created_at: number;
  updated_at: number;
  last_active_day: string | null;
};

export type InviteRow = {
  id: string;
  created_at: number;
  expires_at: number;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
  note: string;
};

export type AuditRow = {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

export type DayRow = { day: string; signups: number; waitlist_joins: number; dau: number } & ReportCounts & {
  reg_requests: number;
  reg_rows_read: number;
  reg_rows_written: number;
};

export type TopTenant = ReportCounts & {
  tid: string;
  email: string;
  status: AccountStatus;
  plan: string;
  via: Via;
  /** Highest share (%) of any free daily limit this tenant used today. */
  percent: number;
};

export interface AdminOverview {
  day: string;
  totals: Totals;
  limits: Totals;
  level: GuardLevel;
  guard: GuardState;
  owner_paused: boolean;
  alerts_today: number[];
  config: {
    mode: SignupConfig["mode"];
    user_cap: number;
    waitlist_max: number;
    pause_at: number | null;
    tighten_at: number | null;
    tighten_share: number;
    alert_at: number[];
    alert_signups: number | null;
    report_minutes: number | null;
  };
  counts: Record<AccountStatus, number>;
  days: DayRow[];
  top: TopTenant[];
}

export type AdminAction =
  | { t: "approve"; tid: string }
  | { t: "deny"; tid: string }
  | { t: "disable"; tid: string }
  | { t: "enable"; tid: string }
  | { t: "plan"; tid: string; plan: string }
  | { t: "pause"; paused: boolean };

export type AdminResult = { ok: true; warning?: string } | { ok: false; status: number; error: string };

/** Owner alert pushed to the owner's phones (Hub.ownerAlert). */
export interface OwnerAlert {
  /** Collapses repeated alerts of the same kind on the phone. */
  tag: string;
  title: string;
  body: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tenants (
  tid TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  via TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_active_day TEXT,
  invite_id TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,
  tid TEXT NOT NULL,
  do_requests INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  launches INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  machines INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tid)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS days (
  day TEXT PRIMARY KEY,
  signups INTEGER NOT NULL DEFAULT 0,
  waitlist_joins INTEGER NOT NULL DEFAULT 0,
  dau INTEGER NOT NULL DEFAULT 0,
  do_requests INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  launches INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  machines INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  reg_requests INTEGER NOT NULL DEFAULT 0,
  reg_rows_read INTEGER NOT NULL DEFAULT 0,
  reg_rows_written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`;

/** Audit rows kept (older ones trimmed in batches). */
export const AUDIT_KEEP = 1000;
/** Unrevoked, unexpired invites at once. */
export const MAX_OPEN_INVITES = 100;
export const INVITE_MAX_DAYS = 30;
/** The Registry's own metered events are written to the day's totals at least this often. */
const OWN_FLUSH_EVERY = 50;

type Counts = Record<AccountStatus, number>;
type AlertState = { day: string; sent: number[]; signups?: boolean; waitlist?: boolean };

const zeroCounts = (): ReportCounts => ({ do_requests: 0, messages: 0, launches: 0, pushes: 0, rows_read: 0, rows_written: 0, machines: 0, sessions: 0 });

function clampCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e12) : 0;
}

export function cleanCounts(c: Partial<ReportCounts> | undefined): ReportCounts {
  const out = zeroCounts();
  for (const k of REPORT_KEYS) out[k] = clampCount(c?.[k]);
  return out;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class Registry extends DurableObject<Env> {
  private sql: SqlStorage;
  private readonly cursors: { rowsRead: number; rowsWritten: number }[] = [];
  /** The Registry's own cost not yet added to the day's totals. */
  private own = { day: "", requests: 0, rows_read: 0, rows_written: 0 };
  private counts: Counts | null = null;
  /** Owner's manual "pause sign-ups" switch (meta). */
  private ownerPaused: boolean | null = null;
  private alerts: AlertState | null = null;
  private prunedDay = "";
  /** Tests: replace the env-derived configuration. */
  cfgOverride: Partial<SignupConfig> | null = null;
  /** Tests: env overrides for gating (ALLOWED_EMAILS / OWNER_EMAILS). */
  envOverride: Record<string, string> | null = null;
  /** Tests: alerts sent (also when pushing them failed). */
  readonly sentAlerts: OwnerAlert[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const raw = ctx.storage.sql;
    this.sql = {
      exec: (q: string, ...args: unknown[]) => {
        const c = raw.exec(q, ...(args as SqlStorageValue[]));
        this.cursors.push(c);
        return c;
      },
    } as unknown as SqlStorage;
    this.sql.exec(SCHEMA);
  }

  private envVars(): Record<string, unknown> {
    const e = this.env as unknown as Record<string, unknown>;
    return this.envOverride ? { ...e, ...this.envOverride } : e;
  }

  cfg(): SignupConfig {
    return { ...signupConfig(this.envVars()), ...(this.cfgOverride ?? {}) };
  }

  // -------------------------------------------------------------------------
  // Own metering: every RPC counts one request; rows of every statement are summed.

  private settle(now: number): void {
    const day = utcDay(now);
    if (this.own.day !== day) this.own = { day, requests: 0, rows_read: 0, rows_written: 0 };
    for (const c of this.cursors.splice(0)) {
      this.own.rows_read += c.rowsRead;
      this.own.rows_written += c.rowsWritten;
    }
  }

  private begin(now: number): void {
    this.settle(now);
    this.own.requests++;
  }

  /** Add the Registry's own pending cost to today's totals row (one upsert). */
  private flushOwn(now: number, force = false): void {
    this.settle(now);
    if (!force && this.own.requests < OWN_FLUSH_EVERY) return;
    const o = this.own;
    if (!o.requests && !o.rows_read && !o.rows_written) return;
    this.own = { day: o.day, requests: 0, rows_read: 0, rows_written: 0 };
    // The upsert's own row (1 read, 1 written) is included in what it writes.
    this.sql.exec(
      `INSERT INTO days (day, reg_requests, reg_rows_read, reg_rows_written) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET reg_requests = reg_requests + excluded.reg_requests,
         reg_rows_read = reg_rows_read + excluded.reg_rows_read, reg_rows_written = reg_rows_written + excluded.reg_rows_written`,
      o.day,
      o.requests,
      o.rows_read + 1,
      o.rows_written + 1,
    );
    this.cursors.length = 0;
  }

  private end(now: number): void {
    this.flushOwn(now);
  }

  // -------------------------------------------------------------------------
  // Small state

  private getMeta(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private loadCounts(): Counts {
    if (this.counts) return this.counts;
    const raw = this.getMeta("counts");
    try {
      const c = raw ? (JSON.parse(raw) as Counts) : null;
      if (c && typeof c.active === "number") {
        this.counts = { active: c.active, waitlisted: c.waitlisted ?? 0, denied: c.denied ?? 0, disabled: c.disabled ?? 0 };
        return this.counts;
      }
    } catch {
      /* recount */
    }
    return this.recount();
  }

  /** Full count (owner overview, or a missing/corrupt counter): one scan of the tenants table. */
  private recount(): Counts {
    const c: Counts = { active: 0, waitlisted: 0, denied: 0, disabled: 0 };
    for (const r of this.sql.exec<{ status: AccountStatus; n: number }>("SELECT status, COUNT(*) AS n FROM tenants GROUP BY status").toArray()) {
      if (r.status in c) c[r.status] = r.n;
    }
    this.counts = c;
    this.setMeta("counts", JSON.stringify(c));
    return c;
  }

  private moveCount(from: AccountStatus | null, to: AccountStatus | null): void {
    if (from === to) return;
    const c = { ...this.loadCounts() };
    if (from) c[from] = Math.max(0, c[from] - 1);
    if (to) c[to]++;
    this.counts = c;
    this.setMeta("counts", JSON.stringify(c));
  }

  private paused(): boolean {
    if (this.ownerPaused === null) this.ownerPaused = this.getMeta("signups_paused") === "1";
    return this.ownerPaused;
  }

  private alertState(day: string): AlertState {
    if (!this.alerts) {
      try {
        const raw = this.getMeta("alerts");
        this.alerts = raw ? (JSON.parse(raw) as AlertState) : null;
      } catch {
        this.alerts = null;
      }
    }
    if (!this.alerts || this.alerts.day !== day) this.alerts = { day, sent: [] };
    return this.alerts;
  }

  private saveAlerts(): void {
    if (this.alerts) this.setMeta("alerts", JSON.stringify(this.alerts));
  }

  private getTenant(tid: string): TenantRow | undefined {
    return this.sql.exec<TenantRow>("SELECT tid, email, name, status, via, plan, created_at, updated_at, last_active_day FROM tenants WHERE tid = ?", tid).toArray()[0];
  }

  private dayRow(day: string): DayRow | undefined {
    return this.sql.exec<DayRow>("SELECT * FROM days WHERE day = ?", day).toArray()[0];
  }

  private totalsOf(d: DayRow | undefined): Totals {
    if (!d) return { do_requests: 0, rows_read: 0, rows_written: 0 };
    return {
      do_requests: d.do_requests + d.reg_requests,
      rows_read: d.rows_read + d.reg_rows_read,
      rows_written: d.rows_written + d.reg_rows_written,
    };
  }

  private guardNow(now: number, d?: DayRow): { level: GuardLevel; guard: GuardState } {
    const day = utcDay(now);
    const row = d ?? this.dayRow(day);
    const t = this.totalsOf(row);
    // Include the Registry's own not-yet-written cost.
    if (this.own.day === day) {
      t.do_requests += this.own.requests;
      t.rows_read += this.own.rows_read;
      t.rows_written += this.own.rows_written;
    }
    const level = guardLevel(t);
    return { level, guard: guardState(day, level, this.cfg(), this.paused()) };
  }

  private audit(now: number, actor: string, action: string, target: string, detail = ""): void {
    const cur = this.sql.exec<{ id: number }>(
      "INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?) RETURNING id",
      now,
      actor.slice(0, 254),
      action,
      target.slice(0, 254),
      detail.slice(0, 500),
    );
    const id = cur.one().id;
    if (id % 50 === 0) this.sql.exec("DELETE FROM audit WHERE id <= ?", id - AUDIT_KEEP);
  }

  // -------------------------------------------------------------------------
  // Sign-in (Worker, after Google verified the account)

  /**
   * Decide whether an account may use the service (see signup.ts for the precedence), record it, and
   * consume an invite use when one admitted it. One call per sign-in (and per waitlist re-check).
   */
  async signIn(input: { tid: string; email: string; name?: string | null; emailVerified: boolean; inviteId?: string | null; dev?: boolean }): Promise<SignInResult> {
    const now = Date.now();
    this.begin(now);
    try {
      return this.signInInner(input, now);
    } finally {
      this.end(now);
    }
  }

  private signInInner(
    input: { tid: string; email: string; name?: string | null; emailVerified: boolean; inviteId?: string | null; dev?: boolean },
    now: number,
  ): SignInResult {
    const env = this.envVars();
    const cfg = this.cfg();
    const row = this.getTenant(input.tid);
    let inviteOk = false;
    if (input.inviteId) {
      const inv = this.sql.exec<InviteRow>("SELECT * FROM invites WHERE id = ?", input.inviteId).toArray()[0];
      inviteOk = !!inv && inv.revoked_at === null && inv.expires_at > now && (inv.max_uses === null || inv.uses < inv.max_uses);
    }
    const counts = this.loadCounts();
    const day = utcDay(now);
    const { guard } = this.guardNow(now);
    const d = decideSignup(
      {
        email: input.email,
        emailVerified: input.emailVerified,
        existing: row ? { status: row.status, via: row.via } : null,
        invite: inviteOk,
        dev: !!input.dev,
        activeCount: counts.active,
        waitlistCount: counts.waitlisted,
        paused: guard.paused,
      },
      cfg,
      env,
    );
    const email = input.email.slice(0, 254);
    const name = input.name ? input.name.slice(0, 100) : null;
    if (d.kind === "refused") return { status: "refused", reason: d.reason, text: refusalText(d.reason) };
    const status: AccountStatus = d.kind === "active" ? "active" : "waitlisted";
    if (!row) {
      const via: Via = d.kind === "active" ? d.via : "open";
      this.sql.exec(
        `INSERT INTO tenants (tid, email, name, status, via, plan, created_at, updated_at, invite_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.tid,
        email,
        name,
        status,
        via,
        DEFAULT_PLAN,
        now,
        now,
        d.kind === "active" && d.consumeInvite ? input.inviteId ?? null : null,
      );
      this.moveCount(null, status);
      this.sql.exec(
        `INSERT INTO days (day, signups, waitlist_joins) VALUES (?, 1, ?)
         ON CONFLICT(day) DO UPDATE SET signups = signups + 1, waitlist_joins = waitlist_joins + excluded.waitlist_joins`,
        day,
        status === "waitlisted" ? 1 : 0,
      );
      this.signupAlerts(now, status === "waitlisted");
    } else {
      const via: Via = d.kind === "active" ? d.via : row.via;
      if (row.status !== status || row.via !== via || row.email !== email || (name && row.name !== name)) {
        this.sql.exec(
          "UPDATE tenants SET status = ?, via = ?, email = ?, name = COALESCE(?, name), updated_at = ?, invite_id = COALESCE(?, invite_id) WHERE tid = ?",
          status,
          via,
          email,
          name,
          now,
          d.kind === "active" && d.consumeInvite ? input.inviteId ?? null : null,
          input.tid,
        );
        this.moveCount(row.status, status);
      }
    }
    if (d.kind === "active" && d.consumeInvite && input.inviteId) {
      this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE id = ?", input.inviteId);
      this.audit(now, email, "invite_used", input.inviteId, input.tid);
    }
    if (d.kind === "waitlisted") return { status: "waitlisted", since: row?.created_at ?? now };
    const plan = row?.plan ?? DEFAULT_PLAN;
    return { status: "active", adm: admFor(d.via), via: d.via, plan };
  }

  /** Waitlist re-check (Worker, rate limited): the account's current status, without changing it. */
  async status(tid: string): Promise<{ status: AccountStatus; adm: Adm; plan: string } | null> {
    const now = Date.now();
    this.begin(now);
    try {
      const r = this.getTenant(tid);
      return r ? { status: r.status, adm: admFor(r.via), plan: r.plan } : null;
    } finally {
      this.end(now);
    }
  }

  private signupAlerts(now: number, waitlisted: boolean): void {
    const cfg = this.cfg();
    const day = utcDay(now);
    const st = this.alertState(day);
    const row = this.dayRow(day);
    const out: OwnerAlert[] = [];
    if (cfg.alertSignups !== null && !st.signups && (row?.signups ?? 0) >= cfg.alertSignups) {
      st.signups = true;
      out.push({ tag: "signups", title: "Sign-ups are spiking", body: `${row?.signups ?? 0} new accounts today (alert at ${cfg.alertSignups}).` });
    }
    if (waitlisted && cfg.alertWaitlist && !st.waitlist) {
      st.waitlist = true;
      out.push({ tag: "waitlist", title: "Someone joined the waitlist", body: "Open Admin to approve or deny (one alert per day)." });
    }
    if (out.length) {
      this.saveAlerts();
      this.sendAlerts(out);
    }
  }

  // -------------------------------------------------------------------------
  // Usage reports (Hubs)

  /**
   * A Hub reports its tenant's totals for today (and possibly the final ones of an earlier day).
   * Idempotent: the latest report for (day, tenant) replaces the previous one, and the day's totals
   * move by the difference. Unknown tenants (accounts from before Phase 4b) are registered as active.
   */
  async report(r: UsageReport): Promise<ReportAnswer> {
    const now = Date.now();
    this.begin(now);
    try {
      return this.reportInner(r, now);
    } finally {
      this.end(now);
    }
  }

  private reportInner(r: UsageReport, now: number): ReportAnswer {
    const today = utcDay(now);
    let row = this.getTenant(r.tid);
    if (!row) {
      const plan = PLANS[r.plan] ? r.plan : DEFAULT_PLAN;
      const email = (r.email ?? "").slice(0, 254);
      this.sql.exec(
        "INSERT INTO tenants (tid, email, status, via, plan, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
        r.tid,
        email,
        r.tid.startsWith("dev-") ? "dev" : "legacy",
        plan,
        now,
        now,
      );
      this.moveCount(null, "active");
      row = { tid: r.tid, email, name: null, status: "active", via: r.tid.startsWith("dev-") ? "dev" : "legacy", plan, created_at: now, updated_at: now, last_active_day: null };
    }
    let todayRow: DayRow | undefined;
    for (const part of [r.prev, { day: r.day, counts: r.counts }]) {
      if (!part || !DAY_RE.test(part.day) || part.day > today) continue;
      const d = this.applyDay(r.tid, part.day, cleanCounts(part.counts));
      if (part.day === today) todayRow = d;
    }
    if (row.last_active_day !== r.day && DAY_RE.test(r.day) && r.day <= today) {
      this.sql.exec("UPDATE tenants SET last_active_day = ? WHERE tid = ?", r.day, r.tid);
    }
    if (this.prunedDay !== today) {
      this.prunedDay = today;
      const cutoff = utcDay(now - USAGE_KEEP_DAYS * 86_400_000);
      this.sql.exec("DELETE FROM daily WHERE day < ?", cutoff);
      this.sql.exec("DELETE FROM days WHERE day < ?", cutoff);
    }
    const { level, guard } = this.guardNow(now, todayRow);
    this.usageAlerts(now, level);
    return { status: row.status, adm: admFor(row.via), plan: row.plan, guard };
  }

  /** Replace (day, tid)'s counters and move the day's totals by the difference. Returns the day's row. */
  private applyDay(tid: string, day: string, c: ReportCounts): DayRow {
    const old = this.sql.exec<ReportCounts>(`SELECT ${REPORT_KEYS.join(", ")} FROM daily WHERE day = ? AND tid = ?`, day, tid).toArray()[0];
    this.sql.exec(
      `INSERT INTO daily (day, tid, ${REPORT_KEYS.join(", ")}) VALUES (?, ?, ${REPORT_KEYS.map(() => "?").join(", ")})
       ON CONFLICT(day, tid) DO UPDATE SET ${REPORT_KEYS.map((k) => `${k} = excluded.${k}`).join(", ")}`,
      day,
      tid,
      ...REPORT_KEYS.map((k) => c[k]),
    );
    const delta = REPORT_KEYS.map((k) => c[k] - (old ? clampCount(old[k]) : 0));
    return this.sql
      .exec<DayRow>(
        `INSERT INTO days (day, dau, ${REPORT_KEYS.join(", ")}) VALUES (?, ?, ${REPORT_KEYS.map(() => "?").join(", ")})
         ON CONFLICT(day) DO UPDATE SET dau = dau + excluded.dau, ${REPORT_KEYS.map((k) => `${k} = MAX(0, ${k} + excluded.${k})`).join(", ")}
         RETURNING *`,
        day,
        old ? 0 : 1,
        ...delta,
      )
      .one();
  }

  private usageAlerts(now: number, level: GuardLevel): void {
    const cfg = this.cfg();
    const st = this.alertState(utcDay(now));
    const fresh = newAlertThresholds(level.percent, cfg, st.sent);
    if (!fresh.length) return;
    st.sent = [...st.sent, ...fresh].sort((a, b) => a - b);
    this.saveAlerts();
    const top = Math.max(...fresh);
    const g = guardState(st.day, level, cfg, this.paused());
    const actions = [g.paused ? "new sign-ups are paused (waitlist)" : "", g.free_share !== null ? `free accounts limited to ${g.free_share}% each` : ""].filter(Boolean);
    this.sendAlerts([
      {
        tag: `usage-${top}`,
        title: `Usage passed ${top}% of the free plan`,
        body: `${METRIC_LABEL[level.metric]}: ${Math.round(level.percent)}% of the daily free limit (UTC day ${st.day}).${actions.length ? ` Guard: ${actions.join("; ")}.` : ""}`,
      },
    ]);
  }

  /** Push alerts to the owner(s)' phones via their own Hubs (Web Push, Phase 4). Never awaited by callers. */
  private sendAlerts(alerts: OwnerAlert[]): void {
    this.sentAlerts.push(...alerts);
    const env = this.envVars();
    const owners = this.sql
      .exec<{ tid: string; email: string }>("SELECT tid, email FROM tenants WHERE status = 'active'")
      .toArray()
      .filter((r) => isOwnerEmail(r.email, env));
    if (!owners.length) return;
    const p = Promise.all(
      owners.flatMap((o) =>
        alerts.map((a) =>
          this.env.HUB.get(this.env.HUB.idFromName(o.tid))
            .ownerAlert(a)
            .catch((e: unknown) => console.error("owner alert failed", e instanceof Error ? e.message : String(e))),
        ),
      ),
    );
    this.ctx.waitUntil(p);
  }

  // -------------------------------------------------------------------------
  // Owner (admin) API. The Worker checks the cookie + OWNER_EMAILS on every call before it gets here.

  async overview(): Promise<AdminOverview> {
    const now = Date.now();
    this.begin(now);
    try {
      const day = utcDay(now);
      const cfg = this.cfg();
      const counts = this.recount();
      const days = this.sql.exec<DayRow>("SELECT * FROM days ORDER BY day DESC LIMIT 30").toArray();
      const todayRow = days.find((d) => d.day === day);
      const { level, guard } = this.guardNow(now, todayRow);
      const top = this.sql
        .exec<TopTenant & { name: string | null }>(
          `SELECT d.tid AS tid, COALESCE(t.email, '') AS email, COALESCE(t.status, 'active') AS status, COALESCE(t.plan, 'free') AS plan,
             COALESCE(t.via, 'legacy') AS via, ${REPORT_KEYS.map((k) => `d.${k} AS ${k}`).join(", ")}
           FROM daily d LEFT JOIN tenants t ON t.tid = d.tid WHERE d.day = ?
           ORDER BY MAX(d.do_requests * 1.0 / ?, d.rows_read * 1.0 / ?, d.rows_written * 1.0 / ?) DESC LIMIT 20`,
          day,
          FREE_DAILY.do_requests,
          FREE_DAILY.rows_read,
          FREE_DAILY.rows_written,
        )
        .toArray()
        .map((t) => ({ ...t, percent: guardLevel({ do_requests: t.do_requests, rows_read: t.rows_read, rows_written: t.rows_written }).percent }));
      return {
        day,
        totals: this.totalsWithOwn(todayRow, day),
        limits: FREE_DAILY,
        level,
        guard,
        owner_paused: this.paused(),
        alerts_today: this.alertState(day).sent,
        config: {
          mode: cfg.mode,
          user_cap: cfg.userCap,
          waitlist_max: cfg.waitlistMax,
          pause_at: cfg.pauseAt,
          tighten_at: cfg.tightenAt,
          tighten_share: cfg.tightenShare,
          alert_at: cfg.alertAt,
          alert_signups: cfg.alertSignups,
          report_minutes: cfg.reportEveryMs === null ? null : cfg.reportEveryMs / 60_000,
        },
        counts,
        days,
        top,
      };
    } finally {
      this.end(now);
    }
  }

  private totalsWithOwn(d: DayRow | undefined, day: string): Totals {
    const t = this.totalsOf(d);
    if (this.own.day === day) {
      t.do_requests += this.own.requests;
      t.rows_read += this.own.rows_read;
      t.rows_written += this.own.rows_written;
    }
    return t;
  }

  /** Accounts by status, newest first (owner page). */
  async listTenants(status: AccountStatus | "all", limit = 200): Promise<TenantRow[]> {
    const now = Date.now();
    this.begin(now);
    try {
      const n = Math.max(1, Math.min(limit, 500));
      const cols = "tid, email, name, status, via, plan, created_at, updated_at, last_active_day";
      return status === "all"
        ? this.sql.exec<TenantRow>(`SELECT ${cols} FROM tenants ORDER BY created_at DESC LIMIT ?`, n).toArray()
        : this.sql.exec<TenantRow>(`SELECT ${cols} FROM tenants WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, n).toArray();
    } finally {
      this.end(now);
    }
  }

  async act(actor: string, a: AdminAction): Promise<AdminResult> {
    const now = Date.now();
    this.begin(now);
    try {
      return await this.actInner(actor, a, now);
    } finally {
      this.end(now);
    }
  }

  private async actInner(actor: string, a: AdminAction, now: number): Promise<AdminResult> {
    if (a.t === "pause") {
      this.setMeta("signups_paused", a.paused ? "1" : "0");
      this.ownerPaused = a.paused;
      this.audit(now, actor, a.paused ? "pause_signups" : "resume_signups", "-");
      return { ok: true };
    }
    const row = this.getTenant(a.tid);
    if (!row) return { ok: false, status: 404, error: "no such account" };
    const env = this.envVars();
    let next: AccountStatus = row.status;
    let plan = row.plan;
    switch (a.t) {
      case "approve":
        if (row.status !== "waitlisted" && row.status !== "denied") return { ok: false, status: 409, error: `this account is ${row.status}` };
        next = "active";
        break;
      case "deny":
        if (row.status !== "waitlisted") return { ok: false, status: 409, error: `this account is ${row.status}` };
        next = "denied";
        break;
      case "disable":
        if (isOwnerEmail(row.email, env)) return { ok: false, status: 409, error: "an owner account (OWNER_EMAILS) can't be disabled" };
        if (row.status !== "active") return { ok: false, status: 409, error: `this account is ${row.status}` };
        next = "disabled";
        break;
      case "enable":
        if (row.status !== "disabled") return { ok: false, status: 409, error: `this account is ${row.status}` };
        next = "active";
        break;
      case "plan":
        if (!PLANS[a.plan]) return { ok: false, status: 400, error: "unknown plan" };
        if (row.status === "waitlisted" || row.status === "denied") return { ok: false, status: 409, error: `this account is ${row.status}` };
        plan = a.plan;
        break;
    }
    const via: Via = a.t === "approve" ? "approved" : row.via;
    this.sql.exec("UPDATE tenants SET status = ?, plan = ?, via = ?, updated_at = ? WHERE tid = ?", next, plan, via, now, row.tid);
    this.moveCount(row.status, next);
    this.audit(now, actor, a.t, row.email || row.tid, a.t === "plan" ? `${row.plan} -> ${plan}` : `${row.status} -> ${next}`);
    // Tell the account's Hub (it enforces "disabled" and the plan); waitlisted/denied accounts have none.
    if (a.t === "disable" || a.t === "enable" || a.t === "plan") {
      try {
        await this.env.HUB.get(this.env.HUB.idFromName(row.tid)).setAccount({ status: next, adm: admFor(via), plan });
      } catch (e) {
        console.error("could not update the account's hub", e instanceof Error ? e.message : String(e));
        return { ok: true, warning: "saved, but the account's Hub could not be told right now; it picks the change up with its next usage report" };
      }
    }
    return { ok: true };
  }

  async createInvite(actor: string, opts: { id: string; days: number; max_uses: number | null; note: string }): Promise<{ ok: true; invite: InviteRow } | { ok: false; status: number; error: string }> {
    const now = Date.now();
    this.begin(now);
    try {
      const open = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM invites WHERE revoked_at IS NULL AND expires_at > ?", now).one().n;
      if (open >= MAX_OPEN_INVITES) return { ok: false, status: 409, error: `at most ${MAX_OPEN_INVITES} open invites; revoke some first` };
      const days = Math.max(1, Math.min(INVITE_MAX_DAYS, Math.floor(opts.days)));
      const inv: InviteRow = {
        id: opts.id,
        created_at: now,
        expires_at: now + days * 86_400_000,
        max_uses: opts.max_uses === null ? null : Math.max(1, Math.min(1000, Math.floor(opts.max_uses))),
        uses: 0,
        revoked_at: null,
        note: opts.note.slice(0, 100),
      };
      this.sql.exec(
        "INSERT INTO invites (id, created_at, expires_at, max_uses, uses, note) VALUES (?, ?, ?, ?, 0, ?)",
        inv.id,
        inv.created_at,
        inv.expires_at,
        inv.max_uses,
        inv.note,
      );
      this.audit(now, actor, "invite_create", inv.id, `${days} days, ${inv.max_uses ?? "unlimited"} uses${inv.note ? `, ${inv.note}` : ""}`);
      return { ok: true, invite: inv };
    } finally {
      this.end(now);
    }
  }

  async listInvites(): Promise<InviteRow[]> {
    const now = Date.now();
    this.begin(now);
    try {
      return this.sql.exec<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC LIMIT 200").toArray();
    } finally {
      this.end(now);
    }
  }

  async revokeInvite(actor: string, id: string): Promise<boolean> {
    const now = Date.now();
    this.begin(now);
    try {
      const n = this.sql.exec("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now, id).rowsWritten;
      if (n) this.audit(now, actor, "invite_revoke", id);
      return n > 0;
    } finally {
      this.end(now);
    }
  }

  async auditLog(limit = 100): Promise<AuditRow[]> {
    const now = Date.now();
    this.begin(now);
    try {
      return this.sql.exec<AuditRow>("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(limit, 500))).toArray();
    } finally {
      this.end(now);
    }
  }

  /** Tests: write the Registry's own pending cost now. */
  flushOwnForTest(): void {
    this.flushOwn(Date.now(), true);
  }
}
