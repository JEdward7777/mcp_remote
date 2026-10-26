// Phase 4: Web Push subscriptions, when a push is sent (D19), push-service answers, and the
// on-demand location round trip (D14). Pushes go to a fake push service injected into the Hub.
import { SELF, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantIdForDev } from "../src/auth";
import { MAX_PUSH_DEVICES } from "../src/budget";
import { pushExtraOrigins } from "../src/env";
import { E, ORIGIN, cookieFor, daemon, last, newMachine, phone, setLimits, sleep, waitFor, withHub } from "./helpers";
import { decryptPush, fakePushService, fakeSubscription, type FakeSub } from "./push-helpers";

async function subscribe(user: string, sub: { endpoint: string; keys: unknown }, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
    method: "POST",
    headers: { cookie: await cookieFor(user), origin: ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(sub),
  });
}

async function unsubscribe(user: string, endpoint: string): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
    method: "DELETE",
    headers: { cookie: await cookieFor(user), origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

/** A daemon with one online session; optionally a phone. */
async function setup(user: string, withPhone = false) {
  const { token, machineId } = await newMachine(user);
  const d = await daemon(token);
  const sid = `${user}-s`;
  d.send({ t: "hello", v: 1, sessions: [{ session_id: sid, project: "proj" }] });
  await waitFor(() => last(d, "welcome"), "welcome");
  await sleep(50);
  const p = withPhone ? await phone(user) : null;
  if (p) await waitFor(() => last(p, "state")?.sessions[0]?.online, "online");
  return { d, p, sid, machineId };
}

async function subscribed(user: string, n = 1): Promise<FakeSub[]> {
  const subs: FakeSub[] = [];
  for (let i = 0; i < n; i++) {
    const s = await fakeSubscription();
    const r = await subscribe(user, s);
    expect(r.status, await r.clone().text()).toBe(200);
    subs.push(s);
  }
  return subs;
}

describe("push subscriptions (/api/push/subscribe)", () => {
  it("needs a session cookie, our Origin and a valid subscription for a known push service", async () => {
    const s = await fakeSubscription();
    const anon = await SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(s),
    });
    expect(anon.status).toBe(401);
    expect((await subscribe("ps-auth", s, { origin: "https://evil.example" })).status).toBe(403);
    const ssrf = await subscribe("ps-auth", { ...s, endpoint: "https://169.254.169.254/latest" });
    expect(ssrf.status).toBe(400);
    expect(((await ssrf.json()) as { error: string }).error).toMatch(/not a known Web Push service/);
    expect((await subscribe("ps-auth", { ...s, keys: { p256dh: "AAAA", auth: s.keys.auth } })).status).toBe(400);
    const big = await SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
      method: "POST",
      headers: { cookie: await cookieFor("ps-auth"), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ...s, pad: "x".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    const ok = await subscribe("ps-auth", s);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { id: string; devices: string[] };
    expect(body.devices).toEqual([body.id]);
    expect(body.id).toMatch(/^[0-9a-f]{16}$/);
    // Idempotent: the same subscription again is still one device.
    expect(((await (await subscribe("ps-auth", s)).json()) as { devices: string[] }).devices).toEqual([body.id]);
    const del = await unsubscribe("ps-auth", s.endpoint);
    expect(await del.json()).toMatchObject({ ok: true, removed: true, devices: [] });
  });

  it(`keeps at most ${MAX_PUSH_DEVICES} devices per account (a new one replaces the oldest)`, async () => {
    const subs = await subscribed("ps-cap", MAX_PUSH_DEVICES + 1);
    const n = await withHub("ps-cap", (_h, state) => state.storage.sql.exec("SELECT endpoint FROM push_subs").toArray().map((r) => r.endpoint));
    expect(n.length).toBe(MAX_PUSH_DEVICES);
    expect(n).not.toContain(subs[0]!.endpoint);
    expect(n).toContain(subs[MAX_PUSH_DEVICES]!.endpoint);
  });

  it("is rate limited and charged to the account like any API call", async () => {
    await setLimits("ps-rl", { http: { burst: 2, per: 1, perMs: 3_600_000 } });
    const s = await fakeSubscription();
    expect((await subscribe("ps-rl", s)).status).toBe(200);
    expect((await unsubscribe("ps-rl", s.endpoint)).status).toBe(200);
    const r = await subscribe("ps-rl", s);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    const usage = await withHub("ps-rl", (hub) => hub.meter.today(Date.now()));
    expect(usage.requests).toBeGreaterThanOrEqual(3);
  });

  it("tells the phone its push key (/api/me) and which devices are registered (state.settings)", async () => {
    const me = (await (await SELF.fetch(`${ORIGIN}/api/me`, { headers: { cookie: await cookieFor("ps-me") } })).json()) as { push_key: string };
    expect(me.push_key).toBe(E.VAPID_PUBLIC_KEY);
    const p = await phone("ps-me");
    await waitFor(() => last(p, "state"), "state");
    expect(last(p, "state").settings).toMatchObject({ push_preview: true, location: true, push_devices: [], push_available: true });
    const [s] = await subscribed("ps-me");
    const f = await waitFor(() => last(p, "settings"), "settings frame");
    expect(f.settings.push_devices.length).toBe(1);
    void s;
  });

  it("extra (local test) push origins only count with DEV_AUTH=1", () => {
    expect(pushExtraOrigins({ ...E, DEV_AUTH: "", PUSH_EXTRA_ORIGINS: "http://127.0.0.1:9" })).toEqual([]);
    expect(pushExtraOrigins({ ...E, DEV_AUTH: "1", PUSH_EXTRA_ORIGINS: "http://127.0.0.1:9, javascript:x" })).toEqual(["http://127.0.0.1:9"]);
  });
});

