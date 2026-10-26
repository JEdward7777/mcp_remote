// Integration tests that run inside workerd via @cloudflare/vitest-plugin.
import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeSessionCookieValue, mintMachineToken, tenantIdForDev } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import { devAuthEnabled } from "../src/index";
import type { Env } from "../src/env";

import { E, ORIGIN, type Sock, connect, cookieFor, daemon, last, newMachine, phone, relaxLimits, sleep, waitFor } from "./helpers";

describe("dev auth", () => {
  it("is absent when DEV_AUTH is unset", async () => {
    const r = await SELF.fetch(`${ORIGIN}/auth/dev?user=alice`, { redirect: "manual" });
    expect(r.status).toBe(404);
    expect(r.headers.get("set-cookie")).toBeNull();
  });

  it("is only enabled by DEV_AUTH=1 and never on workers.dev", () => {
    const base = E as Env;
    expect(devAuthEnabled({ ...base, DEV_AUTH: "1" }, new URL("http://localhost:8787/auth/dev"))).toBe(true);
    expect(devAuthEnabled({ ...base, DEV_AUTH: "true" }, new URL("http://localhost:8787/auth/dev"))).toBe(false);
    expect(devAuthEnabled({ ...base, DEV_AUTH: undefined }, new URL("http://localhost:8787/auth/dev"))).toBe(false);
    expect(devAuthEnabled({ ...base, DEV_AUTH: "1" }, new URL("https://mcp-remote.me.workers.dev/auth/dev"))).toBe(false);
  });
});

