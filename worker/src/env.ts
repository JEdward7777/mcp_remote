import type { Hub } from "./hub";
import type { Pairing } from "./pairing";

export interface Env {
  HUB: DurableObjectNamespace<Hub>;
  PAIRING: DurableObjectNamespace<Pairing>;
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
}

/** Internal headers the Worker sets on requests it forwards to Durable Objects. */
export const H_KIND = "x-mr-kind";
export const H_TENANT = "x-mr-tenant";
export const H_MACHINE = "x-mr-machine";
export const H_TOKEN_HASH = "x-mr-token-hash";
export const H_EMAIL = "x-mr-email";