describe("when the Hub sends Web Push (D19)", () => {
  it("normal message, no app open: one encrypted push per device, VAPID-signed, preview of 100 chars", async () => {
    const { d, sid } = await setup("wp-normal");
    const [sub] = await subscribed("wp-normal");
    const calls = await fakePushService("wp-normal");
    const text = `Done: ${"all tests pass. ".repeat(20)}`;
    d.send({ t: "send", req_id: "r1", session_id: sid, text, urgency: "normal" });
    const sent = await waitFor(() => last(d, "sent"), "sent");
    expect(sent.notify).toBe("notification sent to 1 phone");
    await waitFor(() => calls.length === 1, "push");
    const c = calls[0]!;
    expect(c.url).toBe(sub!.endpoint);
    expect(c.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "21600", urgency: "normal" });
    expect(c.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    const payload = (await decryptPush(sub!, c.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ k: "m", s: sid, u: "normal", i: sent.message_id, p: "proj" });
    expect(Array.from(payload.b as string).length).toBe(100);
    expect(await withHub("wp-normal", (h) => h.meter.today(Date.now()).pushes)).toBe(1);
  });

  it("urgent = Urgency: high + longer TTL; silent = no push at all", async () => {
    const { d, sid } = await setup("wp-urgent");
    await subscribed("wp-urgent", 2);
    const calls = await fakePushService("wp-urgent");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "silent fyi", urgency: "silent" });
    expect((await waitFor(() => d.frames.find((f) => f.t === "sent" && f.req_id === "r1"), "sent")).notify).toMatch(/^silent/);
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "blocked, need you", urgency: "urgent" });
    expect((await waitFor(() => d.frames.find((f) => f.t === "sent" && f.req_id === "r2"), "sent")).notify).toBe("notification sent to 2 phones");
    await waitFor(() => calls.length === 2, "2 pushes");
    await sleep(100);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.headers).toMatchObject({ urgency: "high", ttl: "86400" });
  });

  it("no push while a visible app is connected; pushes again when it is hidden or has gone quiet", async () => {
    const { d, p, sid } = await setup("wp-vis", true);
    await subscribed("wp-vis");
    const calls = await fakePushService("wp-vis");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "one", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r1"), "sent")).notify).toMatch(/app is open/);
    p!.send({ t: "visibility", visible: false });
    await sleep(50);
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "two", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "sent")).notify).toBe("notification sent to 1 phone");
    await waitFor(() => calls.length === 1, "push while hidden");
    p!.send({ t: "visibility", visible: true });
    await sleep(50);
    d.send({ t: "send", req_id: "r3", session_id: sid, text: "three", urgency: "urgent" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r3"), "sent")).notify).toMatch(/app is open/);
    // A visible socket that stopped showing signs of life (half-open: no frame, no ping) stops counting.
    await withHub("wp-vis", (_h, state) => {
      for (const ws of state.getWebSockets("phone")) ws.serializeAttachment({ ...ws.deserializeAttachment(), seen: Date.now() - 80_000 });
    });
    d.send({ t: "send", req_id: "r4", session_id: sid, text: "four", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r4"), "sent")).notify).toBe("notification sent to 1 phone");
    // ...but a keepalive ping answered by the runtime (auto-response, no wake-up) is a sign of life.
    p!.ws.send("ping");
    await sleep(50);
    d.send({ t: "send", req_id: "r5", session_id: sid, text: "five", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r5"), "sent")).notify).toMatch(/app is open/);
    expect(calls.length).toBe(2);
  });

  it("without the lock-screen preview, the payload names neither the project nor the text", async () => {
    const { d, p, sid } = await setup("wp-priv", true);
    const [sub] = await subscribed("wp-priv");
    const calls = await fakePushService("wp-priv");
    p!.send({ t: "settings", push_preview: false });
    await waitFor(() => last(p!, "settings")?.settings.push_preview === false, "setting");
    p!.ws.close();
    await sleep(50);
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "secret stuff", urgency: "normal" });
    await waitFor(() => calls.length === 1, "push");
    expect(await decryptPush(sub!, calls[0]!.body)).toEqual({ k: "m", s: sid, u: "normal", i: last(d, "sent").message_id });
  });

  it("410/404 delete the subscription; 429/5xx pause that device without any retry", async () => {
    const { d, sid } = await setup("wp-gone");
    const [a, b, c] = await subscribed("wp-gone", 3);
    const calls = await fakePushService("wp-gone", (call) =>
      call.url === a!.endpoint ? 410 : call.url === b!.endpoint ? new Response(null, { status: 429, headers: { "retry-after": "600" } }) : 201,
    );
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "x", urgency: "normal" });
    await waitFor(() => calls.length === 3, "3 pushes");
    await sleep(100);
    expect(calls.length).toBe(3); // nothing retried
    const left = await withHub("wp-gone", (_h, state) => state.storage.sql.exec("SELECT endpoint FROM push_subs").toArray().map((r) => r.endpoint));
    expect(left.sort()).toEqual([b!.endpoint, c!.endpoint].sort());
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "y", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "sent")).notify).toBe("notification sent to 1 phone");
    await waitFor(() => calls.length === 4, "4th push");
    expect(calls[3]!.url).toBe(c!.endpoint); // the 429 device is skipped while paused
  });

  it("caps pushes per account and day (each device counts), and never blocks the message itself", async () => {
    const { d, sid } = await setup("wp-daycap");
    await subscribed("wp-daycap", 2);
    const calls = await fakePushService("wp-daycap");
    await setLimits("wp-daycap", { daily_pushes: 3 });
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "1", urgency: "normal" });
    await waitFor(() => d.frames.find((f) => f.req_id === "r1"), "r1");
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "2", urgency: "normal" });
    const s2 = await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "r2");
    expect(s2.t).toBe("sent");
    expect(s2.notify).toMatch(/^no notification: daily notification limit reached \(3 per day/);
    await sleep(100);
    expect(calls.length).toBe(2);
  });

  it("says why there is no notification when no phone has enabled them", async () => {
    const { d, sid } = await setup("wp-none");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "x", urgency: "urgent" });
    expect((await waitFor(() => last(d, "sent"), "sent")).notify).toMatch(/notifications are not enabled on any phone/);
  });
});

