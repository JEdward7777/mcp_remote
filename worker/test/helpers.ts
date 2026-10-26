// Shared helpers for the workerd integration tests.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { makeSessionCookieValue, mintMachineToken, tenantIdForDev } from "../src/auth";
import { sha256Hex } from "../src/crypto";
import type { Env } from "../src/env";

export const ORIGIN = "https://example.com";
export const E = env as unknown as Env;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeout = 3000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export async function cookieFor(user: string): Promise<string> {
  const v = await makeSessionCookieValue(E.SESSION_SECRET, { tid: tenantIdForDev(user), email: `${user}@dev.local` });
  return `__Host-mr_session=${v}`;
}

export interface Sock {
  ws: WebSocket;
  frames: any[];
  closed: { code: number; reason: string } | null;
  send: (f: unknown) => void;
}

export async function connect(path: string, headers: Record<string, string>): Promise<Sock | number> {
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

export async function phone(user: string): Promise<Sock> {
  const s = await connect("/api/ws", { cookie: await cookieFor(user), origin: ORIGIN });
  if (typeof s === "number") throw new Error(`phone connect failed: ${s}`);
  return s;
}

export async function newMachine(
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

export async function daemon(token: string): Promise<Sock> {
  const s = await connect("/api/daemon/ws", { authorization: `Bearer ${token}` });
  if (typeof s === "number") throw new Error(`daemon connect failed: ${s}`);
  return s;
}

export const last = (s: Sock, t: string) => [...s.frames].reverse().find((f) => f.t === t);

/** Run `fn` against the live Hub instance of `user` (its private fields are reachable as `any`). */
export async function withHub<T>(user: string, fn: (hub: any, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  const stub = E.HUB.get(E.HUB.idFromName(tenantIdForDev(user))) as unknown as DurableObjectStub;
  return runInDurableObject(stub, fn as (i: unknown, s: DurableObjectState) => T | Promise<T>);
}

/** Override some of a tenant's limits on its live Hub instance (until it is evicted). */
export async function setLimits(user: string, patch: Record<string, unknown>): Promise<void> {
  await withHub(user, (hub) => {
    hub.wake(Date.now());
    hub.limits = { ...hub.limits, ...patch };
    hub.limiter.setRates(hub.limits);
  });
}

/** Volume tests below predate Phase 3's per-tenant limits: lift them for that tenant's Hub only. */
export async function relaxLimits(user: string): Promise<void> {
  const big = { burst: 1e6, per: 1e6, perMs: 1000 };
  await setLimits(user, { phone_send: big, agent_send: big, history: big, phone_frames: big, daemon_frames: big, daily_messages: 1e9 });
}
