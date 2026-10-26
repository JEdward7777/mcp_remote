// Phase 4b (D12, D13, D9): sign-up gating precedence, waitlist and invite links, the Registry (usage
// reports, aggregation cost, global guard, owner alerts), owner-only admin API, disabling a tenant end
// to end, and the signed-in pairing start (one-line install) that bypasses the anonymous pair-start cap.
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  makeInviteToken,
  makeSessionCookieValue,
  makeWaitCookieValue,
  signBlob,
  tenantIdForDev,
  verifyInviteToken,
} from "../src/auth";
import { PAIR_START_ROWS_WRITTEN_EST, limitsFor } from "../src/budget";
import { REPORT_ROWS_READ_EST, REPORT_ROWS_WRITTEN_EST, type Registry, type ReportCounts, type UsageReport } from "../src/registry";
import {
  SIGNUP_DEFAULTS,
  type SignupConfig,
  type SignupInput,
  decideSignup,
  envAllowed,
  guardLevel,
  guardState,
  newAlertThresholds,
  signupConfig,
} from "../src/signup";
import { utcDay } from "../src/usage";
import { E, ORIGIN, connect, cookieFor, daemon, last, newMachine, phone, sleep, waitFor, withHub } from "./helpers";
import { decryptPush, fakePushService, fakeSubscription } from "./push-helpers";

// ---------------------------------------------------------------------------
// Helpers

const OWNER = "boss"; // boss@dev.local is in OWNER_EMAILS (vitest.config.ts)
const ENV = { ALLOWED_EMAILS: "allowed@example.com", OWNER_EMAILS: "owner@example.com" };

function regStub(name: string): DurableObjectStub<Registry> {
  return E.REGISTRY.get(E.REGISTRY.idFromName(name));
}

/** A fresh, private Registry instance (its own storage) with test config. */
async function freshRegistry(cfg: Partial<SignupConfig> = {}, env: Record<string, string> = ENV): Promise<DurableObjectStub<Registry>> {
  const stub = regStub(`test-${crypto.randomUUID()}`);
  await inReg(stub, (r) => {
    r.cfgOverride = { ...cfg };
    r.envOverride = env;
  });
  return stub;
}

async function inReg<T>(stub: DurableObjectStub<Registry>, fn: (r: any, s: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stub as unknown as DurableObjectStub, fn as (i: unknown, s: DurableObjectState) => T | Promise<T>);
}

/** The deployment's Registry (what the Worker and Hubs use), with test config applied until reset. */
const mainReg = () => regStub("registry");
async function configureMain(cfg: Partial<SignupConfig> | null): Promise<void> {
  await inReg(mainReg(), (r) => {
    r.cfgOverride = cfg;
  });
}

const signIn = (reg: DurableObjectStub<Registry>, email: string, extra: Partial<{ tid: string; inviteId: string; dev: boolean; emailVerified: boolean }> = {}) =>
  reg.signIn({ tid: extra.tid ?? `g-${email.replace(/[^a-z0-9]/gi, "")}`, email, emailVerified: extra.emailVerified ?? true, inviteId: extra.inviteId ?? null, dev: extra.dev ?? false });

const counts = (p: Partial<ReportCounts> = {}): ReportCounts => ({
  do_requests: 0,
  messages: 0,
  launches: 0,
  pushes: 0,
  rows_read: 0,
  rows_written: 0,
  machines: 0,
  sessions: 0,
  ...p,
});

function report(tid: string, c: Partial<ReportCounts>, day = utcDay(Date.now())): UsageReport {
  return { tid, email: `${tid}@example.com`, plan: "free", day, counts: counts(c) };
}