describe("http api", () => {
  it("requires a session for /api/me and validates cookies", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/me`)).status).toBe(401);
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: "__Host-mr_session=v1.e30.bad" } })).status).toBe(401);
    const r = await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: await cookieFor("carol") } });
    expect(await r.json()).toMatchObject({ tenant: "dev-carol", email: "carol@dev.local" });
  });

  it("/auth/login redirects to Google with PKCE and sets a state cookie", async () => {
    const r = await SELF.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(r.headers.get("set-cookie")).toMatch(/__Host-mr_oauth=.*HttpOnly; Secure; SameSite=Lax/);
  });

  it("/auth/callback rejects a missing or mismatched state", async () => {
    const r = await SELF.fetch(`${ORIGIN}/auth/callback?code=x&state=y`, { redirect: "manual" });
    expect(r.status).toBe(400);
  });

  it("rejects cookie-authenticated mutations from another origin", async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie: await cookieFor("carol"), origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ code: "ABCD-EFGH" }),
    });
    expect(r.status).toBe(403);
    expect(await connect("/api/ws", { cookie: await cookieFor("carol"), origin: "https://evil.example" })).toBe(403);
    expect(await connect("/api/ws", { cookie: await cookieFor("carol") })).toBe(403);
  });
});

describe("pairing", () => {
  it("start -> approve -> wait delivers a working machine token, once", async () => {
    const start = await SELF.fetch(`${ORIGIN}/api/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostname: "dev-box" }),
    });
    const s = (await start.json()) as { code: string; pairing_id: string; poll_secret: string };
    expect(s.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Wrong poll secret cannot wait on (and steal) the token.
    const q = `?code=${s.code}&pairing_id=${s.pairing_id}`;
    // Malformed: refused by the Worker before any DO; well-formed but wrong: refused by the Pairing DO.
    expect(await connect(`/api/pair/wait${q}`, { authorization: "Bearer wrong" })).toBe(400);
    expect(await connect(`/api/pair/wait${q}`, { authorization: `Bearer ${"x".repeat(43)}` })).toBe(404);

    const waiter = await connect(`/api/pair/wait${q}`, { authorization: `Bearer ${s.poll_secret}` });
    if (typeof waiter === "number") throw new Error(String(waiter));
    await waitFor(() => waiter.frames.find((f) => f.t === "pending"), "pending");

    const cookie = await cookieFor("dave");
    const approve = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: s.code.toLowerCase().replace("-", " "), machine_name: "Dave's laptop" }),
    });
    expect(approve.status).toBe(200);
    const approved = await waitFor(() => waiter.frames.find((f) => f.t === "approved"), "approved");
    expect(approved).toMatchObject({ machine_name: "Dave's laptop", account: "dave@dev.local" });

    const again = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie: await cookieFor("eve"), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: s.code }),
    });
    expect(again.status).toBe(404);

    const d = await daemon(approved.token);
    await waitFor(() => d.frames.find((f) => f.t === "welcome"), "welcome");
    expect(last(d, "welcome").name).toBe("Dave's laptop");

    // Claiming (an authenticated POST) wipes the pending pairing and closes the wait socket.
    const claimUrl = `${ORIGIN}/api/pair/claim${q}`;
    expect((await SELF.fetch(claimUrl, { method: "POST", headers: { authorization: `Bearer ${"y".repeat(43)}` } })).status).toBe(404);
    expect((await SELF.fetch(claimUrl, { method: "POST", headers: { authorization: `Bearer ${s.poll_secret}` } })).status).toBe(200);
    await waitFor(() => waiter.closed, "pairing socket closed");
    expect(waiter.closed!.code).toBe(1000);
    expect(await connect(`/api/pair/wait${q}`, { authorization: `Bearer ${s.poll_secret}` })).toBe(404);
  });

  it("rejects malformed codes", async () => {
    const r = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie: await cookieFor("dave"), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: "IIII-OOOO" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("hub", () => {
  it("routes phone messages to the owning session and agent messages to phones", async () => {
    const { token } = await newMachine("frank");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "fa", project: "alpha" }, { session_id: "fb", project: "beta" }] });
    const p = await phone("frank");
    await waitFor(() => last(p, "state")?.sessions.filter((s: any) => s.online).length === 2, "two online sessions");

    p.send({ t: "send", session_id: "fb", text: "to b" });
    const del = await waitFor(() => d.frames.find((f) => f.t === "deliver"), "deliver");
    expect(del.session_id).toBe("fb");
    expect(del.messages[0]).toMatchObject({ text: "to b", direction: "in" });

    d.send({ t: "send", req_id: "r1", session_id: "fa", text: "done", urgency: "urgent" });
    const sent = await waitFor(() => d.frames.find((f) => f.t === "sent"), "sent");
    expect(sent.req_id).toBe("r1");
    const msg = await waitFor(() => p.frames.find((f) => f.t === "message" && f.message.direction === "out"), "out msg");
    expect(msg.message).toMatchObject({ session_id: "fa", urgency: "urgent", text: "done" });

    d.send({ t: "ack", session_id: "fb", ids: [del.messages[0].id] });
    await waitFor(() => p.frames.find((f) => f.t === "delivered"), "delivered");
  });

  it("rejects invalid and oversize frames", async () => {
    const p = await phone("gina");
    p.send({ t: "nope" });
    const e = await waitFor(() => p.frames.find((f) => f.t === "error"), "error");
    expect(e.error).toMatch(/invalid frame/);
    p.send("x".repeat(70 * 1024));
    const closed = await waitFor(() => p.closed, "close");
    expect(closed.code).toBe(1009);
  });

  it("does not let one machine claim another machine's session id", async () => {
    const a = await newMachine("hank", "a");
    const b = await newMachine("hank", "b");
    const da = await daemon(a.token);
    da.send({ t: "hello", v: 1, sessions: [{ session_id: "shared", project: "p" }] });
    await sleep(50);
    const db = await daemon(b.token);
    db.send({ t: "session_up", session: { session_id: "shared", project: "p" } });
    const e = await waitFor(() => db.frames.find((f) => f.t === "error"), "error");
    expect(e.error).toMatch(/already used by another computer/);
    expect(e.session_id).toBe("shared");
    db.send({ t: "send", req_id: "x", session_id: "shared", text: "spoof", urgency: "normal" });
    const e2 = await waitFor(() => db.frames.find((f) => f.t === "error" && f.req_id === "x"), "send error");
    expect(e2.error).toBe("unknown session");
  });

  it("stores messages for offline sessions and delivers them on session_up", async () => {
    const { token } = await newMachine("ivy");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "iv", project: "p" }] });
    const p = await phone("ivy");
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    d.send({ t: "session_down", session_id: "iv" });
    await waitFor(() => last(p, "state")?.sessions[0]?.online === false, "offline");
    p.send({ t: "send", session_id: "iv", text: "later" });
    await waitFor(() => last(p, "state") && p.frames.find((f) => f.t === "message"), "echo");
    await sleep(50);
    expect(d.frames.find((f) => f.t === "deliver")).toBeUndefined();
    d.send({ t: "session_up", session: { session_id: "iv", project: "p" } });
    const del = await waitFor(() => d.frames.find((f) => f.t === "deliver"), "deliver");
    expect(del.messages.map((m: any) => m.text)).toEqual(["later"]);
  });

  it("keeps routing after the Hub hibernates/evicts (attachments + tags survive)", async () => {
    const { token } = await newMachine("jack");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "jk", project: "p" }] });
    const p = await phone("jack");
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("jack"))));
    p.send({ t: "send", session_id: "jk", text: "after eviction" });
    const del = await waitFor(() => d.frames.find((f) => f.t === "deliver"), "deliver after eviction");
    expect(del.messages[0].text).toBe("after eviction");
  });

  it("revocation closes the daemon socket and blocks reconnects", async () => {
    const { machineId, token } = await newMachine("kim");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "km", project: "p" }] });
    await sleep(50);
    const r = await SELF.fetch(`${ORIGIN}/api/machines/${machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("kim"), origin: ORIGIN },
    });
    expect(r.status).toBe(200);
    const closed = await waitFor(() => d.closed, "daemon closed");
    expect(closed.code).toBe(4001);
    expect(await connect("/api/daemon/ws", { authorization: `Bearer ${token}` })).toBe(401);
    const list = (await (
      await SELF.fetch(`${ORIGIN}/api/machines`, { headers: { cookie: await cookieFor("kim") } })
    ).json()) as { machines: { machine_id: string; revoked: boolean }[] };
    expect(list.machines.find((m) => m.machine_id === machineId)?.revoked).toBe(true);
  });

  it("forgets offline sessions only", async () => {
    const { token } = await newMachine("nora");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "nf", project: "p" }] });
    const p = await phone("nora");
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    p.send({ t: "forget_session", session_id: "nf" });
    const e = await waitFor(() => p.frames.find((f) => f.t === "error"), "error");
    expect(e.error).toMatch(/online/);
    d.send({ t: "session_down", session_id: "nf" });
    await waitFor(() => last(p, "state")?.sessions[0]?.online === false, "offline");
    p.send({ t: "forget_session", session_id: "nf" });
    await waitFor(() => last(p, "state")?.sessions.length === 0, "forgotten");
  });

  it("keeps tenants apart", async () => {
    const { machineId, token } = await newMachine("leo");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "leo-s", project: "secret-project" }] });
    await sleep(50);
    const other = await phone("mia");
    await waitFor(() => last(other, "state"), "state");
    expect(last(other, "state")).toMatchObject({ machines: [], sessions: [] });
    other.send({ t: "send", session_id: "leo-s", text: "inject" });
    await waitFor(() => other.frames.find((f) => f.t === "error"), "error");
    await sleep(50);
    expect(d.frames.find((f) => f.t === "deliver")).toBeUndefined();
    const r = await SELF.fetch(`${ORIGIN}/api/machines/${machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("mia"), origin: ORIGIN },
    });
    expect(r.status).toBe(404);
  });
});

