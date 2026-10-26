// PWA plumbing (Phase 4): service worker registration + update flow, Web Push subscription, install
// prompt and geolocation. DOM-only helpers; app.ts owns the UI.

export interface UpdateHooks {
  /** A new version is installed and waiting: show "Reload". */
  onUpdateReady: (apply: () => void) => void;
  /** The service worker forwarded a notification click ("open this URL"). */
  onOpen: (url: string) => void;
}

let registration: ServiceWorkerRegistration | null = null;
let lastUpdateCheck = 0;

export function swSupported(): boolean {
  return "serviceWorker" in navigator;
}

export async function registerServiceWorker(hooks: UpdateHooks): Promise<void> {
  if (!swSupported()) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only reload for an update the user asked for (see apply()): not on the very first install.
    if (reloading) location.reload();
  });
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { t?: string; url?: string } | null;
    if (d?.t === "open" && typeof d.url === "string") hooks.onOpen(d.url);
  });
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return; // e.g. a private window: the app still works, just not offline and without notifications
  }
  const reg = registration;
  const offer = (w: ServiceWorker) =>
    hooks.onUpdateReady(() => {
      reloading = true;
      w.postMessage({ t: "skip-waiting" });
    });
  if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    if (!w) return;
    w.addEventListener("statechange", () => {
      // "installed" with an existing controller = an update (not the first install).
      if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
    });
  });
}

/** Ask the browser to look for a new version, at most once an hour (on returning to the app; no polling). */
export function checkForUpdate(): void {
  if (!registration || Date.now() - lastUpdateCheck < 3_600_000) return;
  lastUpdateCheck = Date.now();
  void registration.update().catch(() => {});
}

// ---------------------------------------------------------------------------
// Web Push

export type PushState =
  | { kind: "unsupported"; why: string }
  | { kind: "off"; permission: NotificationPermission }
  | { kind: "on"; sub: PushSubscription };

export function pushSupported(): string | null {
  if (!swSupported()) return "this browser has no service workers";
  if (!("PushManager" in window)) return "this browser does not support Web Push";
  if (!("Notification" in window)) return "this browser does not support notifications";
  return null;
}

export async function pushState(): Promise<PushState> {
  const why = pushSupported();
  if (why) return { kind: "unsupported", why };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") return { kind: "on", sub };
  return { kind: "off", permission: Notification.permission };
}

export function b64uToBytes(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const k = sub.options.applicationServerKey;
  if (!k) return false;
  const a = new Uint8Array(k);
  const b = b64uToBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Same id the server uses: first 16 hex chars of sha256(endpoint). */
export async function subscriptionId(endpoint: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(method: "POST" | "DELETE", body: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(
    () => null,
  );
  if (!r) return { ok: false, error: "Not connected; try again in a moment." };
  if (r.ok) return { ok: true };
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: j.error ?? `HTTP ${r.status}` };
}

/** Turn notifications on for this phone (asks for permission). Returns an error sentence or null. */
export async function enablePush(key: string): Promise<string | null> {
  const why = pushSupported();
  if (why) return `Notifications are not available: ${why}.`;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return perm === "denied"
      ? "Notifications are blocked for this site. Allow them in Chrome: site settings (lock icon) > Notifications, then try again."
      : "Notifications were not allowed.";
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) as BufferSource });
  const r = await api("POST", sub.toJSON());
  return r.ok ? null : `Could not register this phone for notifications: ${r.error}`;
}

export async function disablePush(): Promise<string | null> {
  if (pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const r = await api("DELETE", { endpoint: sub.endpoint });
  await sub.unsubscribe().catch(() => false);
  return r.ok ? null : `This phone stopped notifications, but the server could not be told: ${r.error}`;
}

/**
 * Once per page load: if this browser's subscription was made with another server key (the VAPID keys
 * were replaced), make a new one and register it. A device that was removed from the account's list
 * (e.g. from another phone) is NOT re-added behind the user's back: Settings offers "Turn on".
 */
let healed = false;
export async function healPush(key: string | null): Promise<void> {
  if (healed || !key || pushSupported() || Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub || sameKey(sub, key)) return;
  healed = true;
  await enablePush(key);
}

/** This browser's push subscription id, if it has one and notifications are allowed. */
export async function currentDeviceId(): Promise<string | null> {
  if (pushSupported() || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? subscriptionId(sub.endpoint) : null;
}

/** Remove another device (by id, e.g. a lost phone) or every device from the account. */
export async function removeDevices(id: string | "all"): Promise<string | null> {
  const r = await api("DELETE", id === "all" ? { all: true } : { id });
  if (!r.ok) return `Could not remove: ${r.error}`;
  if (id === "all" && !pushSupported()) {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe().catch(() => false);
  }
  return null;
}

/** Close "Claude wants your location" notifications whose request is answered or gone. */
export async function closeLocNotifications(close: (rid: string) => boolean): Promise<void> {
  if (!swSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  for (const n of await reg.getNotifications()) if (n.tag.startsWith("loc:") && close(n.tag.slice(4))) n.close();
}

// ---------------------------------------------------------------------------
// Install prompt (Chrome on Android fires beforeinstallprompt when the app is installable)

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let installEvent: InstallPromptEvent | null = null;
export function watchInstallPrompt(onChange: () => void): void {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as InstallPromptEvent;
    onChange();
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    onChange();
  });
}
export function canInstall(): boolean {
  return installEvent !== null;
}
export async function install(): Promise<void> {
  const e = installEvent;
  installEvent = null;
  await e?.prompt();
}
export function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

// ---------------------------------------------------------------------------
// Geolocation (on demand only, D14)

export type GeoAnswer =
  | { status: "ok"; position: { lat: number; lon: number; accuracy_m: number | null; at: number } }
  | { status: "denied" | "unavailable"; message: string };

export function getPosition(): Promise<GeoAnswer> {
  if (!("geolocation" in navigator)) return Promise.resolve({ status: "unavailable", message: "this browser has no location support" });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          status: "ok",
          position: {
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            accuracy_m: Number.isFinite(p.coords.accuracy) ? Math.min(p.coords.accuracy, 1e7) : null,
            at: Math.round(p.timestamp || Date.now()),
          },
        }),
      (err) =>
        resolve(
          err.code === err.PERMISSION_DENIED
            ? { status: "denied", message: "Location is blocked for this site (Chrome site settings > Location)." }
            : { status: "unavailable", message: err.code === err.TIMEOUT ? "No location fix in time." : "The phone could not get a location." },
        ),
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 30_000 },
    );
  });
}
