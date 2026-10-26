// Phase 3: free-tier budget, per-tenant limits (D10), usage accounting and unauthenticated abuse
// protection. Pure parts use explicit timestamps (no real clock); the rest runs inside workerd.
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantIdForDev } from "../src/auth";
import {
  FREE_PLAN,
  PLANS,
  dailyBudget,
  formatRate,
  isOwnerEmail,
  limitsFor,
  pairStartGlobalPerHour,
  parseRate,
  publicLimits,
  resolvePlan,
} from "../src/budget";
import type { Env } from "../src/env";
import { Limiter, fullAt, take } from "../src/ratelimit";
import { checkPairStart, clientKey, perShard, resetIsolateThrottles, shardOf } from "../src/throttle";
import { GC_BATCH } from "../src/hub";
import { UsageMeter, msUntilUtcMidnight, utcDay } from "../src/usage";
import { E, ORIGIN, connect, cookieFor, daemon, last, newMachine, phone, relaxLimits, setLimits, sleep, waitFor, withHub } from "./helpers";

const MIN = 60_000;
const r = (s: string) => parseRate(s)!;

describe("token buckets (pure, explicit time)", () => {
  it("starts full, refills continuously and reports the wait", () => {
    const rate = r("3,6/min"); // one token every 10 s
    let b = take(undefined, rate, 0);
    expect(b.ok).toBe(true);
    b = take(b.bucket, rate, 0);
    b = take(b.bucket, rate, 0);
    expect(b.ok).toBe(true);
    const no = take(b.bucket, rate, 0);
    expect(no.ok).toBe(false);
    expect(no.retryAfterMs).toBe(10_000);
    expect(take(no.bucket, rate, 4_000).retryAfterMs).toBe(6_000);
    const yes = take(no.bucket, rate, 10_000);
    expect(yes.ok).toBe(true);
    // Never more than the burst, however long it was idle.
    const idle = take(yes.bucket, rate, 10 * 3600_000);
    expect(idle.bucket.t).toBe(2);
    expect(fullAt({ t: 0, at: 0 }, rate)).toBe(30_000);
  });

  it("Limiter snapshots only non-full buckets and restores them", () => {
    const rates = { a: r("2,1/min"), b: r("5,5/min") };
    const l = new Limiter(rates);
    l.take("a", 1000);
    l.take("a", 1000);
    expect(l.take("a", 1000).ok).toBe(false);
    l.take("b", 1000);
    const snap = l.snapshot(1000 + MIN); // b refilled by then: dropped
    expect(Object.keys(snap)).toEqual(["a"]);
    const l2 = new Limiter(rates);
    l2.restore(snap);
    expect(l2.take("a", 1000 + MIN).ok).toBe(true);
    expect(l2.take("a", 1000 + MIN).ok).toBe(false);
    l2.restore({ zzz: [1, 2], a: ["x" as never, 1] });
    expect(l2.snapshot(0)).toEqual({});
  });

  it("parses rates and env overrides; bad values fall back to the defaults", () => {
    expect(parseRate("10,20/min")).toEqual({ burst: 10, per: 20, perMs: MIN });
    expect(parseRate(" 5 , 0.5 / h ")).toEqual({ burst: 5, per: 0.5, perMs: 3600_000 });
    for (const bad of ["", "10", "0,1/min", "1,0/min", "1,1/fortnight", "a,b/min"]) expect(parseRate(bad)).toBeNull();
    expect(formatRate(r("5,10/h"))).toBe("5,10/h");
    const l = limitsFor("free", { LIMIT_PHONE_SEND: "3,1/s", LIMIT_LAUNCH: "nonsense", DAILY_MESSAGE_CAP: "42" });
    expect(l.phone_send).toEqual({ burst: 3, per: 1, perMs: 1000 });
    expect(l.launch).toEqual(PLANS.free!.launch);
    expect(l.daily_messages).toBe(42);
    expect(limitsFor("no-such-plan", {}).daily_messages).toBe(PLANS.free!.daily_messages);
    expect(limitsFor(null, { DAILY_MESSAGE_CAP: "-1" }).daily_messages).toBe(PLANS.free!.daily_messages);
    expect(publicLimits({ LIMIT_PAIR_START_IP: "1,1/day" }).pair_start_ip).toEqual({ burst: 1, per: 1, perMs: 86_400_000 });
  });

  it("derives each plan's daily budget from the free-plan numbers (rate x 1440 is not the bound)", () => {
    expect(dailyBudget(10)).toEqual({
      do_requests: FREE_PLAN.doRequestsPerDay / 10,
      rows_read: FREE_PLAN.sqliteRowsReadPerDay / 10,
      rows_written: FREE_PLAN.sqliteRowsWrittenPerDay / 10,
    });
    const free = limitsFor("free", {});
    expect(free.daily_share_percent).toBe(10);
    expect(limitsFor("free", { TENANT_DAILY_SHARE_PERCENT: "5" }).daily.rows_written).toBe(FREE_PLAN.sqliteRowsWrittenPerDay / 20);
    expect(limitsFor("free", { TENANT_DAILY_SHARE_PERCENT: "250" }).daily_share_percent).toBe(10);
    const owner = limitsFor("owner", { LIMIT_PHONE_SEND: "1,1/h", OWNER_DAILY_SHARE_PERCENT: "30" });
    expect(owner.phone_send).toEqual(PLANS.owner!.phone_send); // free-plan overrides don't touch the owner
    expect(owner.daily_share_percent).toBe(30);
    expect(owner.daily_messages).toBeGreaterThan(free.daily_messages);
    expect(isOwnerEmail("BOSS@dev.local", { OWNER_EMAILS: "a@b.c, boss@dev.local" })).toBe(true);
    expect(isOwnerEmail("", { OWNER_EMAILS: "," })).toBe(false);
    expect(resolvePlan("free", "boss@dev.local", { OWNER_EMAILS: "boss@dev.local" })).toBe("owner");
    expect(resolvePlan("owner", null, {})).toBe("owner");
    expect(resolvePlan("platinum", null, {})).toBe("free");
  });

  it("keys clients by IPv4 address and IPv6 /64, and spreads keys over shards", () => {
    const req = (ip?: string) => new Request("https://x/", ip ? { headers: { "cf-connecting-ip": ip } } : {});
    expect(clientKey(req("203.0.113.7"))).toBe("ip:203.0.113.7");
    expect(clientKey(req("::ffff:203.0.113.7"))).toBe("ip:203.0.113.7");
    expect(clientKey(req("2001:db8:1:2::1"))).toBe("ip6:2001:db8:1:2::/64");
    expect(clientKey(req("2001:0db8:0001:0002:ffff:0:0:9"))).toBe("ip6:2001:db8:1:2::/64");
    expect(clientKey(req("2001:db8::1"))).toBe("ip6:2001:db8:0:0::/64");
    expect(clientKey(req())).toBe("ip:unknown");
    expect(clientKey(req("<script>"))).toBe("ip:invalid");
    expect(shardOf("ip:203.0.113.7")).toBe(shardOf("ip:203.0.113.7"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => shardOf(`ip:10.0.0.${i}`)));
    expect(seen.size).toBe(4);
    expect(perShard(r("20,52/h"))).toEqual({ burst: 5, per: 13, perMs: 3600_000 });
  });

  it("UTC day helpers", () => {
    const t = Date.UTC(2026, 9, 26, 23, 59, 0);
    expect(utcDay(t)).toBe("2026-10-26");
    expect(msUntilUtcMidnight(t)).toBe(60_000);
  });
});