describe("frame budgets", () => {
  it("splits large pending backlogs into IPC-sized deliver frames", async () => {
    const { token } = await newMachine("olga");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "ob", project: "p" }] });
    const p = await phone("olga");
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    d.send({ t: "session_down", session_id: "ob" });
    await waitFor(() => last(p, "state")?.sessions[0]?.online === false, "offline");
    const big = "€".repeat(7000); // ~21 KB UTF-8 each
    for (let i = 0; i < 8; i++) p.send({ t: "send", session_id: "ob", text: `${i}${big}` });
    await waitFor(() => p.frames.filter((f) => f.t === "message").length === 8, "8 stored");
    d.send({ t: "session_up", session: { session_id: "ob", project: "p" } });
    const delivers = await waitFor(() => {
      const ds = d.frames.filter((f) => f.t === "deliver");
      return ds.reduce((n, f) => n + f.messages.length, 0) === 8 ? ds : null;
    }, "all delivered");
    expect(delivers.length).toBeGreaterThan(1);
    for (const f of delivers) expect(new TextEncoder().encode(JSON.stringify(f)).byteLength).toBeLessThan(64 * 1024);
    const order = delivers.flatMap((f) => f.messages.map((m: any) => Number(m.text[0])));
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("review round 1", () => {
  it("acks more than 100 queued messages (no SQL parameter overflow) in <=90-message frames", async () => {
    const { token } = await newMachine("pete");
    await relaxLimits("pete");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "pq", project: "p" }] });
    const p = await phone("pete");
    await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
    d.send({ t: "session_down", session_id: "pq" });
    await waitFor(() => last(p, "state")?.sessions[0]?.online === false, "offline");
    for (let i = 0; i < 150; i++) p.send({ t: "send", session_id: "pq", text: `m${i}` });
    await waitFor(() => p.frames.filter((f) => f.t === "message").length === 150, "150 stored", 10_000);
    d.send({ t: "session_up", session: { session_id: "pq", project: "p" } });
    const delivers = await waitFor(() => {
      const ds = d.frames.filter((f) => f.t === "deliver");
      return ds.reduce((n, f) => n + f.messages.length, 0) === 150 ? ds : null;
    }, "150 delivered");
    for (const f of delivers) expect(f.messages.length).toBeLessThanOrEqual(90);
    const ids = delivers.flatMap((f) => f.messages.map((m: any) => m.id));
    // One ack with every id (the protocol allows up to 500).
    d.send({ t: "ack", session_id: "pq", ids });
    await waitFor(() => p.frames.filter((f) => f.t === "delivered").reduce((n, f) => n + f.ids.length, 0) === 150, "all acked");
    p.send({ t: "refresh" });
    await sleep(50);
    expect(last(p, "state").sessions[0].pending_in).toBe(0);
    // Reconnect: nothing is redelivered.
    d.frames.length = 0;
    d.send({ t: "session_down", session_id: "pq" });
    d.send({ t: "session_up", session: { session_id: "pq", project: "p" } });
    await sleep(100);
    expect(d.frames.find((f) => f.t === "deliver")).toBeUndefined();
  });

  it("lets a re-paired machine take over a session id from a revoked machine, keeping history", async () => {
    const a = await newMachine("quin", "old");
    const da = await daemon(a.token);
    da.send({ t: "hello", v: 1, sessions: [{ session_id: "fixed-id", project: "p" }] });
    da.send({ t: "send", req_id: "r", session_id: "fixed-id", text: "old history", urgency: "normal" });
    await waitFor(() => da.frames.find((f) => f.t === "sent"), "sent");
    const rv = await SELF.fetch(`${ORIGIN}/api/machines/${a.machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("quin"), origin: ORIGIN },
    });
    expect(rv.status).toBe(200);
    const b = await newMachine("quin", "new");
    const db = await daemon(b.token);
    db.send({ t: "hello", v: 1, sessions: [{ session_id: "fixed-id", project: "p" }] });
    const p = await phone("quin");
    await waitFor(() => last(p, "state")?.sessions.find((s: any) => s.session_id === "fixed-id" && s.online && s.machine_id === b.machineId), "taken over");
    expect(db.frames.find((f) => f.t === "error")).toBeUndefined();
    p.send({ t: "history", session_id: "fixed-id" });
    const hist = await waitFor(() => p.frames.find((f) => f.t === "history"), "history");
    expect(hist.messages.map((m: any) => m.text)).toEqual(["old history"]);
  });

  it("rejects phone messages to sessions of a revoked machine", async () => {
    const a = await newMachine("rita");
    const d = await daemon(a.token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "rs", project: "p" }] });
    await sleep(50);
    await SELF.fetch(`${ORIGIN}/api/machines/${a.machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("rita"), origin: ORIGIN },
    });
    const p = await phone("rita");
    p.send({ t: "send", session_id: "rs", text: "hello?" });
    const e = await waitFor(() => p.frames.find((f) => f.t === "error"), "error");
    expect(e.error).toMatch(/revoked/);
    expect(p.frames.find((f) => f.t === "message")).toBeUndefined();
  });

  it("caps stored sessions per machine by evicting the oldest offline ones", async () => {
    const { token } = await newMachine("sam");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [] });
    for (let i = 0; i < 60; i++) {
      d.send({ t: "session_up", session: { session_id: `s${i}`, project: "p" } });
      d.send({ t: "session_down", session_id: `s${i}` });
    }
    const p = await phone("sam");
    await waitFor(
      () => last(p, "state")?.sessions.some((s: any) => s.session_id === "s59" && !s.online),
      "all 60 processed",
    );
    const ids = last(p, "state").sessions.map((s: any) => s.session_id);
    expect(ids.length).toBe(50);
    expect(ids).toContain("s59");
    expect(ids).not.toContain("s0");
  });

  it("re-checks ALLOWED_EMAILS for cookies and machine tokens", async () => {
    const mk = async (email: string) =>
      `__Host-mr_session=${await makeSessionCookieValue(E.SESSION_SECRET, { tid: "g-1001", email })}`;
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: await mk("allowed@example.com") } })).status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: await mk("removed@example.com") } })).status).toBe(401);
    const ok = await newMachine("x", "m", "g-2001", "allowed@example.com");
    expect(typeof (await connect("/api/daemon/ws", { authorization: `Bearer ${ok.token}` }))).toBe("object");
    const gone = await newMachine("x", "m", "g-2002", "removed@example.com");
    expect(await connect("/api/daemon/ws", { authorization: `Bearer ${gone.token}` })).toBe(403);
  });

  it("removes the machine of an approved pairing whose token is never claimed", async () => {
    const start = (await (
      await SELF.fetch(`${ORIGIN}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    ).json()) as { code: string };
    const cookie = await cookieFor("tina");
    const ap = await SELF.fetch(`${ORIGIN}/api/pair/approve`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ code: start.code }),
    });
    expect(ap.status).toBe(200);
    const list = async () =>
      ((await (await SELF.fetch(`${ORIGIN}/api/machines`, { headers: { cookie } })).json()) as { machines: unknown[] }).machines;
    expect((await list()).length).toBe(1);
    const stub = E.PAIRING.get(E.PAIRING.idFromName(`pair:${start.code.replace("-", "")}`));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await list()).length).toBe(0);
  });
});

describe("review round 2", () => {
  it("logout works from our origin (fetch and form) and refuses Origin: null", async () => {
    const cookie = await cookieFor("uma");
    const viaFetch = await SELF.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, accept: "application/json" },
    });
    expect(viaFetch.status).toBe(200);
    expect(viaFetch.headers.get("set-cookie")).toMatch(/__Host-mr_session=; Path=\/; Max-Age=0/);
    const viaForm = await SELF.fetch(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie, origin: ORIGIN }, redirect: "manual" });
    expect(viaForm.status).toBe(302);
    expect(viaForm.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const nullOrigin = await SELF.fetch(`${ORIGIN}/auth/logout`, { method: "POST", headers: { cookie, origin: "null" }, redirect: "manual" });
    expect(nullOrigin.status).toBe(403);
    expect(nullOrigin.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a session id held by another active computer even when it is offline, then hands it over on revoke via resync", async () => {
    const a = await newMachine("vic", "a");
    const b = await newMachine("vic", "b");
    const da = await daemon(a.token);
    da.send({ t: "hello", v: 1, sessions: [{ session_id: "dupe", project: "p" }] });
    await sleep(50);
    da.send({ t: "session_down", session_id: "dupe" });
    const db = await daemon(b.token);
    db.send({ t: "hello", v: 1, sessions: [{ session_id: "dupe", project: "p" }] });
    const e = await waitFor(() => db.frames.find((f) => f.t === "error" && f.session_id === "dupe"), "refusal");
    expect(e.error).toMatch(/MCP_REMOTE_SESSION_ID/);
    const rv = await SELF.fetch(`${ORIGIN}/api/machines/${a.machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("vic"), origin: ORIGIN },
    });
    expect(rv.status).toBe(200);
    await waitFor(() => db.frames.find((f) => f.t === "resync"), "resync");
    db.send({ t: "hello", v: 1, sessions: [{ session_id: "dupe", project: "p" }] });
    const p = await phone("vic");
    await waitFor(
      () => last(p, "state")?.sessions.find((s: any) => s.session_id === "dupe" && s.online && s.machine_id === b.machineId),
      "taken over after revoke",
    );
  });

  it("applies the live-session cap to take-overs", async () => {
    const a = await newMachine("wes", "a");
    const da = await daemon(a.token);
    da.send({ t: "hello", v: 1, sessions: [{ session_id: "w-old", project: "p" }] });
    await sleep(50);
    await SELF.fetch(`${ORIGIN}/api/machines/${a.machineId}`, {
      method: "DELETE",
      headers: { cookie: await cookieFor("wes"), origin: ORIGIN },
    });
    const b = await newMachine("wes", "b");
    const db = await daemon(b.token);
    const sessions = Array.from({ length: 64 }, (_, i) => ({ session_id: `w${i}`, project: "p" }));
    db.send({ t: "hello", v: 1, sessions });
    await sleep(50);
    db.send({ t: "session_up", session: { session_id: "w-old", project: "p" } });
    const e = await waitFor(() => db.frames.find((f) => f.t === "error" && f.session_id === "w-old"), "cap error");
    expect(e.error).toMatch(/too many live sessions/);
  });
});

