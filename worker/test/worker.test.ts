// Integration tests that run inside workerd via @cloudflare/vitest-plugin.
import { SELF, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeSessionCookieValue, mintMachineToken, tenantIdForDev } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import { devAuthEnabled } from "../src/index";
import type { Env } from "../src/env";

const ORIGIN = "https://example.com";
const E = env as unknown as Env;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeout = 3000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function cookieFor(user: string): Promise<string> {
  const v = await makeSessionCookieValue(E.SESSION_SECRET, { tid: tenantIdForDev(user), email: `${user}@dev.local` });
  return `__Host-mr_session=${v}`;
}

interface Sock {
  ws: WebSocket;
  frames: any[];
  closed: { code: number; reason: string } | null;
  send: (f: unknown) => void;
}

async function connect(path: string, headers: Record<string, string>): Promise<Sock | number> {
  const res = await SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: "websocket", ...headers } });
  if (!res.webSocket) return res.status;
  const ws = res.webSocket;
  ws.accept();
  const s: Sock = { ws, frames: [], closed: null, send: (f) => ws.send(typeof f === "string" ? f : JSON.stringify(f)) };
  ws.addEventListener("message", (e) => {
    const d = String(e.data);
    if (d !== "pong") s.frames.push(JSON.parse(d));
  });
  ws.addEventListener("close", (e) => {
    s.closed = { code: e.code, reason: e.reason };
  });
  return s;
}

async function phone(user: string): Promise<Sock> {
  const s = await connect("/api/ws", { cookie: await cookieFor(user), origin: ORIGIN });
  if (typeof s === "number") throw new Error(`phone connect failed: ${s}`);
  return s;
}

async function newMachine(
  user: string,
  name = "box",
  tid = tenantIdForDev(user),
  email?: string,
): Promise<{ machineId: string; token: string }> {
  const machineId = `m${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const token = await mintMachineToken(E.SESSION_SECRET, tid, machineId);
  await E.HUB.get(E.HUB.idFromName(tid)).addMachine(machineId, name, await sha256Hex(token), email);
  return { machineId, token };
}

async function daemon(token: string): Promise<Sock> {
  const s = await connect("/api/daemon/ws", { authorization: `Bearer ${token}` });
  if (typeof s === "number") throw new Error(`daemon connect failed: ${s}`);
  return s;
}

const last = (s: Sock, t: string) => [...s.frames].reverse().find((f) => f.t === t);

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
    expect(await connect(`/api/pair/wait${q}`, { authorization: "Bearer wrong" })).toBe(404);

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

    // Claiming wipes the pending pairing.
    waiter.ws.send("claimed");
    await waitFor(() => waiter.closed, "pairing socket closed");
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
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "zh", project: "p" }] });
    for (let i = 0; i < 1005; i++) d.send({ t: "send", req_id: `r${i}`, session_id: "zh", text: `n${i}`, urgency: i === 1004 ? "urgent" : "silent" });
    await waitFor(() => d.frames.filter((f) => f.t === "sent").length === 1005, "1005 sent", 15_000);
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
    expect(h.messages[h.messages.length - 1].text).toBe("n1004");
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
