// The built service worker (public/sw.js), run in a node:vm sandbox with fake browser APIs: what it
// caches, what it never touches (/api, /auth), which notification each push payload becomes (D19),
// and that a notification click only ever opens our own origin.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";

const SRC = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
const ORIGIN = "https://app.example";

type Handler = (e: any) => void;

function load() {
  const handlers = new Map<string, Handler>();
  const shown: { title: string; opts: any }[] = [];
  const opened: string[] = [];
  const posted: any[] = [];
  const cacheStore = new Map<string, Map<string, unknown>>();
  const windows: any[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, h: Handler) => handlers.set(t, h),
    skipWaiting: async () => {},
    registration: {
      showNotification: async (title: string, opts: any) => void shown.push({ title, opts }),
      pushManager: { subscribe: async () => ({ endpoint: "x", toJSON: () => ({}) }) },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (u: string) => void opened.push(u),
    },
  };
  const caches = {
    open: async (name: string) => {
      const m = cacheStore.get(name) ?? new Map();
      cacheStore.set(name, m);
      return {
        addAll: async (reqs: { url: string }[]) => reqs.forEach((r) => m.set(new URL(r.url, ORIGIN).pathname, `cached ${r.url}`)),
        match: async (k: string) => m.get(k),
        put: async (k: string, v: unknown) => void m.set(k, v),
      };
    },
    keys: async () => [...cacheStore.keys()],
    delete: async (k: string) => cacheStore.delete(k),
  };
  class FakeRequest {
    constructor(
      readonly url: string,
      readonly init?: unknown,
    ) {}
  }
  runInNewContext(SRC, { self, caches, URL, URLSearchParams, Request: FakeRequest, fetch: async () => ({ ok: true, type: "basic", clone: () => ({}) }), console });
  const fire = async (type: string, e: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    let responded: Promise<unknown> | null = null;
    handlers.get(type)!({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p), respondWith: (p: Promise<unknown>) => (responded = p) });
    await Promise.all(waits);
    return { responded: responded as Promise<unknown> | null };
  };
  const push = (payload: unknown) => fire("push", { data: { json: () => payload } });
  return { handlers, shown, opened, posted, windows, cacheStore, fire, push };
}

let sw: ReturnType<typeof load>;
beforeEach(() => {
  sw = load();
});

describe("service worker: app shell", () => {
  it("precaches the shell under a versioned cache and deletes older versions on activate", async () => {
    sw.cacheStore.set("mr-shell-old", new Map());
    sw.cacheStore.set("unrelated", new Map());
    await sw.fire("install", {});
    const [name] = [...sw.cacheStore.keys()].filter((k) => k.startsWith("mr-shell-") && k !== "mr-shell-old");
    expect(name).toMatch(/^mr-shell-[0-9a-f]{16}$/);
    expect([...sw.cacheStore.get(name!)!.keys()]).toEqual(expect.arrayContaining(["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icons/badge-96.png"]));
    await sw.fire("activate", {});
    expect([...sw.cacheStore.keys()].sort()).toEqual([name, "unrelated"].sort());
  });

  it("serves the app offline from the cache, never touches /api, /auth, other origins or non-GET", async () => {
    await sw.fire("install", {});
    const req = (url: string, extra: Record<string, unknown> = {}) => ({ request: { method: "GET", url, mode: "no-cors", ...extra } });
    expect((await sw.fire("fetch", req(`${ORIGIN}/`, { mode: "navigate" }))).responded).not.toBeNull();
    expect(await (await sw.fire("fetch", req(`${ORIGIN}/?loc=1&m=a&s=b`, { mode: "navigate" }))).responded).toBe(`cached /`);
    expect(await (await sw.fire("fetch", req(`${ORIGIN}/app.js`))).responded).toBe("cached /app.js");
    for (const u of [`${ORIGIN}/api/me`, `${ORIGIN}/api/ws`, `${ORIGIN}/auth/login`, `${ORIGIN}/auth/callback?code=x`, "https://other.example/app.js", `${ORIGIN}/unknown.png`]) {
      expect((await sw.fire("fetch", req(u, u.includes("/auth/") ? { mode: "navigate" } : {}))).responded, u).toBeNull();
    }
    expect((await sw.fire("fetch", req(`${ORIGIN}/app.js`, { method: "POST" }))).responded).toBeNull();
  });
});

describe("service worker: Web Push -> notification (D19)", () => {
  it("normal message: project + preview, one notification per session that updates quietly", async () => {
    await sw.push({ k: "m", s: "sess-1", u: "normal", i: 5, p: "myproj", b: "All tests pass." });
    expect(sw.shown).toHaveLength(1);
    const { title, opts } = sw.shown[0]!;
    expect(title).toBe("myproj");
    expect(opts).toMatchObject({ body: "All tests pass.", tag: "s:sess-1", renotify: false, requireInteraction: false, data: { url: "/#/s/sess-1" } });
    expect(opts.badge).toBe("/icons/badge-96.png");
    expect(opts.vibrate).toBeUndefined();
  });

  it("urgent message: buzzes again and stays until dismissed; without preview nothing about the content", async () => {
    await sw.push({ k: "m", s: "sess-1", u: "urgent", i: 6 });
    const { title, opts } = sw.shown[0]!;
    expect(title).toBe("mcp remote");
    expect(opts).toMatchObject({ body: "Urgent: a session needs you", renotify: true, requireInteraction: true });
    expect(opts.vibrate?.length).toBeGreaterThan(0);
  });

  it("location request: asks to tap, opens the app on the request; bad ids fall back to a generic notification", async () => {
    await sw.push({ k: "l", r: "l0123abcd", m: "mach1", s: "sess-1", p: "trip", b: "directions" });
    const { title, opts } = sw.shown[0]!;
    expect(title).toBe("Claude wants your location");
    expect(opts.body).toBe("trip: directions. Tap to share it once.");
    expect(opts.data.url).toBe("/?loc=l0123abcd&m=mach1&s=sess-1#/s/sess-1");
    expect(opts.actions.map((a: { action: string }) => a.action)).toEqual(["share", "dismiss"]);
    await sw.push({ k: "m", s: "../../evil", u: "normal", i: 1 });
    await sw.push("not json at all");
    expect(sw.shown.slice(1).map((n) => [n.title, n.opts.data.url])).toEqual([
      ["mcp remote", "/"],
      ["mcp remote", "/"],
    ]);
  });

  it("a click focuses the open app (and tells it where to go) or opens it; never another origin", async () => {
    const click = (url: string, action = "") => sw.fire("notificationclick", { action, notification: { close: () => {}, data: { url } } });
    await click("/#/s/sess-1");
    expect(sw.opened).toEqual([`${ORIGIN}/#/s/sess-1`]);
    await click("https://evil.example/phish");
    expect(sw.opened[1]).toBe(`${ORIGIN}/`);
    await click("/#/s/x", "dismiss");
    expect(sw.opened).toHaveLength(2);
    const msgs: unknown[] = [];
    let focused = false;
    sw.windows.push({ url: `${ORIGIN}/#/`, focus: async () => void (focused = true), postMessage: (m: unknown) => msgs.push(m) });
    await click("/?loc=r1&m=m1&s=s1#/s/s1");
    expect(focused).toBe(true);
    expect(msgs).toEqual([{ t: "open", url: `${ORIGIN}/?loc=r1&m=m1&s=s1#/s/s1` }]);
    expect(sw.opened).toHaveLength(2);
  });
});