describe("review round 3", () => {
  it("names the owning computer in a refusal, and resyncs daemons after forget_session", async () => {
    const a = await newMachine("xena", "old-laptop");
    const b = await newMachine("xena", "new-laptop");
    const da = await daemon(a.token);
    da.send({ t: "hello", v: 1, sessions: [{ session_id: "fx", project: "p" }] });
    await sleep(50);
    da.send({ t: "session_down", session_id: "fx" });
    const db = await daemon(b.token);
    db.send({ t: "hello", v: 1, sessions: [{ session_id: "fx", project: "p" }] });
    const e = await waitFor(() => db.frames.find((f) => f.t === "error" && f.session_id === "fx"), "refusal");
    expect(e.error).toMatch(/"old-laptop"/);
    expect(e.error).toMatch(/revoke it on the phone under Machines/);
    const p = await phone("xena");
    await waitFor(() => last(p, "state")?.sessions.find((s: any) => s.session_id === "fx" && !s.online), "offline");
    p.send({ t: "forget_session", session_id: "fx" });
    await waitFor(() => db.frames.find((f) => f.t === "resync"), "resync after forget");
    db.send({ t: "hello", v: 1, sessions: [{ session_id: "fx", project: "p" }] });
    await waitFor(
      () => last(p, "state")?.sessions.find((s: any) => s.session_id === "fx" && s.online && s.machine_id === b.machineId),
      "claimed after forget",
    );
  });

  it("resyncs other daemons when eviction frees session ids", async () => {
    const a = await newMachine("yuri", "a");
    const b = await newMachine("yuri", "b");
    const da = await daemon(a.token);
    const db = await daemon(b.token);
    da.send({ t: "hello", v: 1, sessions: [] });
    db.send({ t: "hello", v: 1, sessions: [] });
    for (let i = 0; i < 51; i++) {
      da.send({ t: "session_up", session: { session_id: `y${i}`, project: "p" } });
      da.send({ t: "session_down", session_id: `y${i}` });
    }
    await waitFor(() => db.frames.find((f) => f.t === "resync"), "resync to other daemon");
    expect(da.frames.find((f) => f.t === "resync")).toBeUndefined();
  });
});

