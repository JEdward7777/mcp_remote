import type { Hub } from "./hub";
import type { Pairing } from "./pairing";
import type { Throttle } from "./throttle";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  PAIRING: DurableObjectNamespace<Pairing>;
  /** Sharded token buckets for unauthenticated endpoints (Phase 3). */
  THROTTLE: DurableObjectNamespace<Throttle>;
  /**
   * Optional Workers Rate Limiting binding for /api/pair/start (not configured by default: its
   * free-plan availability is UNVERIFIED, see budget.ts / SETUP.md). The Throttle DO is used either way.
   */
  PAIR_START_RATE_LIMITER?: RateLimit;
  ASSETS: Fetcher;
  /** HMAC secret for cookies and machine tokens (wrangler secret). >= 32 chars. */
  SESSION_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  /** wrangler secret */
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional override; defaults to <origin>/auth/callback. */
  GOOGLE_REDIRECT_URI?: string;
  ALLOWED_EMAILS?: string;
  OPEN_SIGNUP?: string;
  /** "1" enables /auth/dev. Only ever set in .dev.vars. */
  DEV_AUTH?: string;
  /**
   * Limit overrides (Phase 3), all optional strings like "10,20/min" (burst, refill per unit).
   * See budget.ts (LIMIT_ENV, PUBLIC_ENV) and harness/SETUP.md for the full list and defaults.
   */
  DAILY_MESSAGE_CAP?: string;
  /** % of each free daily limit one free-plan account may use (default 10). */
  TENANT_DAILY_SHARE_PERCENT?: string;
  /** % for owner-plan accounts (default 50). */
  OWNER_DAILY_SHARE_PERCENT?: string;
  /** wrangler secret: comma-separated emails whose accounts run on the owner plan. */
  OWNER_EMAILS?: string;
  /**
   * Web Push (Phase 4, D19). VAPID key pair from `npm run vapid` (wrangler secrets). Without both,
   * the app works but sends no notifications. VAPID_SUBJECT: mailto: or https: contact for push
   * services (default: the app's own URL).
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Web Push sends per UTC day for free-plan accounts (default 200). */
  DAILY_PUSH_CAP?: string;
  /**
   * LOCAL TESTING ONLY, honored only together with DEV_AUTH=1: extra push endpoint origins (exact,
   * comma-separated, e.g. http://127.0.0.1:8123) besides the real push services. Used by the e2e.
   */
  PUSH_EXTRA_ORIGINS?: string;
  [limitOverride: `LIMIT_${string}`]: string | undefined;
}

/** Internal headers the Worker sets on requests it forwards to Durable Objects. */
export const H_KIND = "x-mr-kind";
export const H_TENANT = "x-mr-tenant";
export const H_MACHINE = "x-mr-machine";
export const H_TOKEN_HASH = "x-mr-token-hash";
export const H_EMAIL = "x-mr-email";

/** VAPID keys are configured (Web Push available). */
export function pushConfigured(env: Env): boolean {
  return !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY;
}

/** Extra push endpoint origins for local tests: only with DEV_AUTH=1 (never set on a deployed Worker). */
export function pushExtraOrigins(env: Env): string[] {
  if (env.DEV_AUTH !== "1" || !env.PUSH_EXTRA_ORIGINS) return [];
  return env.PUSH_EXTRA_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(s));
}

/** Phone socket: the page was visible when it connected ("1") and its push subscription id (Phase 4). */
export const H_VIS = "x-mr-vis";
export const H_DEV = "x-mr-dev";
