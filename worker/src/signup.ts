// Sign-up gating (D12) and the global guard (D13): configuration and the pure decision logic.
// The Registry Durable Object (registry.ts) applies it; this file has no I/O so every rule is
// unit-testable with explicit inputs.
//
// Precedence at sign-in (first match wins):
//   1. no verified email                      -> refused
//   2. OWNER_EMAILS                           -> active (never waitlisted; can't be disabled)
//   3. account disabled by the owner          -> refused ("disabled")
//   4. ALLOWED_EMAILS                         -> active (skips cap and waitlist)
//   5. already active (invite, cap, approval) -> active  [legacy rows: see below]
//   6. valid invite link                      -> active (skips cap, waitlist and a sign-up pause)
//   7. already waitlisted                     -> waitlisted;  denied -> refused ("not admitted")
//   8. OPEN_SIGNUP:
//        "false" (default, closed)            -> refused ("not on the sign-up list")
//        "waitlist"                           -> waitlisted (owner approves)
//        "true"                               -> active while active accounts < USER_CAP and sign-ups
//                                                are not paused (owner switch or global guard), else
//                                                waitlisted
//      a full waitlist (WAITLIST_MAX)         -> refused ("waitlist is full")
//
// How long an admission lasts (the cookie's `adm` claim, checked on every request without any
// Durable Object):
//   "env": admitted because of OWNER_EMAILS / ALLOWED_EMAILS (or a pre-Phase-4b account): re-checked
//          against the env vars on every request, exactly as before (removing the email signs out).
//   "reg": admitted by the Registry (invite, cap, owner approval): valid until the owner disables it.
import { FREE_PLAN, isOwnerEmail } from "./budget";

export type AccountStatus = "active" | "waitlisted" | "denied" | "disabled";
/** How an account got in. env-kinds are re-checked against env vars; the others are Registry-governed. */
export type Via = "owner" | "allowlist" | "legacy" | "invite" | "open" | "approved" | "dev";
export type Adm = "env" | "reg";

export function admFor(via: Via): Adm {
  return via === "owner" || via === "allowlist" || via === "legacy" ? "env" : "reg";
}

export type SignupMode = "closed" | "waitlist" | "open";

export interface SignupConfig {
  mode: SignupMode;
  /** Active accounts auto-approved in "open" mode before new sign-ups go to the waitlist. */
  userCap: number;
  waitlistMax: number;
  /** Global guard: pause auto-approval when today's usage reaches this % of a free limit (null = off). */
  pauseAt: number | null;
  /** Global guard: tighten the free plan's daily share when usage reaches this % (null = off). */
  tightenAt: number | null;
  /** The free plan's daily share (%) while tightened. */
  tightenShare: number;
  /** Owner alerts when usage passes these % of any free limit (once per threshold per UTC day). */
  alertAt: number[];
  /** Owner alert when sign-ups today reach this many (null = off). */
  alertSignups: number | null;
  /** Owner alert when someone joins the waitlist (at most once per UTC day). */
  alertWaitlist: boolean;
  /** Hubs report their usage to the Registry at most this often (ms); null = never (tests). */
  reportEveryMs: number | null;
}

export const SIGNUP_DEFAULTS: SignupConfig = {
  mode: "closed",
  userCap: 10,
  waitlistMax: 500,
  pauseAt: 80,
  tightenAt: 90,
  tightenShare: 5,
  alertAt: [50, 80],
  alertSignups: 20,
  alertWaitlist: true,
  reportEveryMs: 15 * 60_000,
};

type EnvLike = Record<string, unknown>;