describe("review round 5", () => {
  it("caps history per session and keeps session list fields correct", async () => {
    const { token } = await newMachine("zed");
    await relaxLimits("zed");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "zh", project: "p" }] });
    for (let i = 0; i < 1100; i++) d.send({ t: "send", req_id: `r${i}`, session_id: "zh", text: `n${i}`, urgency: i === 1099 ? "urgent" : "silent" });
    await waitFor(() => d.frames.filter((f) => f.t === "sent").length === 1100, "1100 sent", 15_000);
    const p = await phone("zed");
    const st = await waitFor(() => last(p, "state"), "state");
    expect(st.sessions[0].last_urgency).toBe("urgent");
    expect(st.sessions[0].last_message_at).toBeGreaterThan(0);
    const count = await runInDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("zed"))), (_i, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE session_id = 'zh'").one().n,
    );
    expect(count).toBe(1000);
    p.send({ t: "history", session_id: "zh" });
    const h = await waitFor(() => p.frames.find((f) => f.t === "history"), "history");
    expect(h.messages[h.messages.length - 1].text).toBe("n1099");
  }, 30_000);

  it("uses indexes for the session-list subqueries", async () => {
    const plan = await runInDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("plan"))), (_i, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          `EXPLAIN QUERY PLAN SELECT
             (SELECT created_at FROM messages m WHERE m.session_id = 'x' ORDER BY id DESC LIMIT 1),
             (SELECT urgency FROM messages m WHERE m.session_id = 'x' AND m.direction = 'out' ORDER BY id DESC LIMIT 1),
             (SELECT COUNT(*) FROM messages m WHERE m.session_id = 'x' AND m.direction = 'in' AND m.delivered = 0)`,
        )
        .toArray()
        .map((r) => r.detail),
    );
    const scans = plan.filter((d) => /SCAN m\b/.test(d) && !/USING/.test(d));
    expect(scans).toEqual([]);
    expect(plan.filter((d) => /SEARCH m USING (COVERING )?INDEX/.test(d)).length).toBe(3);
  });
});