describe("on-demand location (D14)", () => {
  const pos = (at = Date.now()) => ({ lat: 52.37, lon: 4.89, accuracy_m: 12, at });

  it("open app: the phone is asked, the answer goes back to the asking session and becomes last-known", async () => {
    const { d, p, sid, machineId } = await setup("loc-app", true);
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 0, reason: "directions to the station" });
    const w = await waitFor(() => last(d, "location_wait"), "wait");
    expect(w).toEqual({ t: "location_wait", req_id: "l1", via: "app", last: null });
    const q = await waitFor(() => last(p!, "location_request"), "prompt");
    expect(q).toEqual({ t: "location_request", rid: "l1", machine_id: machineId, session_id: sid, project: "proj", reason: "directions to the station" });
    p!.send({ t: "location", rid: "l1", machine_id: machineId, session_id: sid, status: "ok", position: pos() });
    const r = await waitFor(() => last(d, "location"), "answer");
    expect(r.result).toMatchObject({ status: "ok", fresh: true, position: { lat: 52.37, lon: 4.89, accuracy_m: 12 } });
    expect(last(p!, "location_done")).toEqual({ t: "location_done", rid: "l1" });
    // A later request that accepts a recent position is answered at once, without bothering the phone.
    d.send({ t: "location_req", req_id: "l2", session_id: sid, max_age_s: 600 });
    const r2 = await waitFor(() => d.frames.find((f) => f.t === "location" && f.req_id === "l2"), "cached");
    expect(r2.result).toMatchObject({ status: "ok", fresh: false });
    expect(p!.frames.filter((f) => f.t === "location_request").length).toBe(1);
    // The phone list learns when (never where) the last position was taken.
    expect(last(p!, "settings").settings.location_at).toBe(r.result.position.at);
  });

  it("declined / unavailable answers reach the session; a future timestamp is clamped", async () => {
    const { d, p, sid, machineId } = await setup("loc-deny", true);
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 0 });
    await waitFor(() => last(p!, "location_request"), "prompt");
    p!.send({ t: "location", rid: "l1", machine_id: machineId, session_id: sid, status: "denied" });
    expect((await waitFor(() => last(d, "location"), "denied")).result).toMatchObject({ status: "denied", position: null, fresh: false });
    p!.send({ t: "location", status: "ok", position: pos(Date.now() + 3_600_000) });
    await waitFor(() => last(p!, "settings")?.settings.location_at, "stored");
    expect(last(p!, "settings").settings.location_at).toBeLessThanOrEqual(Date.now());
    // "ok" without a position is refused by the schema.
    p!.send({ t: "location", status: "ok" });
    await waitFor(() => last(p!, "error")?.error.includes("position is required"), "schema error");
  });

  it("no open app: a high-priority push asks for it; nothing to ask: no_device right away", async () => {
    const { d, sid, machineId } = await setup("loc-push");
    d.send({ t: "location_req", req_id: "l0", session_id: sid, max_age_s: 0 });
    const nd = await waitFor(() => last(d, "location"), "no device");
    expect(nd.result).toMatchObject({ status: "no_device", position: null });
    expect(nd.result.message).toMatch(/not open/);
    const [sub] = await subscribed("loc-push");
    const calls = await fakePushService("loc-push");
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 0, reason: "where am I?" });
    expect(await waitFor(() => last(d, "location_wait"), "wait")).toMatchObject({ via: "push" });
    await waitFor(() => calls.length === 1, "push");
    expect(calls[0]!.headers).toMatchObject({ urgency: "high", ttl: "120" });
    expect(await decryptPush(sub!, calls[0]!.body)).toEqual({ k: "l", r: "l1", m: machineId, s: sid, p: "proj", b: "where am I?" });
  });

  it("disabled in Settings: refused, and the last-known position is forgotten", async () => {
    const { d, p, sid } = await setup("loc-off", true);
    p!.send({ t: "location", status: "ok", position: pos() });
    await waitFor(() => last(p!, "settings")?.settings.location_at, "stored");
    p!.send({ t: "settings", location: false });
    await waitFor(() => last(p!, "settings")?.settings.location === false, "off");
    expect(last(p!, "settings").settings.location_at).toBeNull();
    expect(await withHub("loc-off", (_h, s) => s.storage.sql.exec("SELECT v FROM meta WHERE k = 'loc'").toArray())).toEqual([]);
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 86400 });
    expect((await waitFor(() => last(d, "location"), "disabled")).result).toMatchObject({ status: "disabled", position: null });
    p!.send({ t: "location", status: "ok", position: pos() });
    await waitFor(() => last(p!, "error")?.error.includes("turned off"), "refused");
  });

  it("last-known expires after 6 h (and is deleted), and phone-asking requests are rate limited", async () => {
    const { d, p, sid } = await setup("loc-old", true);
    p!.send({ t: "location", status: "ok", position: pos(Date.now() - 7 * 3600_000) });
    await waitFor(() => last(p!, "settings"), "stored");
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 86400 });
    expect(await waitFor(() => last(d, "location_wait"), "asks the phone")).toMatchObject({ last: null });
    await setLimits("loc-old", { location: { burst: 1, per: 1, perMs: 3_600_000 } });
    d.send({ t: "location_req", req_id: "l2", session_id: sid, max_age_s: 0 });
    await waitFor(() => d.frames.filter((f) => f.t === "location_wait").length === 2, "second wait");
    d.send({ t: "location_req", req_id: "l3", session_id: sid, max_age_s: 0 });
    const r = await waitFor(() => d.frames.find((f) => f.t === "location" && f.req_id === "l3"), "limited");
    expect(r.result.status).toBe("rate_limited");
    expect(r.result.message).toMatch(/too many location requests/);
  });

  it("survives the Hub hibernating between the request and the answer (routing travels with the request)", async () => {
    const { d, p, sid, machineId } = await setup("loc-evict", true);
    d.send({ t: "location_req", req_id: "l1", session_id: sid, max_age_s: 0 });
    await waitFor(() => last(p!, "location_request"), "prompt");
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("loc-evict"))));
    p!.send({ t: "location", rid: "l1", machine_id: machineId, session_id: sid, status: "ok", position: pos() });
    expect((await waitFor(() => last(d, "location"), "answer")).result.status).toBe("ok");
  });
});
