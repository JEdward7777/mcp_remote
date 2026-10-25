// Integration tests that run inside workerd via @cloudflare/vitest-plugin.
import { SELF, env, evictDurableObject } from "cloudflare:test";
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

async function newMachine(user: string, name = "box"): Promise<{ machineId: string; token: string }> {
  const tid = tenantIdForDev(user);
  const machineId = `m${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const token = await mintMachineToken(E.SESSION_SECRET, tid, machineId);
  await E.HUB.get(E.HUB.idFromName(tid)).addMachine(machineId, name, await sha256Hex(token));
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
    expect(e.error).toMatch(/another machine/);
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