describe("review round 6", () => {
  type HubInternals = {
    insertMessage: (sid: string, dir: "in" | "out", text: string, u: string | null, now: number, d: 0 | 1) => { rowsRead: number };
  };
  const seed = (state: DurableObjectState, sid: string) =>
    state.storage.sql.exec(
      "INSERT INTO sessions (session_id, machine_id, project, online, last_seen, created_at) VALUES (?, 'm', 'p', 0, 0, 0)",
      sid,
    );

  it("keeps amortized rows read per insert small in a full session", async () => {
    const stub = E.HUB.get(E.HUB.idFromName(tenantIdForDev("rows")));
    const { avg, max, count } = await runInDurableObject(stub, (instance, state) => {
      const hub = instance as unknown as HubInternals;
      seed(state, "full");
      for (let i = 0; i < 1000; i++) hub.insertMessage("full", "out", `x${i}`, "silent", i, 1);
      let total = 0;
      let max = 0;
      for (let i = 0; i < 500; i++) {
        const r = hub.insertMessage("full", "out", `y${i}`, "silent", 1000 + i, 1).rowsRead;
        total += r;
        max = Math.max(max, r);
      }
      const count = state.storage.sql
        .exec<{ n: number; c: number }>(
          "SELECT (SELECT COUNT(*) FROM messages WHERE session_id = 'full') AS n, (SELECT msg_count FROM sessions WHERE session_id = 'full') AS c",
        )
        .one();
      return { avg: total / 500, max, count };
    });
    expect(avg).toBeLessThan(20); // measured ~9 (was ~2000 with the per-insert OFFSET trim)
    expect(max).toBeLessThan(400); // one trim step: ~50 index entries + rows + index deletes
    expect(count.n).toBe(count.c);
    expect(count.n).toBeLessThanOrEqual(1000 + 50);
  });

  it("never trims undelivered inbound messages (soft cap while queued)", async () => {
    const stub = E.HUB.get(E.HUB.idFromName(tenantIdForDev("queue")));
    const r = await runInDurableObject(stub, (instance, state) => {
      const hub = instance as unknown as HubInternals;
      seed(state, "q");
      for (let i = 0; i < 1100; i++) hub.insertMessage("q", "in", `q${i}`, null, i, 0);
      return state.storage.sql
        .exec<{ n: number; first: string }>(
          "SELECT COUNT(*) AS n, (SELECT text FROM messages WHERE session_id = 'q' ORDER BY id LIMIT 1) AS first FROM messages WHERE session_id = 'q'",
        )
        .one();
    });
    expect(r.n).toBe(1100);
    expect(r.first).toBe("q0");
  });

  it("backfills msg_count idempotently for Hubs from before the column existed", async () => {
    const stub = E.HUB.get(E.HUB.idFromName(tenantIdForDev("legacy")));
    await runInDurableObject(stub, (_i, state) => {
      seed(state, "old");
      for (let i = 0; i < 5; i++)
        state.storage.sql.exec("INSERT INTO messages (session_id, direction, text, created_at) VALUES ('old', 'out', 't', 0)");
      state.storage.sql.exec("UPDATE sessions SET msg_count = 0");
      state.storage.sql.exec("DELETE FROM meta WHERE k = 'msg_count_v1'");
    });
    await evictDurableObject(stub);
    const c1 = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ c: number }>("SELECT msg_count AS c FROM sessions WHERE session_id = 'old'").one().c,
    );
    expect(c1).toBe(5);
    await evictDurableObject(stub);
    const c2 = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ c: number }>("SELECT msg_count AS c FROM sessions WHERE session_id = 'old'").one().c,
    );
    expect(c2).toBe(5);
  });
});