async function api(path: string, cookie: string | null, init: { method?: string; body?: unknown; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { origin: init.origin ?? ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return SELF.fetch(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
}

const ownerCookie = () => cookieFor(OWNER);
// biome-ignore lint: test helper
const jsonOf = (r: Response): Promise<any> => r.json();

// ---------------------------------------------------------------------------

describe("sign-up gating (pure decision, precedence)", () => {
  const cfg = (p: Partial<SignupConfig> = {}): SignupConfig => ({ ...SIGNUP_DEFAULTS, ...p });
  const input = (p: Partial<SignupInput> = {}): SignupInput => ({
    email: "x@example.com",
    emailVerified: true,
    existing: null,
    invite: false,
    dev: false,
    activeCount: 0,
    waitlistCount: 0,
    paused: false,
    ...p,
  });

  it("parses the env (defaults, modes, off switches)", () => {
    expect(signupConfig({})).toMatchObject({ mode: "closed", userCap: 10, waitlistMax: 500, pauseAt: 80, tightenAt: 90, tightenShare: 5, alertAt: [50, 80] });
    expect(signupConfig({ OPEN_SIGNUP: "true", USER_CAP: "3" })).toMatchObject({ mode: "open", userCap: 3 });
    expect(signupConfig({ OPEN_SIGNUP: "waitlist" }).mode).toBe("waitlist");
    expect(signupConfig({ GUARD_PAUSE_SIGNUPS_PERCENT: "off", GUARD_TIGHTEN_PERCENT: "0", ALERT_USAGE_PERCENTS: "off", USAGE_REPORT_MINUTES: "off" })).toMatchObject({
      pauseAt: null,
      tightenAt: null,
      alertAt: [],
      reportEveryMs: null,
    });
    expect(signupConfig({ ALERT_USAGE_PERCENTS: "80, 50,95", USER_CAP: "nope" })).toMatchObject({ alertAt: [50, 80, 95], userCap: 10 });
  });

  it("follows the documented precedence", () => {
    const env = ENV;
    // 1. unverified
    expect(decideSignup(input({ emailVerified: false }), cfg({ mode: "open" }), env)).toEqual({ kind: "refused", reason: "unverified" });
    // 2. owner beats disabled, cap and closed mode
    expect(decideSignup(input({ email: "Owner@example.com", existing: { status: "disabled", via: "open" } }), cfg(), env)).toMatchObject({ kind: "active", via: "owner" });
    // 3. disabled beats allowlist and invites
    expect(decideSignup(input({ email: "allowed@example.com", existing: { status: "disabled", via: "allowlist" }, invite: true }), cfg(), env)).toEqual({ kind: "refused", reason: "disabled" });
    // 4. allowlist beats cap/closed/denied
    expect(decideSignup(input({ email: "allowed@example.com", existing: { status: "denied", via: "open" }, activeCount: 99 }), cfg({ mode: "open", userCap: 1 }), env)).toMatchObject({ kind: "active", via: "allowlist" });
    // 5. already active (Registry-admitted) stays, even over the cap / closed
    expect(decideSignup(input({ existing: { status: "active", via: "invite" }, activeCount: 99 }), cfg({ mode: "closed" }), env)).toMatchObject({ kind: "active", via: "invite" });
    // ...but an allowlist admission ends with the list
    expect(decideSignup(input({ existing: { status: "active", via: "allowlist" } }), cfg({ mode: "closed" }), env)).toEqual({ kind: "refused", reason: "closed" });
    // ...and a pre-4b (legacy) account keeps the old rule: fine unless sign-up is closed
    expect(decideSignup(input({ existing: { status: "active", via: "legacy" } }), cfg({ mode: "open", userCap: 0 }), env)).toMatchObject({ kind: "active", via: "legacy" });
    expect(decideSignup(input({ existing: { status: "active", via: "legacy" } }), cfg({ mode: "closed" }), env)).toEqual({ kind: "refused", reason: "closed" });
    // 6. invite beats waitlist, cap, pause and closed mode
    expect(decideSignup(input({ invite: true, existing: { status: "waitlisted", via: "open" }, paused: true }), cfg({ mode: "closed" }), env)).toMatchObject({ kind: "active", via: "invite", consumeInvite: true });
    // 7. waitlisted stays waitlisted; denied is refused
    expect(decideSignup(input({ existing: { status: "waitlisted", via: "open" } }), cfg({ mode: "open" }), env)).toEqual({ kind: "waitlisted", isNew: false });
    expect(decideSignup(input({ existing: { status: "denied", via: "open" } }), cfg({ mode: "open" }), env)).toEqual({ kind: "refused", reason: "denied" });
    // 8. modes
    expect(decideSignup(input(), cfg({ mode: "closed" }), env)).toEqual({ kind: "refused", reason: "closed" });
    expect(decideSignup(input(), cfg({ mode: "waitlist" }), env)).toEqual({ kind: "waitlisted", isNew: true });
    expect(decideSignup(input({ activeCount: 2 }), cfg({ mode: "open", userCap: 3 }), env)).toMatchObject({ kind: "active", via: "open" });
    expect(decideSignup(input({ activeCount: 3 }), cfg({ mode: "open", userCap: 3 }), env)).toEqual({ kind: "waitlisted", isNew: true });
    expect(decideSignup(input({ activeCount: 0, paused: true }), cfg({ mode: "open" }), env)).toEqual({ kind: "waitlisted", isNew: true });
    expect(decideSignup(input({ activeCount: 3, waitlistCount: 5 }), cfg({ mode: "open", userCap: 3, waitlistMax: 5 }), env)).toEqual({ kind: "refused", reason: "waitlist_full" });
  });

  it("per-request env check (adm 'env' and old cookies) = OPEN_SIGNUP, ALLOWED_EMAILS or OWNER_EMAILS", () => {
    expect(envAllowed("allowed@example.com", ENV)).toBe(true);
    expect(envAllowed("OWNER@example.com", ENV)).toBe(true);
    expect(envAllowed("x@example.com", ENV)).toBe(false);
    expect(envAllowed("x@example.com", { ...ENV, OPEN_SIGNUP: "true" })).toBe(true);
    expect(envAllowed("x@example.com", { ...ENV, OPEN_SIGNUP: "waitlist" })).toBe(false);
  });

  it("guard level, guard state and alert thresholds", () => {
    const lvl = guardLevel({ do_requests: 50_000, rows_read: 1_000_000, rows_written: 85_000 });
    expect(lvl.metric).toBe("rows_written");
    expect(Math.round(lvl.percent)).toBe(85);
    const c = { ...SIGNUP_DEFAULTS };
    expect(guardState("d", lvl, c, false)).toEqual({ day: "d", paused: true, free_share: null });
    expect(guardState("d", guardLevel({ do_requests: 91_000, rows_read: 0, rows_written: 0 }), c, false).free_share).toBe(5);
    expect(guardState("d", guardLevel({ do_requests: 1, rows_read: 0, rows_written: 0 }), c, true).paused).toBe(true);
    expect(guardState("d", lvl, { ...c, pauseAt: null }, false).paused).toBe(false);
    expect(newAlertThresholds(85, c, [])).toEqual([50, 80]);
    expect(newAlertThresholds(85, c, [50])).toEqual([80]);
    expect(newAlertThresholds(85, c, [50, 80])).toEqual([]);
    expect(newAlertThresholds(49.9, c, [])).toEqual([]);
  });

  it("the guard's tightened share only ever lowers a free account's daily budget", () => {
    expect(limitsFor("free", {}, 5).daily_share_percent).toBe(5);
    expect(limitsFor("free", { TENANT_DAILY_SHARE_PERCENT: "3" }, 5).daily_share_percent).toBe(3);
    expect(limitsFor("owner", {}, 5).daily_share_percent).toBe(50);
  });
});

describe("Registry: sign-in, waitlist, invites", () => {
  it("closed: strangers refused; ALLOWED_EMAILS and OWNER_EMAILS admitted (adm env)", async () => {
    const reg = await freshRegistry({ mode: "closed" });
    expect(await signIn(reg, "stranger@example.com")).toMatchObject({ status: "refused", reason: "closed" });
    expect(await signIn(reg, "allowed@example.com")).toMatchObject({ status: "active", adm: "env", via: "allowlist" });
    expect(await signIn(reg, "owner@example.com")).toMatchObject({ status: "active", adm: "env", via: "owner" });
    expect(await signIn(reg, "x@example.com", { emailVerified: false })).toMatchObject({ status: "refused", reason: "unverified" });
    // A refused stranger leaves no record.
    expect((await reg.listTenants("all")).map((t) => t.email).sort()).toEqual(["allowed@example.com", "owner@example.com"]);
  });

  it("open: auto-approved up to USER_CAP, then the waitlist; owner approves with one call", async () => {
    const reg = await freshRegistry({ mode: "open", userCap: 2 });
    expect(await signIn(reg, "a@example.com")).toMatchObject({ status: "active", adm: "reg", via: "open" });
    expect(await signIn(reg, "b@example.com")).toMatchObject({ status: "active", via: "open" });
    expect(await signIn(reg, "c@example.com")).toMatchObject({ status: "waitlisted" });
    expect(await signIn(reg, "c@example.com")).toMatchObject({ status: "waitlisted" }); // stays, no duplicate
    // Allowlisted / owner accounts get in over the cap; returning active accounts stay in.
    expect(await signIn(reg, "allowed@example.com")).toMatchObject({ status: "active" });
    expect(await signIn(reg, "a@example.com")).toMatchObject({ status: "active", via: "open" });
    const wl = await reg.listTenants("waitlisted");
    expect(wl.map((t) => t.email)).toEqual(["c@example.com"]);
    expect(await reg.act("boss@dev.local", { t: "approve", tid: wl[0]!.tid })).toEqual({ ok: true });
    expect(await signIn(reg, "c@example.com")).toMatchObject({ status: "active", adm: "reg", via: "approved" });
    // Denied accounts are refused; deny only works on the waitlist.
    expect(await signIn(reg, "d@example.com")).toMatchObject({ status: "waitlisted" });
    const d = (await reg.listTenants("waitlisted"))[0]!;
    expect(await reg.act("boss@dev.local", { t: "deny", tid: d.tid })).toEqual({ ok: true });
    expect(await signIn(reg, "d@example.com")).toMatchObject({ status: "refused", reason: "denied" });
    expect(await reg.act("boss@dev.local", { t: "deny", tid: d.tid })).toMatchObject({ ok: false, status: 409 });
    const ov = await reg.overview();
    expect(ov.counts).toEqual({ active: 4, waitlisted: 0, denied: 1, disabled: 0 });
    expect(ov.days[0]).toMatchObject({ signups: 5, waitlist_joins: 2 });
    // Every owner action is audited.
    expect((await reg.auditLog()).map((a) => a.action)).toEqual(["deny", "approve"]);
  });

  it("pause (owner switch) sends new sign-ups to the waitlist; a full waitlist refuses", async () => {
    const reg = await freshRegistry({ mode: "open", userCap: 100, waitlistMax: 1 });
    await reg.act("boss@dev.local", { t: "pause", paused: true });
    expect(await signIn(reg, "p1@example.com")).toMatchObject({ status: "waitlisted" });
    expect(await signIn(reg, "p2@example.com")).toMatchObject({ status: "refused", reason: "waitlist_full" });
    await reg.act("boss@dev.local", { t: "pause", paused: false });
    expect(await signIn(reg, "p3@example.com")).toMatchObject({ status: "active" });
    expect((await reg.auditLog()).map((a) => a.action)).toEqual(["resume_signups", "pause_signups"]);
  });

  it("invites skip the waitlist; max uses, revocation and expiry are enforced", async () => {
    const reg = await freshRegistry({ mode: "waitlist" });
    const inv = await reg.createInvite("boss@dev.local", { id: "inv-aaaaaaaaaaaaaaaa", days: 7, max_uses: 2, note: "friends" });
    expect(inv.ok).toBe(true);
    expect(await signIn(reg, "i1@example.com", { inviteId: "inv-aaaaaaaaaaaaaaaa" })).toMatchObject({ status: "active", adm: "reg", via: "invite" });
    // An already admitted account doesn't use up the invite again.
    expect(await signIn(reg, "i1@example.com", { inviteId: "inv-aaaaaaaaaaaaaaaa" })).toMatchObject({ status: "active" });
    // A waitlisted account presenting an invite gets in.
    expect(await signIn(reg, "i2@example.com")).toMatchObject({ status: "waitlisted" });
    expect(await signIn(reg, "i2@example.com", { inviteId: "inv-aaaaaaaaaaaaaaaa" })).toMatchObject({ status: "active", via: "invite" });
    // Used up (2 of 2): the next one falls back to normal gating.
    expect(await signIn(reg, "i3@example.com", { inviteId: "inv-aaaaaaaaaaaaaaaa" })).toMatchObject({ status: "waitlisted" });
    expect((await reg.listInvites())[0]).toMatchObject({ uses: 2, max_uses: 2 });
    // Revoked
    await reg.createInvite("boss@dev.local", { id: "inv-bbbbbbbbbbbbbbbb", days: 7, max_uses: null, note: "" });
    expect(await reg.revokeInvite("boss@dev.local", "inv-bbbbbbbbbbbbbbbb")).toBe(true);
    expect(await reg.revokeInvite("boss@dev.local", "inv-bbbbbbbbbbbbbbbb")).toBe(false);
    expect(await signIn(reg, "i4@example.com", { inviteId: "inv-bbbbbbbbbbbbbbbb" })).toMatchObject({ status: "waitlisted" });
    // Expired (the stored expiry counts, not only the link's)
    await reg.createInvite("boss@dev.local", { id: "inv-cccccccccccccccc", days: 1, max_uses: null, note: "" });
    await inReg(reg, (_r, s) => s.storage.sql.exec("UPDATE invites SET expires_at = ? WHERE id = 'inv-cccccccccccccccc'", Date.now() - 1));
    expect(await signIn(reg, "i5@example.com", { inviteId: "inv-cccccccccccccccc" })).toMatchObject({ status: "waitlisted" });
    // A disabled account stays out even with a valid invite.
    await reg.createInvite("boss@dev.local", { id: "inv-dddddddddddddddd", days: 7, max_uses: null, note: "" });
    const i1 = (await reg.listTenants("active")).find((t) => t.email === "i1@example.com")!;
    await reg.act("boss@dev.local", { t: "disable", tid: i1.tid });
    expect(await signIn(reg, "i1@example.com", { inviteId: "inv-dddddddddddddddd" })).toMatchObject({ status: "refused", reason: "disabled" });
    const audit = (await reg.auditLog()).map((a) => a.action);
    expect(audit).toContain("invite_create");
    expect(audit).toContain("invite_used");
    expect(audit).toContain("invite_revoke");
    expect(audit).toContain("disable");
  });

  it("waitlisted or denied sign-ups can be removed entirely (email not kept, not even in the audit log)", async () => {
    const reg = await freshRegistry({ mode: "waitlist" });
    await signIn(reg, "gone@example.com");
    const t = (await reg.listTenants("waitlisted"))[0]!;
    expect(await reg.act("boss@dev.local", { t: "forget", tid: t.tid })).toEqual({ ok: true });
    expect(await reg.listTenants("all")).toEqual([]);
    expect((await reg.overview()).counts.waitlisted).toBe(0);
    expect(JSON.stringify(await reg.auditLog())).not.toContain("gone@example.com");
    // Active accounts can't be "forgotten" this way (disable them instead).
    await signIn(reg, "allowed@example.com");
    const a = (await reg.listTenants("active"))[0]!;
    expect(await reg.act("boss@dev.local", { t: "forget", tid: a.tid })).toMatchObject({ ok: false, status: 409 });
  });

  it("deny then remove: the email is scrubbed from earlier audit entries too", async () => {
    const reg = await freshRegistry({ mode: "waitlist" });
    await reg.signIn({ tid: "g-denyme", email: "denyme@example.com", emailVerified: true });
    expect(await reg.act("owner@example.com", { t: "deny", tid: "g-denyme" })).toEqual({ ok: true });
    expect(JSON.stringify(await reg.auditLog())).toContain("denyme@example.com");
    expect(await reg.act("owner@example.com", { t: "forget", tid: "g-denyme" })).toEqual({ ok: true });
    const audit = JSON.stringify(await reg.auditLog());
    expect(audit).not.toContain("denyme@example.com");
    expect(audit).not.toContain("g-denyme");
    expect((await reg.auditLog()).map((a) => a.action)).toEqual(["forget", "deny"]);
  });

  it("a pre-4b (legacy) account is migrated to Registry-governed when sign-up is not closed (report answer too)", async () => {
    const reg = await freshRegistry({ mode: "waitlist" });
    const ans = await reg.report(report("g-legacyrep", { do_requests: 1 }));
    expect(ans).toMatchObject({ status: "active", adm: "reg" });
    expect((await reg.listTenants("all"))[0]).toMatchObject({ via: "open" });
    // In closed mode a legacy account keeps the env rule (as before Phase 4b).
    const closed = await freshRegistry({ mode: "closed" });
    expect(await closed.report(report("g-legacyclosed", { do_requests: 1 }))).toMatchObject({ adm: "env" });
    expect(await closed.signIn({ tid: "g-legacyclosed", email: "g-legacyclosed@example.com", emailVerified: true })).toMatchObject({ status: "refused", reason: "closed" });
  });

  it("an owner account can't be disabled; plans change only for admitted accounts", async () => {
    const reg = await freshRegistry({ mode: "open", userCap: 5 });
    await signIn(reg, "owner@example.com");
    await signIn(reg, "f1@example.com");
    const all = await reg.listTenants("all");
    const own = all.find((t) => t.email === "owner@example.com")!;
    const f1 = all.find((t) => t.email === "f1@example.com")!;
    expect(await reg.act("boss@dev.local", { t: "disable", tid: own.tid })).toMatchObject({ ok: false, status: 409 });
    expect(await reg.act("boss@dev.local", { t: "plan", tid: f1.tid, plan: "gold" })).toMatchObject({ ok: false, status: 400 });
    expect(await reg.act("boss@dev.local", { t: "plan", tid: f1.tid, plan: "owner" })).toEqual({ ok: true });
    expect((await reg.listTenants("all")).find((t) => t.tid === f1.tid)!.plan).toBe("owner");
    expect(await reg.act("boss@dev.local", { t: "enable", tid: "g-nobody" })).toMatchObject({ ok: false, status: 404 });
  });

  it("invite links are signed and expire (no Durable Object needed to reject a forged one)", async () => {
    const secret = E.SESSION_SECRET;
    const t = await makeInviteToken(secret, "inv-eeeeeeeeeeeeeeee", Date.now() + 60_000);
    expect(await verifyInviteToken(secret, t)).toMatchObject({ id: "inv-eeeeeeeeeeeeeeee" });
    expect(await verifyInviteToken(secret, `${t}x`)).toBeNull();
    expect(await verifyInviteToken("another-secret-0123456789-0123456789", t)).toBeNull();
    expect(await verifyInviteToken(secret, await makeInviteToken(secret, "inv-eeeeeeeeeeeeeeee", Date.now() - 1))).toBeNull();
    // A blob signed for another purpose (e.g. a session cookie) is not an invite.
    expect(await verifyInviteToken(secret, await signBlob(secret, "session", { i: "inv-eeeeeeeeeeeeeeee", e: 9e9 }))).toBeNull();
    // The sign-in page's check: a forged link is refused by the Worker; a genuine one is looked up.
    expect(await jsonOf(await SELF.fetch(`${ORIGIN}/api/invite?token=${encodeURIComponent(t)}x`))).toEqual({ valid: false, reason: "invalid" });
    expect(await jsonOf(await SELF.fetch(`${ORIGIN}/api/invite?token=${encodeURIComponent(t)}`))).toEqual({ valid: false, reason: "unknown" });
  });
});

describe("Worker: waitlist cookie, approval, adm claim", () => {
  it("a waitlisted account sees the waiting status; once approved, /api/me signs it in", async () => {
    const tid = "g-wl1waiting";
    await configureMain({ mode: "waitlist" });
    try {
      expect(await mainReg().signIn({ tid, email: "wl1@example.com", emailVerified: true })).toMatchObject({ status: "waitlisted" });
    } finally {
      await configureMain(null);
    }
    const wait = `__Host-mr_wait=${await makeWaitCookieValue(E.SESSION_SECRET, { tid, email: "wl1@example.com" })}`;
    const r1 = await api("/api/me", wait);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ waitlisted: true, email: "wl1@example.com" });
    // A wait cookie is never a session.
    expect((await api("/api/state", wait)).status).toBe(401);
    // The owner approves (one call).
    const ap = await api(`/api/admin/tenants/${tid}/approve`, await ownerCookie(), { method: "POST", body: {} });
    expect(ap.status, await ap.clone().text()).toBe(200);
    const r2 = await api("/api/me", wait);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ tenant: tid, approved: true, owner: false });
    const cookies = r2.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-mr_session="))!;
    expect(cookies.some((c) => c.startsWith("__Host-mr_wait=;"))).toBe(true);
    // Registry-admitted: the cookie carries adm "reg", so it is valid although not on ALLOWED_EMAILS.
    const st = await api("/api/state", session.split(";")[0]!);
    expect(st.status).toBe(200);
  });

  it("adm 'env' cookies are re-checked against the env vars; adm 'reg' ones are not", async () => {
    const env = await makeSessionCookieValue(E.SESSION_SECRET, { tid: "g-strangerenv", email: "stranger@example.com", adm: "env" });
    const reg = await makeSessionCookieValue(E.SESSION_SECRET, { tid: "g-strangerreg", email: "stranger@example.com", adm: "reg" });
    const old = await makeSessionCookieValue(E.SESSION_SECRET, { tid: "g-strangerold", email: "stranger@example.com" });
    const allowed = await makeSessionCookieValue(E.SESSION_SECRET, { tid: "g-allowedenv", email: "allowed@example.com", adm: "env" });
    expect((await api("/api/me", `__Host-mr_session=${env}`)).status).toBe(401);
    expect((await api("/api/me", `__Host-mr_session=${old}`)).status).toBe(401);
    expect((await api("/api/me", `__Host-mr_session=${allowed}`)).status).toBe(200);
    expect((await api("/api/me", `__Host-mr_session=${reg}`)).status).toBe(200);
  });
});

