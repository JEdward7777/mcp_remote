// Service worker of the PWA (D11, Phase 4). Bundled to public/sw.js by build-web.mjs, which injects
// __SW_VERSION__ (a hash of every app-shell file, so any change makes the browser see a new worker)
// and __SHELL__ (the files to precache).
//
// - App shell: precached per version, served cache-first so the app opens offline; old versions'
//   caches are deleted on activate. /api/*, /auth/* and WebSockets are never touched (no respondWith).
// - Updates: a new version waits (no skipWaiting on install) until the page asks for it (its
//   "new version available -> Reload" banner), so an open page never mixes old and new files.
// - Web Push: shows the notification the Hub's payload describes; a click focuses (or opens) the app
//   on the right session thread, or on the location request it is about.
export {};
declare const self: ServiceWorkerGlobalScope;
declare const __SW_VERSION__: string;
declare const __SHELL__: string[];

const PREFIX = "mr-shell-";
const CACHE = `${PREFIX}${__SW_VERSION__}`;
const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";
const SID = /^[A-Za-z0-9_-]{1,64}$/;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(__SHELL__.map((u) => new Request(u, { cache: "reload", credentials: "same-origin" })))),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  const d = e.data as { t?: string } | null;
  if (d?.t === "skip-waiting") void self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API, auth or socket traffic: they always go to the network as if there were no worker.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
  const isPage = req.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html");
  if (!isPage && !__SHELL__.includes(url.pathname)) return;
  const key = isPage ? "/" : url.pathname;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(key);
      if (hit) return hit;
      // Evicted by the browser (storage pressure): fetch and put it back.
      const res = await fetch(req);
      if (res.ok && res.type === "basic") await cache.put(key, res.clone()).catch(() => {});
      return res;
    })(),
  );
});

// ---------------------------------------------------------------------------
// Web Push

interface Payload {
  k?: string;
  s?: string;
  u?: string;
  i?: number;
  p?: string;
  b?: string;
  r?: string;
  t?: string;
}

function clip(s: unknown, n: number): string | undefined {
  return typeof s === "string" && s ? Array.from(s).slice(0, n).join("") : undefined;
}

self.addEventListener("push", (e) => {
  let d: Payload | null = null;
  try {
    d = (e.data?.json() as Payload) ?? null;
  } catch {
    d = null;
  }
  e.waitUntil(show(d));
});

async function show(d: Payload | null): Promise<void> {
  const reg = self.registration;
  if (d?.k === "l" && typeof d.r === "string" && typeof d.t === "string" && typeof d.s === "string" && SID.test(d.s)) {
    // The request's token goes into the URL: only a tap on this notification shares without a second
    // prompt (the app checks it against the Hub's list of pending requests before reading the GPS).
    const q = new URLSearchParams({ loc: d.r.slice(0, 64), tok: d.t.slice(0, 64) });
    const project = clip(d.p, 64);
    const why = clip(d.b, 100);
    await reg.showNotification("Claude wants your location", {
      body: project ? `${project}${why ? `: ${why}` : ""}. Tap to share it once with this session.` : "Tap to share it once, or ignore this.",
      tag: `loc:${d.r.slice(0, 64)}`,
      requireInteraction: true,
      icon: ICON,
      badge: BADGE,
      data: { url: `/?${q.toString()}#/s/${d.s}` },
      actions: [
        { action: "share", title: "Share location" },
        { action: "dismiss", title: "Not now" },
      ],
    } as NotificationOptions);
    return;
  }
  if (d?.k === "m" && typeof d.s === "string" && SID.test(d.s)) {
    const urgent = d.u === "urgent";
    await reg.showNotification(clip(d.p, 64) ?? "mcp remote", {
      body: clip(d.b, 100) ?? (urgent ? "Urgent: a session needs you" : "New message from a session"),
      // One notification per session: a newer message replaces the older one. Urgent ones buzz again
      // and stay until dismissed; normal ones update quietly if one is already showing.
      tag: `s:${d.s}`,
      renotify: urgent,
      requireInteraction: urgent,
      silent: false,
      icon: ICON,
      badge: BADGE,
      timestamp: Date.now(),
      data: { url: `/#/s/${d.s}` },
      ...(urgent ? { vibrate: [200, 100, 200, 100, 200] } : {}),
    } as NotificationOptions);
    return;
  }
  // Unknown payload: a push must always show something (userVisibleOnly).
  await reg.showNotification("mcp remote", { body: "New activity", tag: "generic", icon: ICON, badge: BADGE, data: { url: "/" } });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  if (e.action === "dismiss") return;
  const raw = (e.notification.data as { url?: string } | null)?.url ?? "/";
  // Only ever our own origin.
  const target = new URL(raw, self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const w = wins.find((c) => new URL(c.url).origin === self.location.origin) as WindowClient | undefined;
      if (w) {
        await w.focus().catch(() => w);
        w.postMessage({ t: "open", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// The push service rotated the subscription: subscribe again with the same key and tell the server.
self.addEventListener("pushsubscriptionchange", (ev) => {
  const e = ev as ExtendableEvent & { oldSubscription?: PushSubscription | null };
  e.waitUntil(
    (async () => {
      const old = e.oldSubscription ?? null;
      const key = old?.options?.applicationServerKey;
      if (!key) return; // the page re-subscribes when it is next opened
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const post = (method: string, body: unknown) =>
        fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      await post("POST", sub.toJSON());
      if (old && old.endpoint !== sub.endpoint) await post("DELETE", { endpoint: old.endpoint });
    })().catch(() => {}),
  );
});