describe("remote launch (phase 2)", () => {
  const rec = (id: string, state = "starting") => ({
    launch_id: id,
    session_id: id,
    project_id: "palpha0000000000",
    project: "alpha",
    state,
    exit_code: null,
    detail: null,
    continued: false,
    auto_restart: false,
    restarts: 0,
    started_at: 1,
    updated_at: 2,
  });

  it("stores the daemon's projects + launches on the machine and relays launch requests both ways", async () => {
    const { machineId, token } = await newMachine("lara");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [] });
    d.send({ t: "projects", projects: [{ id: "palpha0000000000", name: "alpha" }], available: true, launch_error: null, max_sessions: 4 });
    const p = await phone("lara");
    const st = await waitFor(() => last(p, "state")?.machines[0]?.launch && last(p, "state"), "launch info in state");
    expect(st.machines[0].launch).toEqual({ projects: [{ id: "palpha0000000000", name: "alpha" }], launches: [], available: true, launch_error: null, max_sessions: 4 });

    p.send({ t: "launch", machine_id: machineId, project_id: "palpha0000000000", continue: true, client_id: "k1" });
    const fwd = await waitFor(() => d.frames.find((f) => f.t === "launch"), "launch at daemon");
    expect(fwd).toEqual({ t: "launch", req_id: "k1", project_id: "palpha0000000000", continue: true });

    d.send({ t: "launch_result", req_id: "k1", ok: true });
    d.send({ t: "launches", launches: [rec("mr-0123456789ab")] });
    const res = await waitFor(() => p.frames.find((f) => f.t === "launch_result"), "result at phone");
    expect(res).toEqual({ t: "launch_result", client_id: "k1", ok: true });
    const lf = await waitFor(() => p.frames.find((f) => f.t === "launches"), "launches at phone");
    expect(lf).toMatchObject({ machine_id: machineId, launches: [{ launch_id: "mr-0123456789ab", state: "starting" }] });

    p.send({ t: "launch_restart", machine_id: machineId, launch_id: "mr-0123456789ab", continue: false, client_id: "k2" });
    p.send({ t: "launch_stop", machine_id: machineId, launch_id: "mr-0123456789ab", client_id: "k3" });
    p.send({ t: "launch_dismiss", machine_id: machineId, launch_id: "mr-0123456789ab", client_id: "k4" });
    await waitFor(() => d.frames.filter((f) => f.t.startsWith("launch_")).length === 3, "3 ops");
    expect(d.frames.filter((f) => f.t.startsWith("launch_"))).toEqual([
      { t: "launch_restart", req_id: "k2", launch_id: "mr-0123456789ab", continue: false },
      { t: "launch_stop", req_id: "k3", launch_id: "mr-0123456789ab" },
      { t: "launch_dismiss", req_id: "k4", launch_id: "mr-0123456789ab" },
    ]);

    // Persisted: a new phone (and a hibernated Hub) still sees the last snapshot.
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("lara"))));
    const p2 = await phone("lara");
    const st2 = await waitFor(() => last(p2, "state"), "state");
    expect(st2.machines[0].launch.launches[0].launch_id).toBe("mr-0123456789ab");
  });

  it("refuses launches for offline, revoked or unknown computers and rejects path-like ids", async () => {
    const { machineId, token } = await newMachine("mona");
    const p = await phone("mona");
    p.send({ t: "launch", machine_id: machineId, project_id: "palpha0000000000", continue: false, client_id: "o1" });
    const off = await waitFor(() => p.frames.find((f) => f.t === "launch_result" && f.client_id === "o1"), "offline");
    expect(off).toMatchObject({ ok: false, error: "this computer is offline" });
    p.send({ t: "launch", machine_id: "mnope", project_id: "palpha0000000000", continue: false, client_id: "o2" });
    expect(await waitFor(() => p.frames.find((f) => f.t === "launch_result" && f.client_id === "o2"), "unknown")).toMatchObject({ error: "unknown computer" });
    p.send({ t: "launch", machine_id: machineId, project_id: "/etc", continue: false, client_id: "o3" });
    expect((await waitFor(() => p.frames.find((f) => f.t === "error"), "invalid")).error).toMatch(/invalid frame/);

    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [] });
    await SELF.fetch(`${ORIGIN}/api/machines/${machineId}`, { method: "DELETE", headers: { cookie: await cookieFor("mona"), origin: ORIGIN } });
    await waitFor(() => d.closed, "daemon closed");
    p.send({ t: "launch", machine_id: machineId, project_id: "palpha0000000000", continue: false, client_id: "o4" });
    expect(await waitFor(() => p.frames.find((f) => f.t === "launch_result" && f.client_id === "o4"), "revoked")).toMatchObject({
      error: "this computer was revoked",
    });
    expect(d.frames.find((f) => f.t === "launch")).toBeUndefined();
  });

  it("keeps tenants apart for launch requests", async () => {
    const { machineId, token } = await newMachine("nina");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [] });
    await sleep(30);
    const other = await phone("otto");
    other.send({ t: "launch", machine_id: machineId, project_id: "palpha0000000000", continue: false, client_id: "x1" });
    expect(await waitFor(() => other.frames.find((f) => f.t === "launch_result"), "refused")).toMatchObject({ ok: false, error: "unknown computer" });
    await sleep(50);
    expect(d.frames.find((f) => f.t === "launch")).toBeUndefined();
  });

  it("writes one row and reads none for a launches snapshot", async () => {
    const stub = E.HUB.get(E.HUB.idFromName(tenantIdForDev("rowsl")));
    const r = await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("INSERT INTO machines (machine_id, name, created_at) VALUES ('m', 'box', 0)");
      const q = "UPDATE machines SET launches_json = ?1 WHERE machine_id = ?2 AND launches_json IS NOT ?1";
      const v = JSON.stringify([rec("mr-0123456789ab")]);
      const c = state.storage.sql.exec(q, v, "m");
      c.toArray();
      const again = state.storage.sql.exec(q, v, "m");
      again.toArray();
      return { read: c.rowsRead, written: c.rowsWritten, again: again.rowsWritten };
    });
    expect(r.written).toBe(1);
    expect(r.read).toBeLessThanOrEqual(1); // primary-key lookup of the row being updated
    expect(r.again).toBe(0); // an unchanged snapshot (every reconnect) writes nothing and is not broadcast
  });
});