describe("review round 1", () => {
  it("legacy account + OPEN_SIGNUP=waitlist: sign-in admits it as 'reg', the per-request check passes, and its daemon connects", async () => {
    const tid = "g-legacywl";
    const email = "legacy.wl@example.com";
    const hub = E.HUB.get(E.HUB.idFromName(tid));
    const machineId = "mlegacywl0001";
    const { mintMachineToken } = await import("../src/auth");
    const { sha256Hex } = await import("../src/crypto");
    const token = await mintMachineToken(E.SESSION_SECRET, tid, machineId);
    await hub.addMachine(machineId, "old-box", await sha256Hex(token), email, "env");
    // Before: the env rule (not allowlisted, OPEN_SIGNUP not "true") refuses its daemon (exit-3 path).
    expect(await connect("/api/daemon/ws", { authorization: `Bearer ${token}` })).toBe(403);
    await configureMain({ mode: "closed" });
    try {
      await mainReg().report({ tid, email, plan: "free", day: utcDay(Date.now()), counts: counts({ do_requests: 1 }) }); // registered as legacy
      await configureMain({ mode: "waitlist" });
      const r = await mainReg().signIn({ tid, email, emailVerified: true });
      expect(r).toMatchObject({ status: "active", adm: "reg", via: "open" });
      // What getSession() does with the cookie it gets:
      const { accountAllowed } = await import("../src/oauth");
      expect(accountAllowed(tid, email, { ...ENV, OPEN_SIGNUP: "waitlist" }, (r as { adm: "env" | "reg" }).adm)).toBe(true);
      const cookie = `__Host-mr_session=${await makeSessionCookieValue(E.SESSION_SECRET, { tid, email, adm: "reg" })}`;
      expect((await api("/api/me", cookie)).status).toBe(200);
      // The sign-in synced the Hub (adm "reg"): the daemon connects now.
      let d: Awaited<ReturnType<typeof connect>> = 0;
      for (let i = 0; i < 50 && typeof d === "number"; i++) {
        d = await connect("/api/daemon/ws", { authorization: `Bearer ${token}` });
        if (typeof d === "number") await sleep(20);
      }
      if (typeof d === "number") throw new Error(`daemon refused: ${d}`);
      await waitFor(() => last(d, "welcome"), "welcome");
      d.ws.close();
    } finally {
      await configureMain(null);
    }
  });

  it("a Hub left disabled (Enable could not reach it) is put right by the next sign-in", async () => {
    const reg = await freshRegistry({ mode: "open", userCap: 5 });
    const tid = "g-stuckdisabled";
    await reg.signIn({ tid, email: "stuck@example.com", emailVerified: true });
    const hub = E.HUB.get(E.HUB.idFromName(tid));
    await hub.setAccount({ status: "disabled", adm: "reg", plan: "free" }); // the Registry says active
    expect(await hub.isDisabled()).toBe(true);
    expect(await reg.signIn({ tid, email: "stuck@example.com", emailVerified: true })).toMatchObject({ status: "active" });
    for (let i = 0; i < 50 && (await hub.isDisabled()); i++) await sleep(20);
    expect(await hub.isDisabled()).toBe(false);
  });

  it("malformed percent-encoding in an admin path is a 400, not a 500", async () => {
    const res = await api("/api/admin/tenants/%E0%A4%A/approve", await ownerCookie(), { method: "POST", body: {} });
    expect(res.status).toBe(400);
  });

  it("the invite check reports revoked links", async () => {
    const boss = await ownerCookie();
    const { invite } = await jsonOf(await api("/api/admin/invites", boss, { method: "POST", body: { days: 1, max_uses: 1 } }));
    const token = new URL(invite.link).searchParams.get("invite")!;
    const check = async () => jsonOf(await SELF.fetch(`${ORIGIN}/api/invite?token=${encodeURIComponent(token)}`));
    expect(await check()).toMatchObject({ valid: true });
    await api(`/api/admin/invites/${invite.id}`, boss, { method: "DELETE" });
    expect(await check()).toEqual({ valid: false, reason: "revoked" });
  });
});