describe("usage meter", () => {
  /** A SqlStorage that counts statements, to prove the hot path runs none. */
  function counting(sql: SqlStorage): { sql: SqlStorage; calls: () => number } {
    let n = 0;
    const wrapped = {
      exec: (q: string, ...args: unknown[]) => {
        n++;
        return sql.exec(q, ...(args as never[]));
      },
    };
    return { sql: wrapped as unknown as SqlStorage, calls: () => n };
  }

  it("counts in memory and writes one row per 50 events (amortized)", async () => {
    await withHub("meter-a", (_hub, state) => {
      const c = counting(state.storage.sql);
      const m = new UsageMeter(c.sql);
      const t = Date.UTC(2026, 9, 26, 12);
      m.load(t, null);
      expect(c.calls()).toBe(1);
      expect(m.lastRowsRead).toBeLessThanOrEqual(1);
      for (let i = 0; i < 49; i++) m.add(i % 2 ? "messages" : "requests", t);
      expect(c.calls()).toBe(1); // nothing written, nothing read
      m.add("launches", t);
      expect(c.calls()).toBe(2);
      expect(m.lastRowsWritten).toBeGreaterThanOrEqual(1);
      expect(m.lastRowsWritten).toBeLessThanOrEqual(2);
      expect(m.today(t)).toMatchObject({ day: "2026-10-26", messages: 24, requests: 25, launches: 1 });
      const row = state.storage.sql.exec<{ messages: number }>("SELECT messages FROM usage WHERE day = '2026-10-26'").one();
      expect(row.messages).toBe(24);
    });
  });

  it("restores unflushed counts from the newest snapshot, never counting a stale one twice", async () => {
    await withHub("meter-b", (_hub, state) => {
      const sql = state.storage.sql;
      const t = Date.UTC(2026, 9, 26, 12);
      const m1 = new UsageMeter(sql);
      m1.load(t, null);
      for (let i = 0; i < 5; i++) m1.add("messages", t);
      const older = m1.snapshot();
      m1.add("messages", t);
      m1.add("messages", t);
      const newer = m1.snapshot();
      expect(newer.g).toBeGreaterThan(older.g);
      expect(newer.u?.m).toBe(7);

      // Hibernation before any flush: the newest snapshot brings the 7 back.
      const m2 = new UsageMeter(sql);
      m2.load(t, newer);
      expect(m2.today(t).messages).toBe(7);
      m2.flush();
      // After the flush every snapshot handed out so far is stale: none of them adds anything.
      for (const snap of [older, newer]) {
        const m3 = new UsageMeter(sql);
        m3.load(t, snap);
        expect(m3.today(t).messages).toBe(7);
      }
      // A snapshot newer than the flush carries only what came after it.
      m2.add("messages", t);
      const after = m2.snapshot();
      const m4 = new UsageMeter(sql);
      m4.load(t, after);
      expect(m4.today(t).messages).toBe(8);
    });
  });

  it("rolls over at 00:00 UTC, writing the old day's counts to that day", async () => {
    await withHub("meter-c", (_hub, state) => {
      const sql = state.storage.sql;
      const d1 = Date.UTC(2026, 9, 26, 23, 59);
      const d2 = Date.UTC(2026, 9, 27, 0, 1);
      const m = new UsageMeter(sql);
      m.load(d1, null);
      m.add("messages", d1, 3);
      m.add("messages", d2);
      expect(m.today(d2)).toMatchObject({ day: "2026-10-27", messages: 1 });
      const rows = sql.exec<{ day: string; messages: number }>("SELECT day, messages FROM usage ORDER BY day").toArray();
      expect(rows).toEqual([{ day: "2026-10-26", messages: 3 }]);
      // A snapshot from before midnight restored after it goes to its own day.
      const m2 = new UsageMeter(sql);
      m2.load(d2, { g: 1e6, u: { d: "2026-10-25", m: 2, l: 0, r: 0 } });
      expect(sql.exec<{ messages: number }>("SELECT messages FROM usage WHERE day = '2026-10-25'").one().messages).toBe(2);
      expect(m.history(d2, 3).map((x) => x.day)).toEqual(["2026-10-27", "2026-10-26", "2026-10-25"]);
    });
  });
});