function str(env: EnvLike, k: string): string | null {
  const v = env[k];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function int(env: EnvLike, k: string, dflt: number, min: number, max: number): number {
  const v = str(env, k);
  if (v === null) return dflt;
  if (!/^\d{1,9}$/.test(v)) return dflt;
  const n = Number(v);
  return n >= min && n <= max ? n : dflt;
}

/** "off" / "0" -> null; a percentage 1-100 -> it; anything else -> the default. */
function pct(env: EnvLike, k: string, dflt: number | null): number | null {
  const v = str(env, k);
  if (v === null) return dflt;
  if (v === "off" || v === "0") return null;
  if (!/^\d{1,3}$/.test(v)) return dflt;
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : dflt;
}

export function signupConfig(env: EnvLike): SignupConfig {
  const open = (str(env, "OPEN_SIGNUP") ?? "false").toLowerCase();
  const mode: SignupMode = open === "true" ? "open" : open === "waitlist" ? "waitlist" : "closed";
  const alertRaw = str(env, "ALERT_USAGE_PERCENTS");
  let alertAt = SIGNUP_DEFAULTS.alertAt;
  if (alertRaw === "off") alertAt = [];
  else if (alertRaw) {
    const xs = alertRaw.split(",").map((s) => Number(s.trim()));
    if (xs.length && xs.length <= 5 && xs.every((n) => Number.isInteger(n) && n >= 1 && n <= 100)) alertAt = [...new Set(xs)].sort((a, b) => a - b);
  }
  const rep = str(env, "USAGE_REPORT_MINUTES");
  let reportEveryMs: number | null = SIGNUP_DEFAULTS.reportEveryMs;
  if (rep === "off") reportEveryMs = null;
  else if (rep !== null && /^\d{1,4}$/.test(rep)) reportEveryMs = Number(rep) * 60_000;
  const alertSignupsRaw = str(env, "ALERT_SIGNUPS_PER_DAY");
  return {
    mode,
    userCap: int(env, "USER_CAP", SIGNUP_DEFAULTS.userCap, 0, 1_000_000),
    waitlistMax: int(env, "WAITLIST_MAX", SIGNUP_DEFAULTS.waitlistMax, 0, 100_000),
    pauseAt: pct(env, "GUARD_PAUSE_SIGNUPS_PERCENT", SIGNUP_DEFAULTS.pauseAt),
    tightenAt: pct(env, "GUARD_TIGHTEN_PERCENT", SIGNUP_DEFAULTS.tightenAt),
    tightenShare: int(env, "GUARD_FREE_SHARE_PERCENT", SIGNUP_DEFAULTS.tightenShare, 1, 100),
    alertAt,
    alertSignups: alertSignupsRaw === "off" ? null : int(env, "ALERT_SIGNUPS_PER_DAY", SIGNUP_DEFAULTS.alertSignups ?? 20, 1, 1_000_000),
    alertWaitlist: str(env, "ALERT_WAITLIST") !== "off",
    reportEveryMs,
  };
}

export function isAllowlisted(email: string, env: EnvLike): boolean {
  const list = str(env, "ALLOWED_EMAILS") ?? "";
  const e = email.trim().toLowerCase();
  return e !== "" && list.split(",").some((x) => x.trim().toLowerCase() === e);
}

/**
 * Per-request check for "env"-admitted accounts (and cookies minted before Phase 4b, which carry no
 * `adm`): OPEN_SIGNUP=true, or the email is in ALLOWED_EMAILS or OWNER_EMAILS. Same rule as before.
 */
export function envAllowed(email: string | null | undefined, env: EnvLike): boolean {
  if (str(env, "OPEN_SIGNUP") === "true") return true;
  if (!email) return false;
  return isAllowlisted(email, env) || isOwnerEmail(email, env);
}

// ---------------------------------------------------------------------------
// The decision

export interface ExistingAccount {
  status: AccountStatus;
  via: Via;
}

export interface SignupInput {
  email: string;
  emailVerified: boolean;
  existing: ExistingAccount | null;
  /** A valid, unexpired, unrevoked invite with uses left was presented. */
  invite: boolean;
  /** Dev sign-in without gating (local only): admitted like an allowlisted account. */
  dev: boolean;
  activeCount: number;
  waitlistCount: number;
  /** Sign-ups paused (owner switch or global guard). */
  paused: boolean;
}

export type SignupDecision =
  | { kind: "active"; via: Via; consumeInvite: boolean; isNew: boolean }
  | { kind: "waitlisted"; isNew: boolean }
  | { kind: "refused"; reason: "unverified" | "disabled" | "denied" | "closed" | "waitlist_full" };

export function decideSignup(i: SignupInput, cfg: SignupConfig, env: EnvLike): SignupDecision {
  if (!i.email || !i.emailVerified) return { kind: "refused", reason: "unverified" };
  const ex = i.existing;
  const isNew = ex === null;
  if (isOwnerEmail(i.email, env)) return { kind: "active", via: "owner", consumeInvite: false, isNew };
  if (ex?.status === "disabled") return { kind: "refused", reason: "disabled" };
  if (isAllowlisted(i.email, env)) return { kind: "active", via: "allowlist", consumeInvite: false, isNew };
  if (i.dev) return { kind: "active", via: ex?.status === "active" ? ex.via : "dev", consumeInvite: false, isNew };
  if (ex?.status === "active") {
    // Owner/allowlist admissions end when the email leaves the list: decide again below.
    // A pre-4b ("legacy") account keeps the old rule: fine unless sign-up is closed.
    if (ex.via !== "owner" && ex.via !== "allowlist" && !(ex.via === "legacy" && cfg.mode === "closed")) {
      return { kind: "active", via: ex.via, consumeInvite: false, isNew };
    }
  }
  if (i.invite) return { kind: "active", via: "invite", consumeInvite: true, isNew };
  if (ex?.status === "waitlisted") return { kind: "waitlisted", isNew: false };
  if (ex?.status === "denied") return { kind: "refused", reason: "denied" };
  if (cfg.mode === "closed") return { kind: "refused", reason: "closed" };
  if (cfg.mode === "open" && !i.paused && i.activeCount < cfg.userCap) return { kind: "active", via: "open", consumeInvite: false, isNew };
  if (i.waitlistCount >= cfg.waitlistMax) return { kind: "refused", reason: "waitlist_full" };
  return { kind: "waitlisted", isNew };
}

export function refusalText(reason: Extract<SignupDecision, { kind: "refused" }>["reason"]): string {
  switch (reason) {
    case "unverified":
      return "This Google account has no verified email address.";
    case "disabled":
      return "This account has been disabled by the operator of this server.";
    case "denied":
      return "Sign-up for this account was not approved.";
    case "closed":
      return "This Google account is not on the sign-up list. Ask the owner of this server for an invite link.";
    case "waitlist_full":
      return "Sign-up is full and the waitlist is full too. Please try again later.";
  }
}

// ---------------------------------------------------------------------------
// Global guard (D13): today's deployment-wide usage against the free plan's daily limits.

export interface Totals {
  /** Billed DO requests: connects + API calls + inbound WebSocket frames / 20, all tenants + the Registry. */
  do_requests: number;
  rows_read: number;
  rows_written: number;
}

export interface GuardLevel {
  /** Highest share (%) of any free daily limit used today. */
  percent: number;
  /** Which limit that is. */
  metric: keyof Totals;
  per: Record<keyof Totals, number>;
}

export const FREE_DAILY: Totals = {
  do_requests: FREE_PLAN.doRequestsPerDay,
  rows_read: FREE_PLAN.sqliteRowsReadPerDay,
  rows_written: FREE_PLAN.sqliteRowsWrittenPerDay,
};

export function guardLevel(t: Totals): GuardLevel {
  const per = {
    do_requests: (100 * t.do_requests) / FREE_DAILY.do_requests,
    rows_read: (100 * t.rows_read) / FREE_DAILY.rows_read,
    rows_written: (100 * t.rows_written) / FREE_DAILY.rows_written,
  };
  let metric: keyof Totals = "do_requests";
  for (const k of Object.keys(per) as (keyof Totals)[]) if (per[k] > per[metric]) metric = k;
  return { percent: per[metric], metric, per };
}

/** What Hubs are told (in the answer to their usage report): valid for `day` only. */
export interface GuardState {
  day: string;
  /** Auto-approval of new sign-ups is paused (by the guard or the owner). */
  paused: boolean;
  /** Free-plan daily share (%) while tightened; null = normal. */
  free_share: number | null;
}

export function guardState(day: string, level: GuardLevel, cfg: SignupConfig, ownerPaused: boolean): GuardState {
  return {
    day,
    paused: ownerPaused || (cfg.pauseAt !== null && level.percent >= cfg.pauseAt),
    free_share: cfg.tightenAt !== null && level.percent >= cfg.tightenAt ? cfg.tightenShare : null,
  };
}

/** Thresholds (from cfg.alertAt) reached by `percent` that were not alerted yet today. */
export function newAlertThresholds(percent: number, cfg: SignupConfig, already: readonly number[]): number[] {
  return cfg.alertAt.filter((t) => percent >= t && !already.includes(t));
}

export const METRIC_LABEL: Record<keyof Totals, string> = {
  do_requests: "Durable Object requests",
  rows_read: "database rows read",
  rows_written: "database rows written",
};