describe("admin API: owner only (OWNER_EMAILS, checked on every route)", () => {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: "GET", path: "/api/admin/overview" },
    { method: "GET", path: "/api/admin/tenants?status=all" },
    { method: "GET", path: "/api/admin/tenants?status=waitlisted" },
    { method: "POST", path: "/api/admin/tenants/g-someone/approve", body: {} },
    { method: "POST", path: "/api/admin/tenants/g-someone/deny", body: {} },
    { method: "POST", path: "/api/admin/tenants/g-someone/disable", body: {} },
    { method: "POST", path: "/api/admin/tenants/g-someone/enable", body: {} },
    { method: "POST", path: "/api/admin/tenants/g-someone/plan", body: { plan: "owner" } },
    { method: "POST", path: "/api/admin/signups", body: { paused: true } },
    { method: "GET", path: "/api/admin/invites" },
    { method: "POST", path: "/api/admin/invites", body: { days: 1 } },
    { method: "DELETE", path: "/api/admin/invites/inv-aaaaaaaaaaaaaaaa" },
    { method: "GET", path: "/api/admin/audit" },
    { method: "GET", path: "/api/admin/unknown" },
  ];

  it("a signed-in non-owner gets 403 on every admin route (and no other account's data)", async () => {
    // Some data in the deployment's Registry that must not leak.
    await mainReg().signIn({ tid: "g-secretperson", email: "secret.person@example.com", emailVerified: true, dev: true });
    const alice = await cookieFor("adm-alice");
    for (const r of routes) {
      const res = await api(r.path, alice, { method: r.method, body: r.body });
      const text = await res.text();
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(text).not.toMatch(/secret\.person|g-secretperson/);
    }
    const me = await jsonOf(await api("/api/me", alice));
    expect(me.owner).toBe(false);
    // Signed out: 401 everywhere.
    for (const r of routes) expect((await api(r.path, null, { method: r.method, body: r.body })).status, r.path).toBe(401);
  });

  it("the owner gets the data; writes from a foreign Origin are refused", async () => {
    const boss = await ownerCookie();
    expect((await jsonOf(await api("/api/me", boss))).owner).toBe(true);
    const ov = await jsonOf(await api("/api/admin/overview", boss));
    expect(ov).toMatchObject({ limits: { do_requests: 100_000, rows_read: 5_000_000, rows_written: 100_000 } });
    expect(typeof ov.level.percent).toBe("number");
    const all = await jsonOf(await api("/api/admin/tenants?status=all", boss));
    expect(all.tenants.some((t: { email: string }) => t.email === "secret.person@example.com")).toBe(true);
    for (const r of routes.filter((x) => x.method !== "GET")) {
      expect((await api(r.path, boss, { method: r.method, body: r.body, origin: "https://evil.example" })).status, r.path).toBe(403);
    }
    // Invite create -> link -> revoke, all audited.
    const c = await api("/api/admin/invites", boss, { method: "POST", body: { days: 2, max_uses: 3, note: "test" } });
    expect(c.status).toBe(200);
    const { invite } = await jsonOf(c);
    expect(invite.link).toMatch(new RegExp(`^${ORIGIN}/\\?invite=v1\\.`));
    const token = new URL(invite.link).searchParams.get("invite")!;
    expect(await verifyInviteToken(E.SESSION_SECRET, token)).toMatchObject({ id: invite.id });
    expect((await api(`/api/admin/invites/${invite.id}`, boss, { method: "DELETE" })).status).toBe(200);
    const audit = await jsonOf(await api("/api/admin/audit", boss));
    expect(audit.audit.slice(0, 2).map((a: { action: string }) => a.action)).toEqual(["invite_revoke", "invite_create"]);
    expect(audit.audit[0].actor).toBe("boss@dev.local");
  });
});