describe("phase 2 review round 2", () => {
  it("evicts sessions that never had a message before ones with history", async () => {
    const { token } = await newMachine("eve2");
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [] });
    // Two old threads with history...
    for (const id of ["keep1", "keep2"]) {
      d.send({ t: "session_up", session: { session_id: id, project: "p" } });
      d.send({ t: "send", req_id: `r-${id}`, session_id: id, text: "hello", urgency: "normal" });
      d.send({ t: "session_down", session_id: id });
    }
    await waitFor(() => d.frames.filter((f) => f.t === "sent").length === 2, "2 sent");
    // ...then many sessions that come and go without a message (e.g. `claude -p` runs).
    for (let i = 0; i < 70; i++) {
      d.send({ t: "session_up", session: { session_id: `e${i}`, project: "p" } });
      d.send({ t: "session_down", session_id: `e${i}` });
    }
    const p = await phone("eve2");
    await waitFor(() => last(p, "state")?.sessions.some((s: any) => s.session_id === "e69"), "all processed");
    const ids = last(p, "state").sessions.map((s: any) => s.session_id);
    expect(ids.length).toBe(50);
    expect(ids).toContain("keep1");
    expect(ids).toContain("keep2");
    expect(ids).toContain("e69");
    expect(ids).not.toContain("e0");
  });
});
