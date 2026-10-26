// Phase 4: Web Push subscriptions, when a push is sent (D19), push-service answers, and the
// on-demand location round trip (D14). Pushes go to a fake push service injected into the Hub.
import { SELF, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { tenantIdForDev } from "../src/auth";
import { MAX_PUSH_DEVICES, limitsFor } from "../src/budget";
import { describePushOutcomes } from "../src/hub";
import { pushExtraOrigins } from "../src/env";
import { E, ORIGIN, type Sock, cookieFor, daemon, last, newMachine, phone, setLimits, sleep, waitFor, withHub } from "./helpers";
import { subscriptionId } from "../src/webpush";
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

  it("lists devices with a label and removes one by id (e.g. a lost phone) or all of them", async () => {
    const [a, b] = await subscribed("ps-rm", 2);
    const p = await phone("ps-rm");
    const st = await waitFor(() => last(p, "state"), "state");
    expect(st.settings.push_devices).toEqual([
      expect.objectContaining({ id: await subscriptionId(a!.endpoint), label: expect.any(String) }),
      expect.objectContaining({ id: await subscriptionId(b!.endpoint) }),
    ]);
    const del = (body: unknown) =>
      cookieFor("ps-rm").then((cookie) =>
        SELF.fetch(`${ORIGIN}/api/push/subscribe`, { method: "DELETE", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
    expect(await (await del({ id: await subscriptionId(a!.endpoint) })).json()).toMatchObject({ removed: true, devices: [await subscriptionId(b!.endpoint)] });
    expect((await del({ id: "not-an-id" })).status).toBe(400);
    expect(await (await del({ all: true })).json()).toMatchObject({ removed: true, devices: [] });
    await waitFor(() => last(p, "settings")?.settings.push_devices.length === 0, "list empty");
  });

  it("labels devices from the User-Agent", async () => {
    const { deviceLabel } = await import("../src/index");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe("Chrome on Android");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on Windows");
    expect(deviceLabel(null)).toBe("Browser");
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

  it("push cap and location rate are per plan and tunable for the free plan", () => {
    expect(limitsFor("free", {}).daily_pushes).toBe(200);
    expect(limitsFor("owner", {}).daily_pushes).toBe(2000);
    expect(limitsFor("free", { DAILY_PUSH_CAP: "7", LIMIT_LOCATION: "2,4/h" })).toMatchObject({
      daily_pushes: 7,
      location: { burst: 2, per: 4, perMs: 3_600_000 },
    });
    expect(limitsFor("free", { DAILY_PUSH_CAP: "lots" }).daily_pushes).toBe(200);
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
    expect(sent.notify).toBe("push notification sent to 1 phone");
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
    expect((await waitFor(() => d.frames.find((f) => f.t === "sent" && f.req_id === "r2"), "sent")).notify).toBe("push notification sent to 2 phones");
    await waitFor(() => calls.length === 2, "2 pushes");
    await sleep(100);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.headers).toMatchObject({ urgency: "high", ttl: "86400" });
  });

  it("no push while a visible app is connected; pushes again when it is hidden or has gone quiet", async () => {
    const { d, sid } = await setup("wp-vis");
    const [sub] = await subscribed("wp-vis");
    // This browser's page is visible and says which push subscription is its own.
    const p = await phone("wp-vis", `?vis=1&dev=${await subscriptionId(sub!.endpoint)}`);
    await waitFor(() => last(p, "state"), "state");
    const calls = await fakePushService("wp-vis");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "one", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r1"), "sent")).notify).toMatch(/app is open/);
    p.send({ t: "visibility", visible: false });
    await sleep(50);
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "two", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "sent")).notify).toBe("push notification sent to 1 phone");
    await waitFor(() => calls.length === 1, "push while hidden");
    p.send({ t: "visibility", visible: true, dev: await subscriptionId(sub!.endpoint) });
    await sleep(50);
    d.send({ t: "send", req_id: "r3", session_id: sid, text: "three", urgency: "urgent" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r3"), "sent")).notify).toMatch(/app is open/);
    // A visible socket that stopped showing signs of life (half-open: no frame, no ping) stops counting.
    await withHub("wp-vis", (_h, state) => {
      for (const ws of state.getWebSockets("phone")) ws.serializeAttachment({ ...ws.deserializeAttachment(), seen: Date.now() - 80_000 });
    });
    d.send({ t: "send", req_id: "r4", session_id: sid, text: "four", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r4"), "sent")).notify).toBe("push notification sent to 1 phone");
    // ...but a keepalive ping answered by the runtime (auto-response, no wake-up) is a sign of life.
    p.ws.send("ping");
    await sleep(50);
    d.send({ t: "send", req_id: "r5", session_id: sid, text: "five", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r5"), "sent")).notify).toMatch(/app is open/);
    expect(calls.length).toBe(2);
  });

  it("per device: an open app suppresses only its own device's push; a socket opened in the background never does", async () => {
    const { d, sid } = await setup("wp-dev");
    const [mine, other] = await subscribed("wp-dev", 2);
    const calls = await fakePushService("wp-dev");
    const p = await phone("wp-dev", `?vis=1&dev=${await subscriptionId(mine!.endpoint)}`);
    await waitFor(() => last(p, "state"), "state");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "one", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r1"), "sent")).notify).toBe(
      "push notification sent to 1 phone; also shown in the app that is open",
    );
    expect(calls.map((c) => c.url)).toEqual([other!.endpoint]);
    p.ws.close();
    // Review round 1: a socket opened while the page was hidden (no ?vis=1) counts as hidden.
    const bg = await phone("wp-dev", `?dev=${await subscriptionId(mine!.endpoint)}`);
    await waitFor(() => last(bg, "state"), "state");
    await sleep(50);
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "two", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "sent")).notify).toBe("push notification sent to 2 phones");
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
    // The tool result reports what the push services said (sent only after they answered).
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r1"), "sent")).notify).toBe(
      "push notification sent to 1 phone of 3 (a phone's subscription had expired and was removed; the push service is busy (HTTP 429))",
    );
    await sleep(100);
    expect(calls.length).toBe(3); // nothing retried
    const left = await withHub("wp-gone", (_h, state) => state.storage.sql.exec("SELECT endpoint FROM push_subs").toArray().map((r) => r.endpoint));
    expect(left.sort()).toEqual([b!.endpoint, c!.endpoint].sort());
    d.send({ t: "send", req_id: "r2", session_id: sid, text: "y", urgency: "normal" });
    expect((await waitFor(() => d.frames.find((f) => f.req_id === "r2"), "sent")).notify).toBe("push notification sent to 1 phone");
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

  it("describes push outcomes for the tool result without overclaiming", () => {
    expect(describePushOutcomes([{ kind: "ok", status: 201 }])).toBe("push notification sent to 1 phone");
    expect(describePushOutcomes([{ kind: "rejected", status: 403 }])).toBe("no notification: the push service refused it (HTTP 403)");
    expect(describePushOutcomes([{ kind: "later", status: 0, retryAfterMs: 1 }])).toBe("no notification: the push service is busy or unreachable");
    expect(describePushOutcomes([{ kind: "rejected", status: -1 }])).toBe("no notification: the server's VAPID keys are invalid");
  });

  it("says why there is no notification when no phone has enabled them", async () => {
    const { d, sid } = await setup("wp-none");
    d.send({ t: "send", req_id: "r1", session_id: sid, text: "x", urgency: "urgent" });
    expect((await waitFor(() => last(d, "sent"), "sent")).notify).toMatch(/notifications are not enabled on any phone/);
  });
});

describe("on-demand location (D14): consent per request and per session", () => {
  const pos = (at = Date.now()) => ({ lat: 52.37, lon: 4.89, accuracy_m: 12, at });

  /** Daemon with two sessions (A, B) and a visible phone. */
  async function two(user: string) {
    const { token, machineId } = await newMachine(user);
    const d = await daemon(token);
    d.send({ t: "hello", v: 1, sessions: [{ session_id: "sA", project: "projA" }, { session_id: "sB", project: "projB" }] });
    await waitFor(() => last(d, "welcome"), "welcome");
    await sleep(50);
    const p = await phone(user);
    await waitFor(() => last(p, "state")?.sessions.length === 2, "online");
    return { d, p, machineId };
  }
  const ask = (d: Sock, rid: string, sid: string, max_age_s = 0, reason?: string) =>
    d.send({ t: "location_req", req_id: rid, session_id: sid, max_age_s, ...(reason ? { reason } : {}) });
  const prompt = (p: Sock, rid: string) => waitFor(() => p.frames.find((f) => f.t === "location_request" && f.request.rid === rid)?.request, `prompt ${rid}`);
  const answer = (d: Sock, rid: string) => waitFor(() => d.frames.find((f) => f.t === "location" && f.req_id === rid), `answer ${rid}`);

  it("open app: prompt, Share -> only the asking session gets it; location_wait carries no position", async () => {
    const { d, p } = await two("loc-app");
    ask(d, "a1", "sA", 0, "directions to the station");
    expect(await waitFor(() => last(d, "location_wait"), "wait")).toEqual({ t: "location_wait", req_id: "a1", via: "app" });
    const q = await prompt(p, "a1");
    expect(q).toMatchObject({ session_id: "sA", project: "projA", reason: "directions to the station" });
    expect(q.tok).toMatch(/^[\w-]{22}$/);
    p.send({ t: "location", rid: "a1", tok: q.tok, status: "ok", position: pos() });
    expect((await answer(d, "a1")).result).toMatchObject({ status: "ok", fresh: true, position: { lat: 52.37, lon: 4.89, accuracy_m: 12 } });
    expect(last(p, "location_done")).toEqual({ t: "location_done", rid: "a1", status: "ok" });
    expect(last(p, "settings").settings).toMatchObject({ location_project: "projA" });
    // The same session may reuse what it was given, within its max_age_s, without asking again...
    ask(d, "a2", "sA", 600);
    expect((await answer(d, "a2")).result).toMatchObject({ status: "ok", fresh: false });
    // ...but max_age_s is strict (0 = always ask) and another session never gets it: the user is asked.
    ask(d, "a3", "sA", 0);
    await prompt(p, "a3");
    ask(d, "b1", "sB", 86400);
    const qb = await prompt(p, "b1");
    expect(await waitFor(() => d.frames.find((f) => f.t === "location_wait" && f.req_id === "b1"), "wait b1")).toEqual({ t: "location_wait", req_id: "b1", via: "app" });
    // Review round 1 repro: B declined -> B gets nothing, not A's position.
    p.send({ t: "location", rid: "b1", tok: qb.tok, status: "denied" });
    expect((await answer(d, "b1")).result).toEqual({ status: "denied", position: null, fresh: false, message: "the user declined to share their location" });
  });

  it("answers for unknown, mismatched or already answered requests are refused and never stored", async () => {
    const { d, p } = await two("loc-rid");
    // Review round 1 repro: a made-up rid used to become last-known.
    p.send({ t: "location", rid: "made-up", tok: "x".repeat(22), status: "ok", position: pos() });
    await waitFor(() => last(p, "error")?.error.includes("expired or was already answered"), "refused");
    ask(d, "c1", "sA", 300);
    const q = await prompt(p, "c1"); // nothing usable was stored: the phone is asked
    p.send({ t: "location", rid: "c1", tok: "y".repeat(22), status: "ok", position: pos() });
    await waitFor(() => p.frames.filter((f) => f.t === "error").length === 2, "wrong tok refused");
    p.send({ t: "location", rid: "c1", tok: q.tok, status: "ok", position: pos(Date.now() + 3_600_000) });
    const r = await answer(d, "c1");
    expect(r.result.position.at).toBeLessThanOrEqual(Date.now()); // a clock running ahead is clamped
    p.send({ t: "location", rid: "c1", tok: q.tok, status: "ok", position: pos() });
    await waitFor(() => p.frames.filter((f) => f.t === "error").length === 3, "second answer refused");
    expect(d.frames.filter((f) => f.t === "location" && f.req_id === "c1").length).toBe(1);
    p.send({ t: "location", rid: "c1", tok: q.tok, status: "ok" });
    await waitFor(() => last(p, "error")?.error.includes("position is required"), "schema error");
  });

  it("no open app: push with the request token; the list of pending requests is sent on connect", async () => {
    const { d, sid } = await setup("loc-push");
    ask(d, "l0", sid);
    const nd = await answer(d, "l0");
    expect(nd.result).toMatchObject({ status: "no_device", position: null });
    const [sub] = await subscribed("loc-push");
    const calls = await fakePushService("loc-push");
    ask(d, "l1", sid, 0, "where am I?");
    expect(await waitFor(() => last(d, "location_wait"), "wait")).toEqual({ t: "location_wait", req_id: "l1", via: "push" });
    await waitFor(() => calls.length === 1, "push");
    expect(calls[0]!.headers).toMatchObject({ urgency: "high", ttl: "120" });
    const payload = (await decryptPush(sub!, calls[0]!.body)) as Record<string, string>;
    expect(payload).toMatchObject({ k: "l", r: "l1", s: sid, p: "proj", b: "where am I?" });
    // The tapped notification opens the app; the Hub lists the pending request (with the same token).
    const p = await phone("loc-push");
    const list = await waitFor(() => last(p, "location_pending"), "pending list");
    expect(list.requests).toEqual([expect.objectContaining({ rid: "l1", tok: payload.t, session_id: sid })]);
    p.send({ t: "location", rid: "l1", tok: payload.t, status: "ok", position: pos() });
    expect((await answer(d, "l1")).result.status).toBe("ok");
    p.send({ t: "location_list" });
    await waitFor(() => p.frames.filter((f) => f.t === "location_pending").length === 2, "second list");
    expect(last(p, "location_pending").requests).toEqual([]);
  });

  it("per device (review round 2): a visible tab without push still lets the phone get the location push", async () => {
    const { d, sid } = await setup("loc-dev");
    const [sub] = await subscribed("loc-dev");
    const calls = await fakePushService("loc-dev");
    const desk = await phone("loc-dev"); // visible, but no push device of its own (e.g. a desktop tab)
    await waitFor(() => last(desk, "state"), "state");
    ask(d, "l1", sid, 0, "near me");
    expect(await waitFor(() => last(d, "location_wait"), "wait")).toEqual({ t: "location_wait", req_id: "l1", via: "push" });
    await waitFor(() => calls.length === 1, "push to the phone");
    expect(calls[0]!.url).toBe(sub!.endpoint);
    expect(await prompt(desk, "l1")).toMatchObject({ session_id: sid }); // the open tab shows the prompt too
    // The device whose own app is visible gets no push; the prompt is in its app.
    const own = await phone("loc-dev", `?vis=1&dev=${await subscriptionId(sub!.endpoint)}`);
    await waitFor(() => last(own, "state"), "state");
    ask(d, "l2", sid, 0);
    expect(await waitFor(() => d.frames.find((f) => f.t === "location_wait" && f.req_id === "l2"), "wait 2")).toMatchObject({ via: "app" });
    await sleep(100);
    expect(calls.length).toBe(1);
  });

  it("disabled in Settings: refused, last-known and pending requests forgotten", async () => {
    const { d, p } = await two("loc-off");
    ask(d, "a1", "sA");
    const q = await prompt(p, "a1");
    p.send({ t: "location", rid: "a1", tok: q.tok, status: "ok", position: pos() });
    await answer(d, "a1");
    ask(d, "a2", "sA");
    const q2 = await prompt(p, "a2");
    p.send({ t: "settings", location: false });
    await waitFor(() => last(p, "settings")?.settings.location === false, "off");
    expect(last(p, "settings").settings.location_at).toBeNull();
    expect(await withHub("loc-off", (_h, s) => s.storage.sql.exec("SELECT k FROM meta WHERE k = 'loc' UNION ALL SELECT rid FROM loc_req").toArray())).toEqual([]);
    ask(d, "a3", "sA", 86400);
    expect((await answer(d, "a3")).result).toMatchObject({ status: "disabled", position: null });
    p.send({ t: "location", rid: "a2", tok: q2.tok, status: "ok", position: pos() });
    await waitFor(() => last(p, "error")?.error.includes("expired"), "refused");
  });

  it("last-known expires after 6 h (and is deleted); phone-asking requests are rate limited", async () => {
    const { d, p } = await two("loc-old");
    ask(d, "a1", "sA");
    const q = await prompt(p, "a1");
    p.send({ t: "location", rid: "a1", tok: q.tok, status: "ok", position: pos(Date.now() - 7 * 3600_000) });
    await answer(d, "a1");
    ask(d, "a2", "sA", 86400);
    await prompt(p, "a2"); // 7 h old: not reused
    expect(await withHub("loc-old", (_h, s) => s.storage.sql.exec("SELECT k FROM meta WHERE k = 'loc'").toArray())).toEqual([]);
    await setLimits("loc-old", { location: { burst: 1, per: 1, perMs: 3_600_000 } });
    ask(d, "a3", "sA");
    await prompt(p, "a3");
    ask(d, "a4", "sA");
    const r = await answer(d, "a4");
    expect(r.result).toMatchObject({ status: "rate_limited", position: null });
    expect(r.result.message).toMatch(/too many location requests/);
  });

  it("survives the Hub hibernating between the request and the answer", async () => {
    const { d, p } = await two("loc-evict");
    ask(d, "a1", "sA");
    const q = await prompt(p, "a1");
    await evictDurableObject(E.HUB.get(E.HUB.idFromName(tenantIdForDev("loc-evict"))));
    p.send({ t: "location", rid: "a1", tok: q.tok, status: "ok", position: pos() });
    expect((await answer(d, "a1")).result.status).toBe("ok");
  });
});