describe("Registry: usage reports, aggregation cost, global guard, owner alerts", () => {
  it("reports are idempotent per (day, tenant): totals move by the difference; DAU counts tenants", async () => {
    const reg = await freshRegistry();
    await reg.report(report("t-a", { do_requests: 100, rows_written: 50, messages: 3 }));
    await reg.report(report("t-a", { do_requests: 100, rows_written: 50, messages: 3 })); // duplicate
    await reg.report(report("t-a", { do_requests: 150, rows_written: 60, messages: 4 }));
    await reg.report(report("t-b", { do_requests: 10, rows_written: 5 }));
    const ov = await reg.overview();
    const d = ov.days[0]!;
    expect(d).toMatchObject({ dau: 2, do_requests: 160, rows_written: 65, messages: 4 });
    // Unknown tenants (accounts from before Phase 4b) are registered as active "legacy".
    expect(ov.counts.active).toBe(2);
    expect((await reg.listTenants("all")).every((t) => t.via === "legacy")).toBe(true);
    expect(ov.top.map((t) => t.tid)).toEqual(["t-a", "t-b"]);
    // Totals include the Registry's own cost.
    expect(ov.totals.do_requests).toBeGreaterThan(160);
  });

  it("one report costs the Registry at most the rows charged to the reporting tenant", async () => {
    const reg = await freshRegistry();
    await reg.report(report("t-cost", { do_requests: 1 })); // registers the tenant (one-time)
    const cost = async (r: UsageReport) =>
      inReg(reg, async (inst) => {
        const before = { ...inst.own };
        await inst.report(r);
        return { read: inst.own.rows_read - before.rows_read, written: inst.own.rows_written - before.rows_written };
      });
    const steady = await cost(report("t-cost", { do_requests: 5, rows_written: 9 }));
    expect(steady.written).toBeLessThanOrEqual(REPORT_ROWS_WRITTEN_EST);
    expect(steady.read).toBeLessThanOrEqual(REPORT_ROWS_READ_EST);
    // First report of a new day (also writes last_active_day), with the final numbers of the previous day.
    const yesterday = utcDay(Date.now() - 86_400_000);
    await inReg(reg, (_i, s) => s.storage.sql.exec("UPDATE tenants SET last_active_day = ? WHERE tid = 't-cost'", yesterday));
    const dayOne = await cost(report("t-cost", { do_requests: 6 }));
    expect(dayOne.written).toBeLessThanOrEqual(REPORT_ROWS_WRITTEN_EST);
    expect(dayOne.read).toBeLessThanOrEqual(REPORT_ROWS_READ_EST);
    const withPrev = await cost({ ...report("t-cost", { do_requests: 7 }), prev: { day: yesterday, counts: counts({ do_requests: 3 }) } });
    expect(withPrev.written).toBeLessThanOrEqual(2 * REPORT_ROWS_WRITTEN_EST);
    expect(withPrev.read).toBeLessThanOrEqual(2 * REPORT_ROWS_READ_EST);
    // Measured (local workerd): steady 3 read / 2 written; first of a day 4 / 3; with the previous day 4 / 4.
  });

  it("guard thresholds: alerts once per threshold per day, pause at 80%, tighten at 90%", async () => {
    const reg = await freshRegistry();
    const sent = () => inReg(reg, (r) => r.sentAlerts.map((a: { tag: string }) => a.tag));
    let ans = await reg.report(report("t-g", { do_requests: 40_000 }));
    expect(ans.guard).toMatchObject({ paused: false, free_share: null });
    expect(await sent()).toEqual([]);
    ans = await reg.report(report("t-g", { do_requests: 55_000 }));
    expect(await sent()).toEqual(["usage-50"]);
    await reg.report(report("t-g", { do_requests: 56_000 }));
    expect(await sent()).toEqual(["usage-50"]); // once per threshold per day
    ans = await reg.report(report("t-g", { do_requests: 85_000 }));
    expect(ans.guard).toMatchObject({ day: utcDay(Date.now()), paused: true, free_share: null });
    expect(await sent()).toEqual(["usage-50", "usage-80"]);
    ans = await reg.report(report("t-g", { do_requests: 95_000 }));
    expect(ans.guard).toMatchObject({ paused: true, free_share: 5 });
    expect(await sent()).toEqual(["usage-50", "usage-80"]);
    // Rows count too (rows written at 60% of the free limit, requests lower).
    const reg2 = await freshRegistry({ alertAt: [60] });
    await reg2.report(report("t-r", { rows_written: 61_000 }));
    expect(await inReg(reg2, (r) => r.sentAlerts.map((a: { title: string }) => a.title))).toEqual(["Usage passed 60% of the free plan"]);
    // A paused guard sends new strangers to the waitlist.
    const r3 = await freshRegistry({ mode: "open", userCap: 100 });
    await r3.report(report("t-big", { rows_written: 90_000 }));
    expect(await signIn(r3, "late@example.com")).toMatchObject({ status: "waitlisted" });
    // A new UTC day starts with no alerts sent.
    await inReg(reg, (r) => {
      r.alerts.day = "2000-01-01";
    });
    await reg.report(report("t-g", { do_requests: 95_001 }));
    expect(await sent()).toEqual(["usage-50", "usage-80", "usage-80"]);
  });

  it("sign-up spike and waitlist alerts: at most once per day", async () => {
    const reg = await freshRegistry({ mode: "waitlist", alertSignups: 3 });
    for (const e of ["s1", "s2", "s3", "s4"]) await signIn(reg, `${e}@example.com`);
    const tags = await inReg(reg, (r) => r.sentAlerts.map((a: { tag: string }) => a.tag));
    expect(tags).toEqual(["waitlist", "signups"]);
  });

  it("owner alerts reach the owner's phones as Web Push (payload k=a, opens Admin)", async () => {
    const reg = await freshRegistry({}, { OWNER_EMAILS: "boss@dev.local" });
    await reg.signIn({ tid: tenantIdForDev(OWNER), email: "boss@dev.local", emailVerified: true, dev: true });
    const sub = await fakeSubscription();
    const s = await SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
      method: "POST",
      headers: { cookie: await ownerCookie(), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(sub),
    });
    expect(s.status).toBe(200);
    const calls = await fakePushService(OWNER);
    const before = calls.length;
    await reg.report(report("t-alert", { do_requests: 51_000 }));
    await waitFor(() => calls.length > before, "owner alert push");
    const payload = await decryptPush(sub, calls.at(-1)!.body);
    expect(payload).toMatchObject({ k: "a", g: "usage-50", t: "Usage passed 50% of the free plan" });
    expect(calls.at(-1)!.headers.urgency).toBe("high");
  });

  it("a Hub reports at most once per interval, charges itself, and applies the guard's answer", async () => {
    const user = "rep-hub";
    const tid = tenantIdForDev(user);
    await withHub(user, (hub) => {
      hub.reportEveryMs = 15 * 60_000;
    });
    const p = await phone(user);
    await waitFor(() => last(p, "state"), "state");
    await withHub(user, async (hub) => {
      await hub.reportPromise;
    });
    const row = () =>
      inReg(mainReg(), (_r, s) => s.storage.sql.exec("SELECT * FROM daily WHERE tid = ? AND day = ?", tid, utcDay(Date.now())).toArray()[0] as Record<string, number> | undefined);
    const first = await row();
    expect(first?.do_requests).toBeGreaterThan(0);
    expect(await withHub(user, (hub) => hub.reportsSent)).toBe(1);
    for (let i = 0; i < 10; i++) p.send({ t: "refresh" });
    await sleep(100);
    expect(await withHub(user, (hub) => hub.reportsSent)).toBe(1); // never per message/frame
    // 16 minutes later (simulated), the next event reports again.
    await withHub(user, (hub) => {
      hub.rep = { ...hub.rep, at: Date.now() - 16 * 60_000 };
    });
    p.send({ t: "refresh" });
    await waitFor(async () => (await withHub(user, (hub) => hub.reportsSent)) === 2, "second report");
    await withHub(user, async (hub) => {
      await hub.reportPromise;
    });
    const second = await row();
    expect(second!.do_requests!).toBeGreaterThan(first!.do_requests!);
    // The report itself is charged to the tenant (request + estimated Registry rows).
    const today = await withHub(user, (hub) => hub.meter.today(Date.now()));
    expect(today.rows_written).toBeGreaterThanOrEqual(2 * REPORT_ROWS_WRITTEN_EST);
    // The guard's answer tightens this free account's daily share for today.
    await inReg(mainReg(), (r) => {
      r.cfgOverride = { tightenAt: 0, tightenShare: 2, pauseAt: null, alertAt: [] }; // any usage counts as "near the limit"
    });
    try {
      await withHub(user, (hub) => {
        hub.rep = { ...hub.rep, at: 0 };
      });
      p.send({ t: "refresh" });
      await waitFor(async () => (await withHub(user, (hub) => hub.reportsSent)) === 3, "third report");
      await withHub(user, async (hub) => {
        await hub.reportPromise;
      });
      const lim = await withHub(user, (hub) => ({ share: hub.limits.daily_share_percent, guard: hub.guard }));
      expect(lim.guard).toMatchObject({ free_share: 2 });
      expect(lim.share).toBe(2);
    } finally {
      await configureMain(null);
    }
    p.ws.close();
  });
});