describe("per-tenant limits in the Hub (D10)", () => {
  async function setup(user: string) {
    const { token } = await newMachine(user);
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: `${user}-s`, project: "p" }] });
    const p = await phone(user);
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    return { d, p, sid: `${user}-s` };
  }

  it("rate limits phone sends with a clear error, keeps limits across hibernation", async () => {
    const { p, sid } = await setup("rl-phone");
    for (let i = 0; i < 10; i++) p.send({ t: "send", session_id: sid, text: `m${i}`, client_id: `c${i}` });
    p.send({ t: "send", session_id: sid, text: "too many", client_id: "c10" });
    const e = await waitFor(() => p.frames.find((f) => f.t === "error" && f.client_id === "c10"), "rate limit error");
    expect(e.error).toMatch(/^rate limited: too many messages; try again in \d+s$/);
    expect(e.retry_after_s).toBeGreaterThan(0);
    expect(p.frames.filter((f) => f.t === "message").length).toBe(10);
    // The buckets live in the socket attachment: an evicted Hub wakes up still limited.
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("rl-phone"))));
    p.send({ t: "send", session_id: sid, text: "after eviction", client_id: "c11" });
    const e2 = await waitFor(() => p.frames.find((f) => f.t === "error" && f.client_id === "c11"), "still limited");
    expect(e2.error).toMatch(/rate limited/);
  });

  it("rate limits agent send_message per tenant and names the limit", async () => {
    const { d, sid } = await setup("rl-agent");
    for (let i = 0; i < 11; i++) d.send({ t: "send", req_id: `r${i}`, session_id: sid, text: `n${i}`, urgency: "normal" });
    const e = await waitFor(() => d.frames.find((f) => f.t === "error" && f.req_id === "r10"), "agent rate limit");
    expect(e.error).toMatch(/^rate limited: too many messages from your sessions \(20 per minute\); try again in \d+s$/);
    expect(d.frames.filter((f) => f.t === "sent").length).toBe(10);
  });

  it("enforces the daily message cap for phone and agent, and shows usage", async () => {
    const { d, p, sid } = await setup("rl-cap");
    await setLimits("rl-cap", { daily_messages: 3 });
    p.send({ t: "send", session_id: sid, text: "one", client_id: "a" });
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "two", urgency: "normal" });
    p.send({ t: "send", session_id: sid, text: "three", client_id: "b" });
    await waitFor(() => p.frames.filter((f) => f.t === "message").length === 3, "3 messages");
    p.send({ t: "send", session_id: sid, text: "four", client_id: "c" });
    const pe = await waitFor(() => p.frames.find((f) => f.t === "error" && f.client_id === "c"), "phone cap");
    expect(pe.error).toMatch(/^daily message limit reached \(3 messages per day on the "free" plan, phone and agent together\); it resets at 00:00 UTC, in /);
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "five", urgency: "urgent" });
    const de = await waitFor(() => d.frames.find((f) => f.t === "error" && f.req_id === "r2"), "agent cap");
    expect(de.error).toMatch(/daily message limit reached/);
    p.send({ t: "refresh" });
    const st = await waitFor(() => [...p.frames].reverse().find((f) => f.t === "state" && f.usage?.messages === 3), "usage");
    expect(st.usage).toMatchObject({ plan: "free", day: utcDay(Date.now()), messages: 3, message_cap: 3 });
    expect(st.usage.frames).toBeGreaterThan(5);
    expect(st.usage.rows_written).toBeGreaterThan(0);
    expect(st.usage.blocked).toBeNull();
  });

  it("rate limits launch requests and history fetches", async () => {
    const { p, sid } = await setup("rl-launch");
    for (let i = 0; i < 21; i++) p.send({ t: "launch_stop", machine_id: "nope", launch_id: "mr-000000000000", client_id: `l${i}` });
    const lr = await waitFor(() => p.frames.find((f) => f.t === "launch_result" && f.client_id === "l20"), "launch rl");
    expect(lr).toMatchObject({ ok: false });
    expect(lr.error).toMatch(/^rate limited: too many start\/stop requests; try again in \d+s$/);
    expect(p.frames.find((f) => f.t === "launch_result" && f.client_id === "l19").error).toBe("unknown computer");
    for (let i = 0; i < 21; i++) p.send({ t: "history", session_id: sid });
    const he = await waitFor(() => p.frames.find((f) => f.t === "error" && /history/.test(f.error)), "history rl");
    expect(he.error).toMatch(/^rate limited: too many history requests; try again in \d+s$/);
    expect(p.frames.filter((f) => f.t === "history").length).toBe(20);
  });

  it("disconnects a flooding phone or daemon with 4029 and a retry hint", async () => {
    const { d, p } = await setup("rl-flood");
    await setLimits("rl-flood", { phone_frames: r("3,1/min"), daemon_frames: r("2,1/min") });
    for (let i = 0; i < 4; i++) p.send({ t: "refresh" });
    await waitFor(() => p.closed, "phone closed");
    expect(p.closed!.code).toBe(4029);
    expect(p.closed!.reason).toMatch(/retry in \d+s/);
    for (let i = 0; i < 3; i++) d.send({ t: "session_down", session_id: "x" });
    await waitFor(() => d.closed, "daemon closed");
    expect(d.closed!.code).toBe(4029);
  });

  it("limits WebSocket connects: phones get close 4029, daemons HTTP 429 + Retry-After", async () => {
    const { token } = await newMachine("rl-conn");
    await setLimits("rl-conn", { connects: r("2,1/min") });
    await phone("rl-conn");
    await daemon(token);
    const third = await phone("rl-conn");
    await waitFor(() => third.closed, "third closed");
    expect(third.closed).toMatchObject({ code: 4029 });
    expect(third.closed!.reason).toMatch(/too many connections; retry in \d+s/);
    const res = await SELF.fetch(`${ORIGIN}/api/daemon/ws`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts usage, survives eviction without a flush, flushes on close, never double counts", async () => {
    const { d, p, sid } = await setup("usage-a");
    for (let i = 0; i < 3; i++) p.send({ t: "send", session_id: sid, text: `u${i}`, client_id: `u${i}` });
    await waitFor(() => p.frames.filter((f) => f.t === "message").length === 3, "3 msgs");
    const rows = () => withHub("usage-a", (_h, s) => s.storage.sql.exec<{ messages: number }>("SELECT messages FROM usage").toArray());
    expect((await rows())[0]?.messages ?? 0).toBe(0); // the 3 messages are not written yet (fewer than 50 events)
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("usage-a"))));
    p.send({ t: "refresh" });
    await waitFor(() => [...p.frames].reverse().find((f) => f.t === "state")?.usage?.messages === 3, "usage restored");
    d.ws.close(1000, "bye");
    await waitFor(async () => (await rows())[0]?.messages === 3, "flushed on close");
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("usage-a"))));
    p.frames.length = 0;
    p.send({ t: "refresh" });
    const st = await waitFor(() => last(p, "state"), "state");
    expect(st.usage.messages).toBe(3);
    const u = await (await SELF.fetch(`${ORIGIN}/api/usage`, { headers: { cookie: await cookieFor("usage-a") } })).json<any>();
    expect(u).toMatchObject({ plan: "free", message_cap: 500 });
    expect(u.days[0]).toMatchObject({ day: utcDay(Date.now()), messages: 3 });
  });

  it("adds no SQL to the per-message hot path (limits and usage are in memory)", async () => {
    const { d, p, sid } = await setup("hot-path");
    // Record every statement the Hub runs from here on.
    const seen: string[] = [];
    await withHub("hot-path", (hub) => {
      const real = hub.sql;
      const spy = { exec: (q: string, ...a: unknown[]) => (seen.push(q.replace(/\s+/g, " ").trim()), real.exec(q, ...a)) };
      hub.sql = spy;
      hub.meter.sql = spy;
    });
    p.send({ t: "send", session_id: sid, text: "hot", client_id: "h1" });
    await waitFor(() => p.frames.find((f) => f.t === "message" && f.client_id === "h1"), "phone message");
    const phoneSend = seen.splice(0);
    d.send({ t: "send", req_id: "h2", session_id: sid, text: "hot back", urgency: "normal" });
    await waitFor(() => d.frames.find((f) => f.t === "sent" && f.req_id === "h2"), "agent message");
    const agentSend = seen.splice(0);
    // Exactly what Phase 1/2 already did: session lookup, machine check, insert, session counter.
    expect(phoneSend.map((q) => q.split(" ").slice(0, 3).join(" "))).toEqual([
      "SELECT * FROM",
      "SELECT COUNT(*) AS",
      "INSERT INTO messages",
      "UPDATE sessions SET",
    ]);
    expect(agentSend.map((q) => q.split(" ").slice(0, 3).join(" "))).toEqual([
      "SELECT COUNT(*) AS",
      "SELECT * FROM",
      "INSERT INTO messages",
      "UPDATE sessions SET",
    ]);
    expect([...phoneSend, ...agentSend].some((q) => /usage|meta/.test(q))).toBe(false);
  });

  it("refuses everything once a daily budget is used up, until 00:00 UTC, with a clear reason", async () => {
    const { d, p, sid } = await setup("budget-a");
    await withHub("budget-a", (hub) => {
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, rows_written: hub.meter.today(Date.now()).rows_written + 15 } };
    });
    // Each message writes a few rows: a handful exhausts the patched budget.
    for (let i = 0; i < 8; i++) p.send({ t: "send", session_id: sid, text: `b${i}`, client_id: `b${i}` });
    const e = await waitFor(() => p.frames.find((f) => f.t === "error" && /daily budget/.test(f.error)), "phone refused");
    expect(e.error).toMatch(
      /^this account's daily budget is used up \(database rows written: \d+ of \d+ per UTC day, 10% of the free plan's daily limit, "free" plan\); it resets at 00:00 UTC, in /,
    );
    expect(e.retry_after_s).toBeGreaterThan(0);
    // The daemon's next frame closes it with a hint until midnight.
    d.send({ t: "session_down", session_id: sid });
    await waitFor(() => d.closed, "daemon closed");
    expect(d.closed!.code).toBe(4029);
    expect(d.closed!.reason).toMatch(/^daily budget used up; retry in \d+s$/);
    const cookie = await cookieFor("budget-a");
    const st = await SELF.fetch(`${ORIGIN}/api/state`, { headers: { cookie } });
    expect(st.status).toBe(429);
    expect(((await st.json()) as { error: string }).error).toMatch(/^this account's daily budget is used up .* in \d+ (h|min|s)$/);
    p.send({ t: "launch", machine_id: "x", project_id: "p", continue: false, client_id: "L" });
    const lr = await waitFor(() => p.frames.find((f) => f.t === "launch_result" && f.client_id === "L"), "launch refused");
    expect(lr.error).toMatch(/daily budget is used up/);
    // A phone can still connect and sees why.
    const p2 = await phone("budget-a");
    const s2 = await waitFor(() => last(p2, "state"), "state");
    expect(s2.usage.blocked).toMatch(/daily budget is used up/);
  });

  it("counts frames, rows read and rows written, and stops a request flood at the daily request budget", async () => {
    const { d, p } = await setup("budget-b");
    await withHub("budget-b", (hub) => {
      const t = hub.meter.today(Date.now());
      const used = t.requests + Math.ceil(t.frames / 20);
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, do_requests: used + 3 } };
    });
    for (let i = 0; i < 80; i++) p.send({ t: "refresh" });
    await waitFor(() => p.frames.some((f) => f.t === "error" && /requests: \d+ of \d+/.test(f.error)), "request budget");
    const t = await withHub("budget-b", (hub) => hub.meter.today(Date.now()));
    expect(t.frames).toBeGreaterThan(60);
    expect(t.rows_read).toBeGreaterThan(0);
    void d;
  });

  it("writes nothing for repeated session_up / session_down (flapping costs only real changes)", async () => {
    const { d, sid } = await setup("flap");
    const written = () => withHub("flap", (hub) => hub.meter.today(Date.now()).rows_written as number);
    const settle = async () => {
      d.send({ t: "launches", launches: [] }); // a cheap frame so the Hub settles the previous one's rows
      await sleep(50);
    };
    await settle();
    let before = await written();
    for (let i = 0; i < 10; i++) d.send({ t: "session_up", session: { session_id: sid, project: "p" } });
    await settle();
    expect((await written()) - before).toBe(0);
    d.send({ t: "session_down", session_id: sid });
    await settle();
    before = await written();
    for (let i = 0; i < 10; i++) d.send({ t: "session_down", session_id: sid });
    await settle();
    expect((await written()) - before).toBe(0);
    // A real up/down pair: one row each.
    before = await written();
    d.send({ t: "session_up", session: { session_id: sid, project: "p" } });
    d.send({ t: "session_down", session_id: sid });
    await settle();
    expect((await written()) - before).toBeLessThanOrEqual(4);
    // A reconnect hello with the same sessions rewrites nothing for sessions still online.
    d.send({ t: "session_up", session: { session_id: sid, project: "p" } });
    await settle();
    before = await written();
    d.send({ t: "hello", v: 1, sessions: [{ session_id: sid, project: "p" }] });
    await settle();
    expect((await written()) - before).toBe(0);
  });

  it("with no open socket, allowed calls write their counts; refusals at most once per 10 s", async () => {
    const cookie = await cookieFor("nosock");
    await withHub("nosock", () => {});
    await setLimits("nosock", { http: r("2,1/min") });
    const stmts: string[] = [];
    await withHub("nosock", (hub) => {
      const real = hub.sql;
      const spy = { exec: (q: string, ...a: unknown[]) => (stmts.push(q), real.exec(q, ...a)) };
      hub.sql = spy;
      hub.meter.sql = spy;
    });
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await SELF.fetch(`${ORIGIN}/api/machines`, { headers: { cookie } })).status);
    expect(statuses.filter((x) => x === 429).length).toBe(8);
    // 2 allowed calls -> 2 usage writes; the 8 refusals right after them (within 10 s of a write) -> none.
    expect(stmts.filter((q) => /INSERT INTO usage/.test(q)).length).toBe(2);
    expect(await withHub("nosock", (hub) => hub.meter.today(Date.now()).requests)).toBeGreaterThanOrEqual(10);
  });

  it("keeps limits when the socket holding the newest snapshot closes and the Hub is evicted", async () => {
    const user = "keep-rl";
    const { d, p: first, sid } = await setup(user);
    first.ws.close(1000, "bye"); // only the round's phone (and the daemon) are open below
    await sleep(50);
    let accepted = 0;
    for (let round = 0; round < 3; round++) {
      const p = await phone(user);
      await waitFor(() => last(p, "state"), "state");
      for (let i = 0; i < 12; i++) p.send({ t: "send", session_id: sid, text: "x", client_id: `${round}-${i}` });
      await waitFor(() => p.frames.filter((f) => (f.t === "error" || f.t === "message") && f.client_id?.startsWith(`${round}-`)).length >= 12, "replies");
      accepted += p.frames.filter((f) => f.t === "message" && f.client_id?.startsWith(`${round}-`)).length;
      p.ws.close(1000, "bye");
      await sleep(100);
      await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev(user))));
    }
    expect(accepted).toBeLessThanOrEqual(12); // burst 10 + a little refill, not 3 x 10
    // And with no socket left at all: the buckets are written to meta at the last close.
    d.ws.close(1000, "bye");
    await sleep(100);
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev(user))));
    const snap = await withHub(user, (_h, st) => st.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'rl_snap'").toArray()[0]?.v);
    expect(JSON.parse(snap!).b.phone_send).toBeDefined();
    const p = await phone(user);
    p.send({ t: "send", session_id: sid, text: "x", client_id: "after" });
    const e = await waitFor(() => p.frames.find((f) => f.client_id === "after" && (f.t === "error" || f.t === "message")), "after");
    expect(e.t).toBe("error");
  });

  it("puts OWNER_EMAILS accounts on the owner plan (roomier, still budgeted)", async () => {
    const p = await phone("boss");
    const st = await waitFor(() => last(p, "state"), "state");
    expect(st.usage).toMatchObject({ plan: "owner", message_cap: PLANS.owner!.daily_messages });
    expect(st.usage.budget.share_percent).toBe(50);
    const q = await phone("not-boss");
    expect((await waitFor(() => last(q, "state"), "state")).usage.plan).toBe("free");
  });

  it("refused daemon credentials (401) never count toward the blocking budget (stolen-token lockout)", async () => {
    const u = "victim401";
    const { machineId, token } = await newMachine(u);
    const cookie = await cookieFor(u);
    expect((await SELF.fetch(`${ORIGIN}/api/machines/${machineId}`, { method: "DELETE", headers: { cookie, origin: ORIGIN } })).status).toBe(200);
    const before = await withHub(u, (hub) => {
      hub.wake(Date.now());
      hub.settleRows(Date.now());
      const t = hub.meter.today(Date.now());
      // A tiny request budget: 40 refused connects would blow it if they counted.
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, do_requests: t.requests + Math.ceil(t.frames / 20) + 10 } };
      return t;
    });
    for (let i = 0; i < 40; i++) expect(await connect("/api/daemon/ws", { authorization: `Bearer ${token}` })).toBe(401);
    const after = await withHub(u, (hub) => {
      hub.settleRows(Date.now());
      return hub.meter.today(Date.now());
    });
    expect(after.requests - before.requests).toBe(0);
    expect(after.rows_read - before.rows_read).toBe(0);
    // Separate counter; after the first refusal the Worker's isolate memory turns the token away without the Hub.
    expect(after.refused - before.refused).toBeGreaterThanOrEqual(1);
    expect(after.refused - before.refused).toBeLessThanOrEqual(40);
    expect((await SELF.fetch(`${ORIGIN}/api/state`, { headers: { cookie } })).status).toBe(200);
  });

  // --- review round 2 ---------------------------------------------------------------------------
  const today = (u: string) =>
    withHub(u, (hub) => {
      hub.wake(Date.now());
      hub.settleRows(Date.now());
      return hub.meter.today(Date.now());
    });
  const hubStub = (u: string) => E.HUB.get(E.HUB.idFromName(tenantIdForDev(u)));

  it("charges HTTP-only calls even when the Hub is evicted between every call", async () => {
    const u = "evict-http";
    const { d, p } = await setup(u);
    d.send({ t: "hello", v: 1, sessions: Array.from({ length: 50 }, (_, i) => ({ session_id: `s${i}`, project: "p" })) });
    await waitFor(() => last(p, "state")?.sessions.length === 50, "50 sessions");
    d.ws.close(1000);
    p.ws.close(1000);
    await sleep(200);
    const cookie = await cookieFor(u);
    await evictDurableObject(hubStub(u));
    const before = await today(u);
    await evictDurableObject(hubStub(u));
    for (let i = 0; i < 20; i++) {
      expect((await SELF.fetch(`${ORIGIN}/api/state`, { headers: { cookie } })).status).toBe(200);
      await evictDurableObject(hubStub(u));
    }
    const after = await today(u);
    expect(after.requests - before.requests).toBeGreaterThanOrEqual(20);
    expect(after.rows_read - before.rows_read).toBeGreaterThan(20 * 50); // each state read ~50 sessions
  });

  it("over budget, a phone connect reads no machines/sessions and closes write nothing", async () => {
    const u = "blocked-connect";
    const { d, p } = await setup(u);
    d.send({ t: "hello", v: 1, sessions: Array.from({ length: 50 }, (_, i) => ({ session_id: `b${i}`, project: "p" })) });
    await waitFor(() => last(p, "state")?.sessions.length === 50, "50");
    await withHub(u, (hub) => {
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, rows_read: 1 } };
    });
    p.ws.close(1000);
    d.ws.close(1000);
    await sleep(200);
    const before = await today(u);
    let stateful = 0;
    let refused = 0;
    for (let i = 0; i < 15; i++) {
      const q = await phone(u);
      await waitFor(() => last(q, "state") || q.closed, "state or close");
      const st = last(q, "state");
      if (st) {
        expect(st.sessions).toEqual([]);
        expect(st.machines).toEqual([]);
        expect(st.usage.blocked).toMatch(/daily budget is used up/);
        stateful++;
      } else {
        expect(q.closed).toMatchObject({ code: 4029 });
        expect(q.closed!.reason).toMatch(/^daily budget used up; retry in \d+s$/);
        refused++;
      }
      q.ws.close(1000);
    }
    await sleep(100);
    const after = await today(u);
    expect(stateful).toBe(PLANS.free!.blocked_connects.burst);
    expect(refused).toBe(15 - stateful);
    // At most the one write of the drained blocked-connect bucket (round 3), nothing per connect.
    expect(after.rows_written - before.rows_written).toBeLessThanOrEqual(2);
    expect(after.rows_read - before.rows_read).toBeLessThan(15 * 10); // no 50-session reads
  });

  it("caps computers per account (free: 10) with a clear refusal", async () => {
    const u = "many-machines";
    for (let i = 0; i < 10; i++) await newMachine(u, `box${i}`);
    const s = (await (
      await SELF.fetch(`${ORIGIN}/api/pair/start`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.33" },
        body: "{}",
      })
    ).json()) as { code: string };
    await setLimits(u, { pair_approve: r("100,100/min") });
    const res = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie: await cookieFor(u), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: s.code }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^this account already has 10 computers \(the "free" plan allows 10\); revoke one under Machines first/,
    );
    // Revoking one (without sessions) makes room.
    const cookie = await cookieFor(u);
    const list = (await (await SELF.fetch(`${ORIGIN}/api/machines`, { headers: { cookie } })).json()) as { machines: { machine_id: string }[] };
    expect((await SELF.fetch(`${ORIGIN}/api/machines/${list.machines[0]!.machine_id}`, { method: "DELETE", headers: { cookie, origin: ORIGIN } })).status).toBe(200);
    const ok = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: s.code }),
    });
    expect(ok.status).toBe(200);
  });

  it("a message round trip fits the daily budget many times over (rows written per message)", async () => {
    const u = "msg-cost";
    const { d, p, sid } = await setup(u);
    await relaxLimits(u);
    await sleep(50);
    const b = await today(u);
    const N = 50;
    for (let i = 0; i < N; i++) p.send({ t: "send", session_id: sid, text: `m${i}`, client_id: `c${i}` });
    await waitFor(() => p.frames.filter((f) => f.t === "message").length >= N, "msgs", 10_000);
    const ids = p.frames.filter((f) => f.t === "message").map((f) => f.message.id);
    d.send({ t: "ack", session_id: sid, ids });
    for (let i = 0; i < N; i++) d.send({ t: "send", req_id: `r${i}`, session_id: sid, text: `o${i}`, urgency: "normal" });
    await waitFor(() => d.frames.filter((f) => f.t === "sent").length >= N, "sent", 10_000);
    await sleep(100);
    const a = await today(u);
    const perMessage = (a.rows_written - b.rows_written) / (2 * N);
    expect(perMessage).toBeLessThan(10);
    // The free plan's 500 messages/day stay well inside its rows-written budget.
    expect(perMessage * PLANS.free!.daily_messages).toBeLessThan(limitsFor("free", {}).daily.rows_written / 2);
  });

  // --- review round 3 ---------------------------------------------------------------------------
  it("charges the usage row's own write even when the Hub is evicted right after every call", async () => {
    const u = "flush-charge";
    await newMachine(u);
    const cookie = await cookieFor(u);
    await SELF.fetch(`${ORIGIN}/api/usage`, { headers: { cookie } });
    await evictDurableObject(hubStub(u));
    const before = await today(u);
    await evictDurableObject(hubStub(u));
    for (let i = 0; i < 20; i++) {
      expect((await SELF.fetch(`${ORIGIN}/api/usage`, { headers: { cookie } })).status).toBe(200);
      // Nothing written by this call is left uncharged in memory.
      expect(await withHub(u, (hub) => hub.cursors.reduce((n: number, c: { rowsWritten: number }) => n + c.rowsWritten, 0))).toBe(0);
      await evictDurableObject(hubStub(u));
    }
    const after = await today(u);
    expect(after.rows_written - before.rows_written).toBeGreaterThanOrEqual(20); // one usage row per call
  });

  it("deletes removed sessions' history in bounded batches, never resurrecting it", async () => {
    const u = "gc-hist";
    const { machineId, token } = await newMachine(u);
    await withHub(u, (_hub, st) => {
      const sql = st.storage.sql;
      for (let s = 0; s < 50; s++) {
        sql.exec(
          "INSERT INTO sessions (session_id, machine_id, project, online, last_seen, created_at, msg_count) VALUES (?, ?, 'p', 0, ?, ?, 200)",
          `old${s}`,
          machineId,
          s,
          s,
        );
        for (let i = 0; i < 200; i++) sql.exec("INSERT INTO messages (session_id, direction, text, created_at, delivered) VALUES (?, 'out', 'x', ?, 1)", `old${s}`, i);
      }
    });
    await relaxLimits(u);
    const before = (await today(u)).rows_written;
    const d = await daemon(token);
    await waitFor(() => last(d, "welcome"), "welcome");
    // One hello announcing 50 new sessions evicts 50 old ones; their 10,000 messages must not go in one frame.
    d.send({ t: "hello", v: 1, sessions: Array.from({ length: 50 }, (_, i) => ({ session_id: `new${i}`, project: "p" })) });
    await sleep(300);
    const afterHello = (await today(u)).rows_written - before;
    expect(afterHello).toBeLessThan(1000);
    const left = () => withHub(u, (_h, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n);
    expect(await left()).toBeGreaterThan(9000);
    // History of a removed session is empty while its rows wait for cleanup.
    const p = await phone(u);
    p.send({ t: "history", session_id: "old7" });
    const h = await waitFor(() => p.frames.find((f) => f.t === "history" && f.session_id === "old7"), "history");
    expect(h.messages).toEqual([]);
    // Announcing a removed id again finishes its cleanup in that same event, then accepts it, empty.
    d.send({ t: "session_up", session: { session_id: "old0", project: "p" } });
    await waitFor(() => last(p, "state")?.sessions.some((x: { session_id: string; online: boolean }) => x.session_id === "old0" && x.online), "old0 back");
    expect(d.frames.find((f) => f.t === "error" && f.session_id === "old0")).toBeUndefined();
    expect(await withHub(u, (_h, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'old0'").one().n)).toBe(0);
    // Each further frame deletes at most GC_BATCH rows; eventually all are gone and daemons are told to resync.
    for (let i = 0; i < 150 && (await left()) > 0; i++) {
      const w0 = (await today(u)).rows_written;
      d.send({ t: "launches", launches: [] });
      await sleep(20);
      expect((await today(u)).rows_written - w0).toBeLessThanOrEqual(GC_BATCH + 20);
    }
    expect(await left()).toBe(0);
    // The ids were removed by this daemon's own eviction and nobody asked for them: no resync needed.
    expect(d.frames.some((f) => f.t === "resync")).toBe(false);
  }, 30_000);

  it("a fixed session id re-announced after Forget on an idle account is accepted at once (round 4)", async () => {
    const u = "gc-stable";
    const { machineId, token } = await newMachine(u);
    await withHub(u, (_hub, st) => {
      const sql = st.storage.sql;
      sql.exec("INSERT INTO sessions (session_id, machine_id, project, online, last_seen, created_at, msg_count) VALUES ('laptop-proj', ?, 'p', 0, 1, 1, 1000)", machineId);
      for (let i = 0; i < 1000; i++) sql.exec("INSERT INTO messages (session_id, direction, text, created_at, delivered) VALUES ('laptop-proj', 'out', 'x', ?, 1)", i);
    });
    const d = await daemon(token);
    await waitFor(() => last(d, "welcome"), "welcome");
    d.send({ t: "hello", v: 1, sessions: [] });
    const p = await phone(u);
    await waitFor(() => last(p, "state"), "state");
    p.send({ t: "forget_session", session_id: "laptop-proj" });
    await waitFor(() => !last(p, "state")?.sessions.some((x: { session_id: string }) => x.session_id === "laptop-proj"), "forgotten");
    d.send({ t: "session_up", session: { session_id: "laptop-proj", project: "p" } });
    await waitFor(() => last(p, "state")?.sessions.some((x: { session_id: string; online: boolean }) => x.session_id === "laptop-proj" && x.online), "back");
    expect(d.frames.find((f) => f.t === "error" && f.session_id === "laptop-proj")).toBeUndefined();
    expect(await withHub(u, (_h, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(0);
  });

  it("history cleanup stops at half of today's rows-written budget (it never blocks the account)", async () => {
    const u = "gc-half";
    const { machineId, token } = await newMachine(u);
    await withHub(u, (_hub, st) => {
      const sql = st.storage.sql;
      sql.exec("INSERT INTO sessions (session_id, machine_id, project, online, last_seen, created_at, msg_count) VALUES ('big', ?, 'p', 0, 1, 1, 600)", machineId);
      for (let i = 0; i < 600; i++) sql.exec("INSERT INTO messages (session_id, direction, text, created_at, delivered) VALUES ('big', 'out', 'x', ?, 1)", i);
    });
    const d = await daemon(token);
    await waitFor(() => last(d, "welcome"), "welcome");
    const p = await phone(u);
    await waitFor(() => last(p, "state"), "state");
    await withHub(u, (hub) => {
      hub.settleRows(Date.now());
      const w = hub.meter.today(Date.now()).rows_written;
      // Half of the budget is reached once ~250 more rows are written.
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, rows_written: 2 * (w + 250) } };
    });
    p.send({ t: "forget_session", session_id: "big" });
    for (let i = 0; i < 10; i++) {
      d.send({ t: "launches", launches: [] });
      await sleep(20);
    }
    const t = await withHub(u, (hub) => {
      hub.settleRows(Date.now());
      return { w: hub.meter.today(Date.now()).rows_written, budget: hub.limits.daily.rows_written, blocked: hub.overBudget(Date.now()) };
    });
    expect(t.blocked).toBeNull();
    expect(t.w).toBeLessThan(t.budget / 2 + GC_BATCH + 20);
    const left = await withHub(u, (_h, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n);
    expect(left).toBeGreaterThan(0); // paused, not finished
    d.send({ t: "session_up", session: { session_id: "big", project: "p" } });
    const e = await waitFor(() => d.frames.find((f) => f.t === "error" && f.session_id === "big"), "refused while paused");
    expect(e.error).toMatch(/deleting its history is paused for today \(daily budget\); it is retried automatically/);
  });

  it("sends at most one resync per daemon per event", async () => {
    const u = "resync-once";
    const a = await newMachine(u, "a");
    const b = await newMachine(u, "b");
    const da = await daemon(a.token);
    const db = await daemon(b.token);
    await waitFor(() => last(da, "welcome") && last(db, "welcome"), "welcome");
    await sleep(50);
    da.frames.length = 0;
    db.frames.length = 0;
    // Many "an id became free" moments in one event (K cleanups, revokes, ...): one resync each.
    await withHub(u, (hub) => {
      for (let i = 0; i < 5; i++) hub.resyncDaemons();
      hub.resyncDaemons(a.machineId);
      hub.saveSnap(undefined, Date.now()); // end of the event
    });
    await sleep(100);
    expect(db.frames.filter((f) => f.t === "resync").length).toBe(1);
    expect(da.frames.filter((f) => f.t === "resync").length).toBe(1); // only some requests skipped A
    // A request that skips A in every call of an event leaves A out.
    await withHub(u, (hub) => {
      hub.resyncDaemons(a.machineId);
      hub.resyncDaemons(a.machineId);
      hub.saveSnap(undefined, Date.now());
    });
    await sleep(100);
    expect(da.frames.filter((f) => f.t === "resync").length).toBe(1);
    expect(db.frames.filter((f) => f.t === "resync").length).toBe(2);
  });

  it("frames on a socket the Hub already closed are dropped before any work (client ignoring 4029)", async () => {
    const u = "ignore-close";
    const { p } = await setup(u);
    const r = await withHub(u, async (hub, st) => {
      const ws = st.getWebSockets("phone")[0]!;
      hub.shut(ws, 4029, "rate limited: too many requests; retry in 60s");
      const stmts: string[] = [];
      const real = hub.sql;
      hub.sql = { exec: (q: string, ...a: unknown[]) => (stmts.push(q), real.exec(q, ...a)) };
      const before = hub.meter.today(Date.now()).frames;
      for (let i = 0; i < 100; i++) await hub.webSocketMessage(ws, JSON.stringify({ t: "refresh" }));
      hub.sql = real;
      return { stmts: stmts.length, dropped: hub.droppedFrames, frames: hub.meter.today(Date.now()).frames - before };
    });
    expect(r).toEqual({ stmts: 0, dropped: 100, frames: 0 });
    void p;
  });

  it("re-checks the daily budget between sessions of one hello", async () => {
    const { d } = await setup("hello-budget");
    await withHub("hello-budget", (hub) => {
      hub.settleRows(Date.now());
      const w = hub.meter.today(Date.now()).rows_written;
      hub.limits = { ...hub.limits, daily: { ...hub.limits.daily, rows_written: w + 5 } };
    });
    d.send({ t: "hello", v: 1, sessions: Array.from({ length: 20 }, (_, i) => ({ session_id: `h${i}`, project: "p" })) });
    await waitFor(() => d.frames.some((f) => f.t === "error" && /refused for now: this account's daily budget is used up/.test(f.error)) || d.closed, "budget refusal");
    const added = await withHub("hello-budget", (_h, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE session_id LIKE 'h%'").one().n);
    expect(added).toBeLessThan(20);
  });

  it("keeps a blocked tenant's connect allowance across evictions (one write when drained)", async () => {
    const u = "blk-evict";
    await newMachine(u);
    const p0 = await phone(u);
    await waitFor(() => last(p0, "state"), "state");
    p0.ws.close(1000);
    await sleep(100);
    await withHub(u, (hub, st) => {
      hub.meter.flush();
      st.storage.sql.exec("INSERT INTO usage (day, requests) VALUES (?, 1000000) ON CONFLICT(day) DO UPDATE SET requests = 1000000", utcDay(Date.now()));
    });
    await evictDurableObject(hubStub(u));
    const rounds: number[] = [];
    for (let round = 0; round < 3; round++) {
      let ok = 0;
      for (let i = 0; i < 8; i++) {
        const q = await phone(u);
        await waitFor(() => last(q, "state") || q.closed, "state or close");
        if (last(q, "state")) ok++;
        q.ws.close(1000);
        await sleep(20);
      }
      rounds.push(ok);
      await sleep(100);
      await evictDurableObject(hubStub(u));
    }
    expect(rounds).toEqual([PLANS.free!.blocked_connects.burst, 0, 0]);
  });

  it("re-checks the computer cap in addMachine (concurrent approvals can't exceed it)", async () => {
    const u = "cap-race";
    const stub = hubStub(u);
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) => stub.addMachine(`race${i}`, `box${i}`, `hash${i}`, "x@dev.local")),
    );
    expect(results.filter((r) => !("error" in r)).length).toBe(PLANS.free!.max_machines);
    expect(results.find((r) => "error" in r)).toMatchObject({ error: expect.stringMatching(/allows 10/) });
  });

  it("rate limits the HTTP API per tenant with 429 + Retry-After", async () => {
    const cookie = await cookieFor("rl-http");
    await withHub("rl-http", () => {});
    await setLimits("rl-http", { http: r("3,1/min") });
    for (let i = 0; i < 3; i++) expect((await SELF.fetch(`${ORIGIN}/api/state`, { headers: { cookie } })).status).toBe(200);
    const res = await SELF.fetch(`${ORIGIN}/api/state`, { headers: { cookie } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await res.json()) as { error: string }).error).toMatch(/^too many requests for this account; try again in \d+s$/);
  });

  it("keeps tenants' limits and usage apart (D9)", async () => {
    const a = await setup("iso-a");
    const b = await setup("iso-b");
    for (let i = 0; i < 11; i++) a.p.send({ t: "send", session_id: a.sid, text: `a${i}`, client_id: `a${i}` });
    await waitFor(() => a.p.frames.find((f) => f.t === "error" && f.client_id === "a10"), "a limited");
    b.p.send({ t: "send", session_id: b.sid, text: "b ok", client_id: "b0" });
    await waitFor(() => b.p.frames.find((f) => f.t === "message" && f.client_id === "b0"), "b unaffected");
    b.p.send({ t: "refresh" });
    const st = await waitFor(() => [...b.p.frames].reverse().find((f) => f.t === "state" && f.usage?.messages === 1), "b usage");
    expect(st.usage.messages).toBe(1);
  });
});

describe("pairing abuse protection", () => {
  const start = (ip: string, body = "{}", headers: Record<string, string> = {}) =>
    SELF.fetch(`${ORIGIN}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers },
      body,
    });

  it("throttles /api/pair/start per IP (IPv6 by /64) with a clear 429", async () => {
    for (let i = 0; i < 5; i++) expect((await start("203.0.113.7")).status).toBe(200);
    const no = await start("203.0.113.7");
    expect(no.status).toBe(429);
    expect(Number(no.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await no.json()) as { error: string }).error).toMatch(/^too many pairing attempts from your network; try again in \d+ min$/);
    // Remembered in isolate memory too: still refused.
    expect((await start("203.0.113.7")).status).toBe(429);
    expect((await start("203.0.113.8")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await start(i % 2 ? "2001:db8:7:7::1" : "2001:db8:7:7:abcd::2")).status).toBe(200);
    expect((await start("2001:db8:7:7::99")).status).toBe(429);
    expect((await start("2001:db8:7:8::1")).status).toBe(200);
  });

  it("also caps a whole IPv6 /48 (rotating through /64s doesn't help)", async () => {
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      const res = await start(`2001:db8:48:${(i + 1).toString(16)}::1`);
      if (res.status === 200) ok++;
      else expect(res.status).toBe(429);
    }
    expect(ok).toBe(15);
    expect((await start("2001:db8:49:1::1")).status).toBe(200);
  });

  it("charges nothing for a refused check and caps everyone together per shard", async () => {
    const stub = E.THROTTLE.get(E.THROTTLE.idFromName("test-shard"));
    const one = { burst: 1, per: 1, perMs: 3600_000 };
    const two = { burst: 2, per: 1, perMs: 3600_000 };
    const ok = await stub.hit([{ key: "ip:a", rate: two }, { key: "*", rate: one }], 1000);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.rowsWritten).toBeGreaterThan(0);
    // The shared bucket is empty now: refused, and ip:a keeps its remaining token.
    const no = await stub.hit([{ key: "ip:b", rate: two }, { key: "*", rate: one }], 1000);
    expect(no).toMatchObject({ ok: false, rowsWritten: 0 });
    expect(no.retryAfterMs).toBe(3600_000);
    expect((await stub.hit([{ key: "ip:a", rate: two }], 1000)).ok).toBe(true);
    expect((await stub.hit([{ key: "ip:a", rate: two }], 1000)).ok).toBe(false);
    // Persisted: a fresh instance still knows.
    await evictDurableObject(stub);
    expect((await stub.hit([{ key: "ip:a", rate: two }], 1000)).ok).toBe(false);
  });

  it("derives the global pairing-start cap from the free plan and enforces it per shard", async () => {
    expect(pairStartGlobalPerHour()).toBe(52); // 10% of 100,000 rows/day / 8 rows per start / 24 h
    const defaults = publicLimits({});
    expect(defaults.pair_start_global).toEqual({ burst: 20, per: 52, perMs: 3600_000 });
    resetIsolateThrottles();
    // Distinct IPs that land in the same shard share that shard's 1/4 of the global burst (5).
    const target = shardOf("ip:192.0.2.0");
    const ips = Array.from({ length: 400 }, (_, i) => `192.0.2.${i % 250}`)
      .filter((ip, i, all) => all.indexOf(ip) === i)
      .filter((ip) => shardOf(`ip:${ip}`) === target)
      .slice(0, 7);
    const results = [];
    // Its own Throttle objects, so the shared shards of the other tests aren't drained.
    const isolated = {
      THROTTLE: { idFromName: (n: string) => E.THROTTLE.idFromName(`derived-cap-test:${n}`), get: (id: DurableObjectId) => E.THROTTLE.get(id) },
    } as unknown as Env;
    for (const ip of ips) {
      const req = new Request("https://x/", { headers: { "cf-connecting-ip": ip } });
      results.push((await checkPairStart(isolated, req, defaults)).ok);
    }
    expect(results.filter(Boolean).length).toBe(5);
  });

  it("Throttle writes one row per charged key (no secondary index)", async () => {
    const stub = E.THROTTLE.get(E.THROTTLE.idFromName("cost-probe"));
    const rate = r("100,100/h");
    const x = await stub.hit([{ key: "ip:1", rate }, { key: "*", rate }, { key: "ip6:2001:db8:1::/48", rate }], 1000);
    expect(x.ok).toBe(true);
    expect(x.rowsWritten).toBeLessThanOrEqual(3);
  });

  it("client frames on a pairing wait socket never reach the Pairing DO (the Worker closes on the first)", async () => {
    const r0 = await SELF.fetch(`${ORIGIN}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
      body: "{}",
    });
    const s0 = (await r0.json()) as { code: string; pairing_id: string; poll_secret: string };
    const q = `?code=${s0.code}&pairing_id=${s0.pairing_id}`;
    const w = await connect(`/api/pair/wait${q}`, { authorization: `Bearer ${s0.poll_secret}` });
    if (typeof w === "number") throw new Error(`wait refused: ${w}`);
    await waitFor(() => w.frames.find((f) => f.t === "pending"), "pending");
    // Keepalive is answered by the Worker (at most one per 5 s), not by the DO.
    w.ws.send("ping");
    await sleep(100);
    for (let i = 0; i < 300; i++) {
      try {
        w.ws.send("claimed");
      } catch {
        break;
      }
    }
    await waitFor(() => w.closed, "closed");
    expect(w.closed!.code).toBe(1008);
    await sleep(300);
    const stub = E.PAIRING.get(E.PAIRING.idFromName(`pair:${s0.code.replace("-", "")}`));
    expect(await runInDurableObject(stub, (p: { framesHandled: number }) => p.framesHandled)).toBe(0);
    expect(await runInDurableObject(stub, (p: { storageReads: number }) => p.storageReads)).toBe(0);
    // A frame "claimed" never claims: the pairing is still there and can be approved and waited on.
    const w2 = await connect(`/api/pair/wait${q}`, { authorization: `Bearer ${s0.poll_secret}` });
    if (typeof w2 === "number") throw new Error(String(w2));
    await waitFor(() => w2.frames.find((f) => f.t === "pending"), "pending 2");
    // Claim before approval is refused (409), and still nothing reached webSocketMessage.
    const early = await SELF.fetch(`${ORIGIN}/api/pair/claim${q}`, { method: "POST", headers: { authorization: `Bearer ${s0.poll_secret}` } });
    expect(early.status).toBe(409);
    w2.ws.send("hello?");
    await waitFor(() => w2.closed, "closed 2");
    expect(w2.closed!.code).toBe(1008);
    expect(await runInDurableObject(stub, (p: { framesHandled: number }) => p.framesHandled)).toBe(0);
  });

  it("uses the optional Rate Limiting binding first when configured", async () => {
    let calls = 0;
    const env = {
      PAIR_START_RATE_LIMITER: { limit: async () => (calls++, { success: false }) },
    } as unknown as Env; // no THROTTLE: touching it would throw
    const r1 = await checkPairStart(env, new Request("https://x/", { headers: { "cf-connecting-ip": "192.0.2.1" } }), publicLimits({}));
    expect(r1).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect(calls).toBe(1);
  });

  it("rejects oversize and malformed bodies before waking any Durable Object", async () => {
    const big = JSON.stringify({ hostname: "x".repeat(5000) });
    expect((await start("198.51.100.1", big)).status).toBe(413);
    const chunked = new ReadableStream({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("x".repeat(1000)));
        c.close();
      },
    });
    const res = await SELF.fetch(`${ORIGIN}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.1" },
      body: chunked,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await start("198.51.100.1", "{not json")).status).toBe(400);
    expect((await start("198.51.100.1", "{}", { "content-type": "text/plain" })).status).toBe(415);
    // None of these used up the IP's pairing budget.
    for (let i = 0; i < 5; i++) expect((await start("198.51.100.1")).status).toBe(200);
    // /api/pair/wait without upgrade, with a junk id or a junk secret: refused at the Worker.
    expect((await SELF.fetch(`${ORIGIN}/api/pair/wait?code=ABCD-EFGH&pairing_id=${"a".repeat(22)}`)).status).toBe(426);
    expect(await connect(`/api/pair/wait?code=ABCD-EFGH&pairing_id=../../x`, { authorization: `Bearer ${"a".repeat(43)}` })).toBe(400);
    expect(await connect(`/api/pair/wait?code=ABCD-EFGH&pairing_id=${"a".repeat(22)}`, {})).toBe(400);
  });

  it("limits pairing approvals per tenant (persisted) before waking a Pairing DO", async () => {
    const cookie = await cookieFor("guesser");
    const approve = (code: string) =>
      SELF.fetch(`${ORIGIN}/api/pair/approve`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    for (let i = 0; i < 5; i++) expect((await approve(`ABCD-EFG${"HJKMN"[i]}`)).status).toBe(404);
    const no = await approve("ABCD-EFGP");
    expect(no.status).toBe(429);
    expect(no.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await no.json()) as { error: string }).error).toMatch(/^too many pairing approvals on this account; try again in \d+ min$/);
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("guesser"))));
    expect((await approve("ABCD-EFGQ")).status).toBe(429);
  });

  it("locks one pairing code after 5 approve attempts", async () => {
    const s = (await (await start("198.51.100.77")).json()) as { code: string };
    const approveAs = async (user: string) =>
      SELF.fetch(`${ORIGIN}/api/pair/approve`, {
        method: "POST",
        headers: { cookie: await cookieFor(user), origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ code: s.code }),
      });
    expect((await approveAs("lock-1")).status).toBe(200);
    for (let i = 2; i <= 5; i++) {
      const r2 = await approveAs(`lock-${i}`);
      expect(r2.status).toBe(404);
      expect(((await r2.json()) as { error: string }).error).toBe("code already used");
    }
    const locked = await approveAs("lock-6");
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: string }).error).toMatch(/too many approval attempts for this code; run `mcp-remote pair`/);
  });

  it("throttles /auth/login per IP without any Durable Object", async () => {
    const login = () => SELF.fetch(`${ORIGIN}/auth/login`, { redirect: "manual", headers: { "cf-connecting-ip": "198.51.100.200" } });
    for (let i = 0; i < 30; i++) expect((await login()).status).toBe(302);
    const no = await login();
    expect(no.status).toBe(429);
    expect(await no.text()).toMatch(/Too many sign-in attempts from your network/);
  });
});