describe("disabling a tenant (end to end)", () => {
  it("owner disables: daemon closed 4001 and refused (403, the daemon's exit-3 path), phone 4403, API 403; enable restores", async () => {
    const user = "dis-1";
    const tid = tenantIdForDev(user);
    await mainReg().signIn({ tid, email: `${user}@dev.local`, emailVerified: true, dev: true });
    const { token } = await newMachine(user);
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "dis-s", project: "p" }] });
    await waitFor(() => last(d, "welcome"), "welcome");
    const p = await phone(user);
    await waitFor(() => last(p, "state"), "state");
    const cookie = await cookieFor(user);

    const r = await api(`/api/admin/tenants/${tid}/disable`, await ownerCookie(), { method: "POST", body: {} });
    expect(r.status, await r.clone().text()).toBe(200);
    await waitFor(() => d.closed && p.closed, "sockets closed");
    expect(d.closed!.code).toBe(4001);
    expect(p.closed!.code).toBe(4403);
    expect(await connect("/api/daemon/ws", { authorization: `Bearer ${token}` })).toBe(403);
    const ph = await phone(user);
    await waitFor(() => ph.closed, "refused phone");
    expect(ph.closed!.code).toBe(4403);
    const st = await api("/api/state", cookie);
    expect(st.status).toBe(403);
    expect(await st.json()).toMatchObject({ disabled: true });
    expect(st.headers.getSetCookie().some((c) => c.startsWith("__Host-mr_session=;"))).toBe(true);
    // The cookie is now treated as signed out in this isolate (no Hub wake-up).
    expect((await api("/api/me", cookie)).status).toBe(401);
    expect((await api("/api/pair/start-signed", cookie, { method: "POST", body: {} })).status).toBe(401);
    // Pairing approvals are refused by the Hub as well.
    expect(await withHub(user, (hub) => hub.allowPairStart())).toMatchObject({ ok: false, disabled: true });

    const en = await api(`/api/admin/tenants/${tid}/enable`, await ownerCookie(), { method: "POST", body: {} });
    expect(en.status).toBe(200);
    const d2 = await daemon(token);
    await waitFor(() => last(d2, "welcome"), "welcome after enable");
    expect((await api("/api/state", cookie)).status).toBe(200);
    d2.ws.close();
  });
});

describe("signed-in pairing start (one-line install)", () => {
  const ip = "203.0.113.77";
  const startSigned = async (cookie: string) =>
    SELF.fetch(`${ORIGIN}/api/pair/start-signed`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": ip },
      body: "{}",
    });
  const redeem = (code: string, hostname = "laptop") =>
    SELF.fetch(`${ORIGIN}/api/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.9" },
      body: JSON.stringify({ code, hostname }),
    });

  it("works when anonymous pairing starts from the same network are throttled, and is charged to the account", async () => {
    // Use up the anonymous per-IP pair-start limit from this network.
    let refused = 0;
    for (let i = 0; i < 8; i++) {
      const r = await SELF.fetch(`${ORIGIN}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: "{}" });
      if (r.status === 429) refused++;
      await r.body?.cancel();
    }
    expect(refused).toBeGreaterThan(0);
    const user = "inst-1";
    const cookie = await cookieFor(user);
    const before = await withHub(user, (hub) => hub.meter.today(Date.now()));
    const r = await startSigned(cookie);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = await jsonOf(r);
    expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(body.url).toBe(ORIGIN);
    const after = await withHub(user, (hub) => hub.meter.today(Date.now()));
    expect(after.rows_written - before.rows_written).toBeGreaterThanOrEqual(PAIR_START_ROWS_WRITTEN_EST);
    expect(after.requests - before.requests).toBeGreaterThanOrEqual(3);
    // The Throttle DO (anonymous pair-start cap) was not consulted for it: no foreign Origin either.
    expect((await api("/api/pair/start-signed", cookie, { method: "POST", body: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await api("/api/pair/start-signed", null, { method: "POST", body: {} })).status).toBe(401);

    // The computer redeems it: token straight back, pre-approved, machine appears on the account.
    const p = await phone(user);
    await waitFor(() => last(p, "state"), "state");
    const rd = await redeem(body.code.toLowerCase());
    expect(rd.status, await rd.clone().text()).toBe(200);
    const pr = await jsonOf(rd);
    expect(pr).toMatchObject({ machine_name: "laptop", account: `${user}@dev.local` });
    await waitFor(() => last(p, "state")?.machines.some((m: { name: string }) => m.name === "laptop"), "machine on the phone");
    const dsock = await daemon(pr.token);
    await waitFor(() => last(dsock, "welcome"), "daemon welcome");
    // Single use; claim forgets it.
    expect((await redeem(body.code)).status).toBe(409);
    const claim = await SELF.fetch(`${ORIGIN}/api/pair/claim?code=${body.code}&pairing_id=${pr.pairing_id}`, { method: "POST", headers: { authorization: `Bearer ${pr.poll_secret}` } });
    expect(claim.status).toBe(200);
    expect((await redeem(body.code)).status).toBe(404);
    dsock.ws.close();
    p.ws.close();
  });

  it("works while the GLOBAL anonymous pair-start cap is used up (it never consults the Throttle DO)", async () => {
    const shards = [0, 1, 2, 3].map((i) => E.THROTTLE.get(E.THROTTLE.idFromName(`shard:${i}`)) as unknown as DurableObjectStub);
    const drain = (empty: boolean) =>
      Promise.all(
        shards.map((st) =>
          runInDurableObject(st, (inst: any, state) => {
            const now = Date.now();
            if (empty) {
              state.storage.sql.exec(
                "INSERT INTO buckets (k, t, at, full_at) VALUES ('ps:*', 0, ?, ?) ON CONFLICT(k) DO UPDATE SET t = 0, at = excluded.at, full_at = excluded.full_at",
                now,
                now + 3600_000,
              );
              inst.cache.set("ps:*", { t: 0, at: now });
            } else {
              state.storage.sql.exec("DELETE FROM buckets WHERE k = 'ps:*'");
              inst.cache.delete("ps:*");
            }
          }),
        ),
      );
    await drain(true);
    try {
      const anon = await SELF.fetch(`${ORIGIN}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.201" }, body: "{}" });
      expect(anon.status).toBe(429); // a fresh network, refused by the global cap
      const r = await SELF.fetch(`${ORIGIN}/api/pair/start-signed`, {
        method: "POST",
        headers: { cookie: await cookieFor("inst-global"), origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "192.0.2.201" },
        body: "{}",
      });
      expect(r.status, await r.clone().text()).toBe(200);
    } finally {
      await drain(false);
    }
  });

  it("unknown, malformed or anonymous-flow codes are refused; the account's own bucket limits starts", async () => {
    expect((await redeem("ABCD-EFGH-JKMN-PQRS")).status).toBe(404);
    expect((await redeem("ABCD-EFGH")).status).toBe(400);
    const user = "inst-2";
    const cookie = await cookieFor(user);
    const { code } = await jsonOf(await startSigned(cookie));
    // A signed code can't be approved through the 8-character flow or waited on like an anonymous one.
    const ap = await api("/api/pair/approve", await cookieFor("inst-other"), { method: "POST", body: { code } });
    expect(ap.status).toBe(400);
    const w = await connect(`/api/pair/wait?code=${code}&pairing_id=abcdefghijklmnop`, { authorization: "Bearer abcdefghijklmnopqrstuvwxyz" });
    expect(w).toBe(404);
    // Free plan: 5 starts at once (persisted bucket), then 429 with a clear text.
    let last429: Response | null = null;
    for (let i = 0; i < 6 && !last429; i++) {
      const r = await startSigned(cookie);
      if (r.status === 429) last429 = r;
    }
    expect(last429).not.toBeNull();
    expect((await jsonOf(last429!)).error).toMatch(/^too many install commands for this account; try again in/);
  });

  it("an invited (Registry-admitted) account's computer is accepted even before any phone of it connected", async () => {
    const tid = "g-invitedfirstpair";
    const cookie = `__Host-mr_session=${await makeSessionCookieValue(E.SESSION_SECRET, { tid, email: "invited.first@example.com", adm: "reg" })}`;
    const { code } = await jsonOf(await startSigned(cookie));
    const pr = await jsonOf(await redeem(code));
    // Not on ALLOWED_EMAILS and OPEN_SIGNUP is false: only the adm claim handed over with the pairing lets it in.
    const d = await connect("/api/daemon/ws", { authorization: `Bearer ${pr.token}` });
    expect(typeof d).not.toBe("number");
    if (typeof d !== "number") {
      await waitFor(() => last(d, "welcome"), "welcome");
      d.ws.close();
    }
  });

  it("the machine cap applies when the code is redeemed", async () => {
    const user = "inst-cap";
    const cookie = await cookieFor(user);
    const { code } = await jsonOf(await startSigned(cookie));
    await withHub(user, (hub) => {
      hub.wake(Date.now());
      hub.limits = { ...hub.limits, max_machines: 0 };
    });
    const r = await redeem(code);
    expect(r.status).toBe(409);
    expect((await jsonOf(r)).error).toMatch(/already has 0 computers/);
  });
});
