// Phone PWA (no framework). Bundled to public/app.js by build-web.mjs.
import type {
  HubToPhone,
  LaunchRecord,
  LaunchState,
  MachineRecord,
  MessageRecord,
  PhoneToHub,
  SessionRecord,
  Settings,
  Urgency,
  UsageInfo,
} from "@mcp-remote/shared";
import { backoffDelay } from "@mcp-remote/shared/backoff";
import { parseRetryAfter, realClock } from "@mcp-remote/shared/link";
import { linkify } from "@mcp-remote/shared/links";
import { type AuthCheck, PhoneLink, type SocketLike } from "./link";
import {
  canInstall,
  checkForUpdate,
  disablePush,
  enablePush,
  getPosition,
  healPush,
  install,
  isStandalone,
  pushState,
  pushSupported,
  registerServiceWorker,
  watchInstallPrompt,
} from "./pwa";

interface Me {
  tenant: string;
  email: string;
  name: string | null;
  dev: boolean;
  /** VAPID public key for Web Push; null when the server has no keys configured. */
  push_key?: string | null;
}

/** A location request from a session (D14) waiting for the user's Share / Not now. */
interface LocRequest {
  rid: string;
  machine_id: string;
  session_id: string;
  project: string;
  reason: string | null;
}

const state = {
  me: null as Me | null,
  machines: [] as MachineRecord[],
  sessions: [] as SessionRecord[],
  threads: new Map<string, MessageRecord[]>(),
  hasMore: new Map<string, boolean>(),
  connected: false,
  /** Today's usage for this account (Phase 3), from state frames; messages bumped locally between them. */
  usage: null as UsageInfo | null,
  /** Account settings (notifications, location), from the Hub. */
  settings: null as Settings | null,
  /** Open location requests, newest last. */
  locRequests: new Map<string, LocRequest>(),
  /** Location requests being answered right now (waiting for the GPS fix). */
  sharing: new Set<string>(),
  /** Set when a new app version is installed and waiting: applies it (the page reloads). */
  applyUpdate: null as (() => void) | null,
};

/** A location request opened from a notification, answered as soon as the socket is up (the tap was the consent). */
let autoShare: LocRequest | null = null;

/** Retry counter for boot() when the server can't be reached at all. */
let attempt = 0;
let clientSeq = 0;
/** Random per-page prefix so client_ids from other tabs/devices (echoed to all phones) never collide. */
const pageId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
/** Sends waiting for the Hub's echo; the draft is only cleared once the echo arrives. */
const pendingSends = new Map<string, { sid: string; text: string }>();
/** Launch requests waiting for the daemon's answer; their buttons stay disabled meanwhile. */
const pendingLaunchOps = new Map<string, { machine: string; launch: string | null }>();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

function nodes(...items: (Node | string | null | undefined)[]): (Node | string)[] {
  return items.filter((x): x is Node | string => x !== null && x !== undefined);
}

function fmtTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Message text with Google Maps links / geo: URIs as tappable links; everything else stays plain text. */
function messageText(text: string): (Node | string)[] {
  return linkify(text).map((seg) => {
    if (!seg.href) return seg.text;
    const a = h("a", { class: "maplink", href: seg.href, rel: "noopener noreferrer" }, seg.text);
    if (seg.kind === "map") a.setAttribute("target", "_blank");
    return a;
  });
}

function urgencyBadge(u: Urgency | null): HTMLElement | null {
  if (!u) return null;
  const label = u === "urgent" ? "URGENT" : u === "silent" ? "fyi" : "normal";
  return h("span", { class: `badge u-${u}`, title: `urgency: ${u}` }, label);
}

// ---------------------------------------------------------------------------
// Networking

function send(frame: PhoneToHub): boolean {
  return link.send(JSON.stringify(frame));
}

/** Before each reconnect: a Worker-only request (no Durable Object) that tells signed-out / throttled apart. */
async function checkAuth(): Promise<AuthCheck> {
  const r = await fetch("/api/me");
  if (r.status === 401) return "signed_out";
  if (r.status === 429) return { rateLimited: true, retryAfterMs: parseRetryAfter(r.headers.get("retry-after")) };
  if (r.status >= 500) return { serverError: true, retryAfterMs: parseRetryAfter(r.headers.get("retry-after")) };
  return "ok";
}

const link = new PhoneLink({
  url: () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`,
  open: (url) => new WebSocket(url) as unknown as SocketLike,
  clock: realClock,
  isVisible: () => document.visibilityState === "visible",
  checkAuth,
  onOpen: () => {
    attempt = 0;
    state.connected = true;
    renderStatus();
    if (autoShare) {
      const req = autoShare;
      autoShare = null;
      void shareLocation(req);
    }
    // Anything may have happened while we were disconnected: drop every cached thread except the
    // visible one (refetched now; the fresh copy wins on merge) so others reload when opened.
    const sid = currentSession();
    for (const k of [...state.threads.keys()]) if (k !== sid) state.threads.delete(k);
    if (sid) send({ t: "history", session_id: sid });
  },
  onFrame: (data) => {
    let f: HubToPhone;
    try {
      f = JSON.parse(data) as HubToPhone;
    } catch {
      return;
    }
    onFrame(f);
  },
  onDown: () => {
    state.connected = false;
    if (pendingSends.size) {
      // Unconfirmed sends: keep the text in the compose box so nothing typed is lost.
      pendingSends.clear();
      toast("Connection lost before the message was confirmed; it is still in the box.");
      render();
    }
    if (pendingLaunchOps.size) {
      pendingLaunchOps.clear();
      render();
    }
    renderStatus();
  },
  onSignedOut: () => void boot(),
});

// Android: a backgrounded PWA's socket may be dead or half-open when it comes back.
document.addEventListener("visibilitychange", () => {
  if (!state.me) return;
  const visible = document.visibilityState === "visible";
  // While no visible app is connected, the Hub notifies by Web Push instead (D19).
  if (link.connected) send({ t: "visibility", visible });
  if (visible) {
    link.wake();
    checkForUpdate();
  }
});
window.addEventListener("online", () => state.me && link.wake());
window.addEventListener("pageshow", () => state.me && link.wake());

function onFrame(f: HubToPhone): void {
  switch (f.t) {
    case "state":
      state.machines = f.machines;
      state.sessions = f.sessions;
      if (f.usage) state.usage = f.usage;
      if (f.settings) onSettings(f.settings);
      // Drop cached threads of sessions the Hub no longer has (e.g. a confirmed Forget).
      for (const k of [...state.threads.keys()]) {
        if (!f.sessions.some((x) => x.session_id === k)) state.threads.delete(k);
      }
      render();
      return;
    case "message": {
      const pend = f.client_id ? pendingSends.get(f.client_id) : undefined;
      if (f.client_id && pend) {
        pendingSends.delete(f.client_id);
        // Clear the draft only if the user hasn't kept typing since.
        if ((drafts.get(pend.sid) ?? "").trim() === pend.text) {
          drafts.delete(pend.sid);
          if (threadView?.sid === pend.sid) threadView.ta.value = "";
        }
      }
      const list = state.threads.get(f.message.session_id);
      const isNew = !list || !list.some((m) => m.id === f.message.id);
      if (list && isNew) list.push(f.message);
      // Every stored message reaches every phone once: count it towards today's usage line.
      if (isNew && state.usage && state.usage.day === utcToday()) state.usage.messages++;
      const s = state.sessions.find((x) => x.session_id === f.message.session_id);
      if (s) {
        s.last_message_at = f.message.created_at;
        if (f.message.direction === "out") s.last_urgency = f.message.urgency;
        else if (!f.message.delivered) s.pending_in++;
      }
      if (f.message.direction === "out" && f.message.urgency === "urgent" && "vibrate" in navigator) {
        navigator.vibrate?.([200, 100, 200]);
      }
      render();
      return;
    }
    case "history": {
      const existing = state.threads.get(f.session_id) ?? [];
      const byId = new Map<number, MessageRecord>();
      // Server copy last so it overrides stale cached fields (e.g. delivered).
      for (const m of [...existing, ...f.messages]) byId.set(m.id, m);
      state.threads.set(
        f.session_id,
        [...byId.values()].sort((a, b) => a.id - b.id),
      );
      state.hasMore.set(f.session_id, f.has_more);
      render();
      return;
    }
    case "delivered": {
      const list = state.threads.get(f.session_id);
      if (list) for (const m of list) if (f.ids.includes(m.id)) m.delivered = true;
      const ds = state.sessions.find((x) => x.session_id === f.session_id);
      if (ds) ds.pending_in = Math.max(0, ds.pending_in - f.ids.length);
      render();
      return;
    }
    case "error":
      if (f.client_id) pendingSends.delete(f.client_id);
      toast(f.error);
      render();
      return;
    case "launches": {
      const m = state.machines.find((x) => x.machine_id === f.machine_id);
      if (m?.launch) {
        const before = new Map(m.launch.launches.map((l) => [l.launch_id, l.state]));
        m.launch.launches = f.launches;
        // A session that just started needing the user at the desk deserves a buzz.
        if (f.launches.some((l) => l.state === "needs_attention" && before.get(l.launch_id) !== "needs_attention")) {
          navigator.vibrate?.([100, 60, 100]);
        }
      }
      render();
      return;
    }
    case "launch_result": {
      const mine = pendingLaunchOps.delete(f.client_id);
      if (mine && !f.ok) toast(f.error ?? "The computer refused the request");
      if (mine) render();
      return;
    }
    case "settings":
      onSettings(f.settings);
      render();
      return;
    case "location_request":
      state.locRequests.set(f.rid, { rid: f.rid, machine_id: f.machine_id, session_id: f.session_id, project: f.project, reason: f.reason });
      if (document.visibilityState === "visible") navigator.vibrate?.([80, 60, 80]);
      render();
      return;
    case "location_done":
      if (state.locRequests.delete(f.rid)) render();
      return;
  }
}

function onSettings(s: Settings): void {
  state.settings = s;
  void healPush(state.me?.push_key ?? null, s.push_devices).catch(() => {});
}

// ---------------------------------------------------------------------------
// Location (D14): only ever in answer to a request, after the user taps Share (or a notification).

async function shareLocation(req: LocRequest): Promise<void> {
  if (state.sharing.has(req.rid)) return;
  state.sharing.add(req.rid);
  render();
  const r = await getPosition();
  state.sharing.delete(req.rid);
  state.locRequests.delete(req.rid);
  const base = { t: "location" as const, rid: req.rid, machine_id: req.machine_id, session_id: req.session_id };
  const ok = send(r.status === "ok" ? { ...base, status: "ok", position: r.position } : { ...base, status: r.status });
  if (!ok) toast("Not connected; the location was not sent.");
  else toast(r.status === "ok" ? `Location shared with ${req.project || "the session"}.` : r.message);
  render();
}

function declineLocation(req: LocRequest): void {
  state.locRequests.delete(req.rid);
  send({ t: "location", rid: req.rid, machine_id: req.machine_id, session_id: req.session_id, status: "denied" });
  render();
}

/** A URL from a notification click (or the page's own address): `?loc=<rid>&m=<machine>&s=<session>`. */
function takeLocationParams(url: URL): void {
  const rid = url.searchParams.get("loc");
  const m = url.searchParams.get("m");
  const sid = url.searchParams.get("s");
  if (!rid || !m || !sid || !/^[A-Za-z0-9_-]{1,64}$/.test(m) || !/^[A-Za-z0-9_-]{1,64}$/.test(sid) || rid.length > 64) return;
  const project = state.sessions.find((x) => x.session_id === sid)?.project ?? "";
  const req: LocRequest = { rid, machine_id: m, session_id: sid, project, reason: null };
  if (link.connected) void shareLocation(req);
  else autoShare = req;
}

function openFromNotification(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw, location.origin);
  } catch {
    return;
  }
  if (url.origin !== location.origin) return;
  takeLocationParams(url);
  if (url.hash && url.hash !== location.hash) location.hash = url.hash;
}

// ---------------------------------------------------------------------------
// Routing

function currentSession(): string | null {
  const m = /^#\/s\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  return m ? m[1]! : null;
}

window.addEventListener("hashchange", () => {
  const sid = currentSession();
  if (sid && !state.threads.has(sid)) send({ t: "history", session_id: sid });
  render(true);
});

// ---------------------------------------------------------------------------
// Rendering

function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 4000);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Today: 12 of 500 messages" (UTC day, phone + agent together). */
function usageText(): string {
  const u = state.usage;
  if (!u) return "";
  const today = u.day === utcToday();
  const n = today ? u.messages : 0;
  const line = `Today (UTC): ${n} of ${u.message_cap} messages on the ${u.plan} plan`;
  // A used-up daily budget blocks everything until midnight: say so instead of failing silently.
  return today && u.blocked ? `${line}. ${u.blocked[0]!.toUpperCase()}${u.blocked.slice(1)}.` : line;
}

function renderStatus(): void {
  const el = document.querySelector("#conn");
  if (!el) return;
  el.className = state.connected ? "dot on" : "dot off";
  el.setAttribute("title", state.connected ? "connected" : "reconnecting...");
}

function machineName(id: string): string {
  return state.machines.find((m) => m.machine_id === id)?.name ?? "unknown machine";
}

// ---------------------------------------------------------------------------
// Remote launch (D6)

const STATE_LABEL: Record<LaunchState, string> = {
  starting: "starting\u2026",
  running: "running",
  needs_attention: "NEEDS YOU AT THE DESK",
  exited: "exited",
  failed: "failed",
};
const ACTIVE_STATES: LaunchState[] = ["starting", "running", "needs_attention"];

function launchFor(sid: string): { machine: MachineRecord; launch: LaunchRecord } | null {
  for (const m of state.machines) {
    const l = m.launch?.launches.find((x) => x.session_id === sid);
    if (l) return { machine: m, launch: l };
  }
  return null;
}

function launchBusy(machine: string, launch: string | null): boolean {
  for (const p of pendingLaunchOps.values()) if (p.machine === machine && p.launch === launch) return true;
  return false;
}

function launchOp(frame: PhoneToHub & { client_id: string; machine_id: string }, launch: string | null): void {
  if (!send(frame)) {
    toast("Not connected; try again in a moment.");
    return;
  }
  pendingLaunchOps.set(frame.client_id, { machine: frame.machine_id, launch });
  // The computer may drop off before answering; don't leave the buttons disabled forever.
  window.setTimeout(() => {
    if (pendingLaunchOps.delete(frame.client_id)) {
      toast("No answer from the computer; check its state and try again.");
      render();
    }
  }, 45_000);
  render();
}

function newClientId(): string {
  return `${pageId}-${++clientSeq}`;
}

function stateBadge(l: LaunchRecord): HTMLElement {
  const code = l.state === "exited" && l.exit_code !== null ? ` (${l.exit_code})` : "";
  return h("span", { class: `badge st-${l.state}`, title: `launch state: ${l.state}` }, STATE_LABEL[l.state] + code);
}

/** Stop / Restart / Restart --continue / Remove for one launch. */
function launchButtons(m: MachineRecord, l: LaunchRecord): HTMLElement {
  const box = h("div", { class: "launch-actions" });
  const off = !m.online || m.revoked || launchBusy(m.machine_id, l.launch_id);
  const active = ACTIVE_STATES.includes(l.state);
  const mk = (label: string, cls: string, enabled: boolean, onclick: () => void) => {
    const b = h("button", { class: `small ${cls}`, type: "button" }, label);
    b.disabled = off || !enabled;
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onclick();
    };
    box.append(b);
  };
  const restart = (cont: boolean) => {
    if (active && !confirm(`Restart ${l.project}? The running Claude Code session is ended first.`)) return;
    launchOp({ t: "launch_restart", machine_id: m.machine_id, launch_id: l.launch_id, continue: cont, client_id: newClientId() }, l.launch_id);
  };
  const pendingRestart = l.state === "exited" && !!l.detail?.includes("restarting in");
  mk("Stop", "danger", active || pendingRestart, () => {
    if (!confirm(`Stop ${l.project}? This ends the Claude Code session on ${m.name}.`)) return;
    launchOp({ t: "launch_stop", machine_id: m.machine_id, launch_id: l.launch_id, client_id: newClientId() }, l.launch_id);
  });
  mk("Restart", "", true, () => restart(false));
  mk("Restart + resume", "", true, () => restart(true));
  if (!active && !pendingRestart) {
    mk("Remove", "ghost", true, () =>
      launchOp({ t: "launch_dismiss", machine_id: m.machine_id, launch_id: l.launch_id, client_id: newClientId() }, l.launch_id),
    );
  }
  return box;
}

function launchRow(m: MachineRecord, l: LaunchRecord): HTMLElement {
  const hasSession = state.sessions.some((s) => s.session_id === l.session_id);
  const title = hasSession
    ? h("a", { class: "proj", href: `#/s/${l.session_id}` }, l.project)
    : h("span", { class: "proj" }, l.project);
  return h(
    "div",
    { class: `launch-row st-${l.state}`, "data-launch": l.launch_id },
    h("div", { class: "launch-top" }, title, stateBadge(l), h("span", { class: "sid" }, l.launch_id)),
    !m.online ? h("div", { class: "launch-detail" }, "Computer offline: last known state.") : null,
    l.detail ? h("div", { class: "launch-detail" }, l.detail) : null,
    launchButtons(m, l),
  );
}

interface LauncherForm {
  root: HTMLElement;
  select: HTMLSelectElement;
  cont: HTMLInputElement;
  auto: HTMLInputElement;
  btn: HTMLButtonElement;
  note: HTMLElement;
  key: string;
}

function buildLauncher(machineId: string): LauncherForm {
  const root = h("form", { class: "launcher" });
  const select = h("select", { "aria-label": "project" });
  const cont = h("input", { type: "checkbox" });
  const auto = h("input", { type: "checkbox" });
  const btn = h("button", { type: "submit" }, "Start session");
  const note = h("p", { class: "muted launch-note" });
  root.append(
    h("div", { class: "launcher-row" }, select, btn),
    h(
      "div",
      { class: "launcher-row opts" },
      h("label", {}, cont, " resume last conversation"),
      h("label", {}, auto, " auto-restart on crash"),
    ),
    note,
  );
  root.onsubmit = (ev) => {
    ev.preventDefault();
    if (!select.value) return;
    launchOp(
      {
        t: "launch",
        machine_id: machineId,
        project_id: select.value,
        continue: cont.checked,
        ...(auto.checked ? { auto_restart: true } : {}),
        client_id: newClientId(),
      },
      null,
    );
  };
  return { root, select, cont, auto, btn, note, key: "" };
}

function updateLauncher(f: LauncherForm, m: MachineRecord): void {
  const info = m.launch;
  const projects = info?.projects ?? [];
  const key = projects.map((p) => `${p.id}:${p.name}`).join("|");
  if (key !== f.key) {
    // Rebuild options only when the list changed, keeping the user's choice.
    const keep = f.select.value;
    f.select.replaceChildren(...projects.map((p) => h("option", { value: p.id }, p.name)));
    if (projects.some((p) => p.id === keep)) f.select.value = keep;
    f.key = key;
  }
  const active = info ? info.launches.filter((l) => ACTIVE_STATES.includes(l.state)).length : 0;
  let why = "";
  if (!info) why = "This computer's daemon has not reported launch support (update mcp-remote on it).";
  else if (!info.available) why = info.launch_error ?? "Remote launch is not available on this computer.";
  else if (!projects.length) why = "No projects allowed yet. At the desk: mcp-remote projects add <dir>";
  else if (!m.online) why = "Computer offline.";
  else if (active >= info.max_sessions) why = `At the limit of ${info.max_sessions} launched sessions.`;
  const blocked = !!why || launchBusy(m.machine_id, null);
  f.select.disabled = !info || !info.available || !projects.length;
  f.btn.disabled = blocked;
  f.btn.textContent = launchBusy(m.machine_id, null) ? "Starting\u2026" : "Start session";
  f.note.textContent = why;
  f.note.hidden = !why;
}

interface MachineSection {
  root: HTMLElement;
  head: HTMLElement;
  launcher: LauncherForm;
  launches: HTMLElement;
  sessions: HTMLElement;
}

interface SessionsView {
  root: HTMLElement;
  empty: HTMLElement;
  usage: HTMLElement;
  sections: Map<string, MachineSection>;
}

function buildSessions(): SessionsView {
  const root = h("section", { class: "list" });
  const empty = h("p", { class: "empty" });
  const usage = h("p", { class: "muted usage" });
  root.append(empty, usage);
  return { root, empty, usage, sections: new Map() };
}

function updateSessions(v: SessionsView): void {
  const byMachine = new Map<string, SessionRecord[]>();
  for (const s of state.sessions) {
    const arr = byMachine.get(s.machine_id) ?? [];
    arr.push(s);
    byMachine.set(s.machine_id, arr);
  }
  // Every active computer gets a section (to start sessions on it); revoked ones only while they have sessions.
  const ids = state.machines.filter((m) => !m.revoked || byMachine.has(m.machine_id)).map((m) => m.machine_id);
  for (const mid of byMachine.keys()) if (!ids.includes(mid)) ids.push(mid);

  v.empty.hidden = ids.length > 0;
  // Over the daily budget the Hub sends no machine/session list at all (no database reads): say why.
  const blocked = state.usage?.blocked && state.usage.day === utcToday() ? state.usage.blocked : null;
  v.empty.textContent = blocked
    ? `Unavailable until 00:00 UTC: ${blocked}.`
    : "No computers paired yet. Open Machines to pair one.";
  v.usage.textContent = usageText();
  v.usage.hidden = !state.usage;

  for (const [mid, sec] of v.sections) {
    if (!ids.includes(mid)) {
      sec.root.remove();
      v.sections.delete(mid);
    }
  }
  let prev: Element = v.empty;
  // The usage line stays last.
  for (const mid of ids) {
    let sec = v.sections.get(mid);
    if (!sec) {
      const root = h("div", { class: "machine-section", "data-machine": mid });
      const head = h("h2", { class: "machine" });
      const launcher = buildLauncher(mid);
      const launches = h("div", { class: "launches" });
      const sessions = h("div", { class: "sessions" });
      root.append(head, launcher.root, launches, sessions);
      sec = { root, head, launcher, launches, sessions };
      v.sections.set(mid, sec);
    }
    // Keep DOM order without detaching nodes that are already in place (focus / open <select> survive).
    if (prev.nextElementSibling !== sec.root) prev.after(sec.root);
    prev = sec.root;

    const m = state.machines.find((x) => x.machine_id === mid);
    sec.head.replaceChildren(
      ...nodes(
        h("span", { class: m?.online ? "dot on" : "dot off" }),
        machineName(mid),
        m?.revoked ? h("span", { class: "muted" }, " (revoked)") : null,
      ),
    );
    sec.launcher.root.hidden = !m || m.revoked;
    if (m && !m.revoked) updateLauncher(sec.launcher, m);

    const launches = m && !m.revoked ? (m.launch?.launches ?? []) : [];
    sec.launches.replaceChildren(...launches.map((l) => launchRow(m!, l)));

    const sessions = (byMachine.get(mid) ?? []).slice();
    sessions.sort((a, b) => Number(b.online) - Number(a.online) || (b.last_message_at ?? 0) - (a.last_message_at ?? 0));
    sec.sessions.replaceChildren(
      ...sessions.map((s) =>
        h(
          "a",
          { class: "session", href: `#/s/${s.session_id}`, "data-session": s.session_id },
          h("span", { class: s.online ? "dot on" : "dot off", title: s.online ? "online" : "offline" }),
          h("span", { class: "proj" }, s.project),
          launches.some((l) => l.session_id === s.session_id) ? h("span", { class: "badge", title: "started from the phone" }, "launched") : null,
          h("span", { class: "sid" }, s.session_id.slice(0, 8)),
          urgencyBadge(s.last_urgency),
          s.pending_in ? h("span", { class: "pending", title: "messages waiting for the session" }, String(s.pending_in)) : null,
          h("span", { class: "time" }, fmtTime(s.last_message_at ?? s.last_seen)),
        ),
      ),
    );
  }
}

// The thread and machines views are built once per visit and then updated in place, so the
// focused textarea/input (and Android IME composition) survives incoming frames.

interface ThreadView {
  sid: string;
  root: HTMLElement;
  head: HTMLElement;
  launchBar: HTMLElement;
  cwd: HTMLElement;
  list: HTMLElement;
  ta: HTMLTextAreaElement;
  btn: HTMLButtonElement;
  filled: boolean;
}

function buildThread(sid: string): ThreadView {
  const root = h("section", { class: "thread" });
  const head = h("div", { class: "thread-head" });
  const launchBar = h("div", { class: "launch-bar" });
  const cwd = h("div", { class: "cwd muted" });
  const list = h("div", { class: "messages", id: "messages" });
  const form = h("form", { class: "compose" });
  const ta = h("textarea", { rows: "2", maxlength: "8000" });
  ta.value = drafts.get(sid) ?? "";
  ta.oninput = () => drafts.set(sid, ta.value);
  const btn = h("button", { type: "submit" }, "Send");
  form.append(ta, btn);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text || [...pendingSends.values()].some((p) => p.sid === sid)) return;
    drafts.set(sid, ta.value);
    const client_id = `${pageId}-${++clientSeq}`;
    if (!send({ t: "send", session_id: sid, text, client_id })) {
      toast("Not connected; try again in a moment.");
      return;
    }
    pendingSends.set(client_id, { sid, text });
    render();
  };
  root.append(head, launchBar, cwd, list, form);
  return { sid, root, head, launchBar, cwd, list, ta, btn, filled: false };
}

function updateThread(v: ThreadView): void {
  const sid = v.sid;
  const s = state.sessions.find((x) => x.session_id === sid);
  const machine = s ? state.machines.find((m) => m.machine_id === s.machine_id) : undefined;
  const revoked = !!machine?.revoked;

  v.head.replaceChildren(
    h("a", { href: "#/", class: "back", "aria-label": "back" }, "\u2190"),
    h("span", { class: s?.online ? "dot on" : "dot off" }),
    h("strong", {}, s ? s.project : sid),
    h("span", { class: "muted" }, s ? ` on ${machineName(s.machine_id)}` : ""),
  );
  const lf = launchFor(sid);
  v.launchBar.hidden = !lf;
  if (lf) {
    v.launchBar.className = `launch-bar st-${lf.launch.state}`;
    v.launchBar.replaceChildren(
      ...nodes(
        h("div", { class: "launch-top" }, h("span", { class: "muted" }, "Started from the phone"), stateBadge(lf.launch)),
        lf.launch.detail ? h("div", { class: "launch-detail" }, lf.launch.detail) : null,
        launchButtons(lf.machine, lf.launch),
      ),
    );
  }
  if (s && !s.online && !(lf && ACTIVE_STATES.includes(lf.launch.state))) {
    const forget = h("button", { class: "danger small" }, "Forget");
    forget.onclick = () => {
      if (!confirm(`Forget offline session ${s.project} (${s.session_id.slice(0, 8)}) and its history?`)) return;
      // The cached thread is dropped when the Hub's next state frame no longer lists the session.
      if (send({ t: "forget_session", session_id: sid })) location.hash = "#/";
    };
    v.head.append(forget);
  }
  v.cwd.textContent = s?.cwd ?? "";
  v.cwd.hidden = !s?.cwd;

  const atBottom = v.list.scrollHeight - v.list.scrollTop - v.list.clientHeight < 40;
  const items: Node[] = [];
  const msgs = state.threads.get(sid);
  if (!msgs) items.push(h("p", { class: "empty" }, "Loading..."));
  else if (msgs.length === 0) items.push(h("p", { class: "empty" }, "No messages yet."));
  else {
    if (state.hasMore.get(sid)) {
      const more = h("button", { class: "more" }, "Load earlier");
      more.onclick = () => send({ t: "history", session_id: sid, before_id: msgs[0]!.id });
      items.push(more);
    }
    for (const m of msgs) {
      const cls = m.direction === "in" ? "msg in" : `msg out u-${m.urgency ?? "normal"}`;
      items.push(
        h(
          "div",
          { class: cls, "data-id": String(m.id) },
          m.direction === "out" ? urgencyBadge(m.urgency) : null,
          h("div", { class: "text" }, ...messageText(m.text)),
          h(
            "div",
            { class: "meta" },
            fmtTime(m.created_at),
            // "Handed to session": the shim emitted it to Claude Code. Whether Claude Code actually
            // loaded the shim as a channel cannot be observed from here.
            m.direction === "in" ? (m.delivered ? " \u2713 handed to session" : " \u2026 waiting for session") : "",
          ),
        ),
      );
    }
  }
  v.list.replaceChildren(...items);
  if (atBottom || !v.filled) v.list.scrollTop = v.list.scrollHeight;
  if (msgs) v.filled = true;

  const sending = [...pendingSends.values()].some((p) => p.sid === sid);
  v.ta.disabled = revoked;
  v.btn.disabled = revoked || sending;
  v.btn.textContent = sending ? "Sending\u2026" : "Send";
  v.ta.placeholder = revoked
    ? "This session's computer was revoked; messages can't reach it"
    : s?.online
      ? "Message this session"
      : "Session offline: message will wait";
}

const drafts = new Map<string, string>();

interface MachinesView {
  root: HTMLElement;
  list: HTMLElement;
}

function buildMachines(): MachinesView {
  const root = h("section", { class: "machines" });
  const form = h("form", { class: "pair" });
  const code = h("input", { name: "code", placeholder: "ABCD-EFGH", autocomplete: "off", autocapitalize: "characters", required: "" });
  const name = h("input", { name: "machine_name", placeholder: "Name (optional)", maxlength: "64" });
  form.append(h("h2", {}, "Pair a computer"), h("p", { class: "muted" }, "Run `mcp-remote pair <url>` on the computer and enter the code it prints."), code, name, h("button", { type: "submit" }, "Approve"));
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const body: Record<string, string> = { code: code.value };
    if (name.value.trim()) body.machine_name = name.value.trim();
    const r = await fetch("/api/pair/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: string; machine?: MachineRecord };
    if (!r.ok) toast(j.error ?? "Approval failed");
    else {
      toast(`Paired ${j.machine?.name ?? "computer"}`);
      code.value = "";
      name.value = "";
    }
  };
  const list = h("div", { class: "machine-list" });
  root.append(form, h("h2", {}, "Computers"), list);
  return { root, list };
}

/** True if another active machine with the same name was paired later (likely a re-pair). */
function newerSameName(m: MachineRecord): boolean {
  return state.machines.some((o) => !o.revoked && o.machine_id !== m.machine_id && o.name === m.name && o.created_at > m.created_at);
}

function updateMachines(v: MachinesView): void {
  const active = state.machines.filter((m) => !m.revoked);
  const rows: Node[] = [];
  if (active.length === 0) rows.push(h("p", { class: "empty" }, "None yet."));
  for (const m of active) {
    const btn = h("button", { class: "danger" }, "Revoke");
    btn.onclick = async () => {
      if (!confirm(`Revoke ${m.name}? Its daemon will be disconnected and must be paired again.`)) return;
      const r = await fetch(`/api/machines/${encodeURIComponent(m.machine_id)}`, { method: "DELETE" });
      if (!r.ok) toast("Revoke failed");
    };
    rows.push(
      h(
        "div",
        { class: "machine-row", "data-machine": m.machine_id },
        h("span", { class: m.online ? "dot on" : "dot off" }),
        h("span", { class: "proj" }, m.name),
        h("span", { class: "time" }, m.last_seen ? `seen ${fmtTime(m.last_seen)}` : "never connected"),
        newerSameName(m)
          ? h("span", { class: "badge u-urgent", title: "A newer computer with the same name was paired. If this is its old entry, revoke it." }, "older duplicate?")
          : null,
        btn,
      ),
    );
  }
  v.list.replaceChildren(...rows);
}

// ---------------------------------------------------------------------------
// Settings (Phase 4): notifications on this phone, lock-screen preview, location, install

interface SettingsView {
  root: HTMLElement;
  pushStatus: HTMLElement;
  pushBtn: HTMLButtonElement;
  preview: HTMLInputElement;
  location: HTMLInputElement;
  locStatus: HTMLElement;
  installBox: HTMLElement;
  pushCount: HTMLElement;
}

let pushBusy = false;
/** Last known state of this phone's subscription ("on" / "off" / why unsupported). */
let pushLocal: "on" | "off" | string = "off";

function refreshPushLocal(): void {
  void pushState()
    .then((p) => {
      const next = p.kind === "on" ? "on" : p.kind === "off" ? (p.permission === "denied" ? "blocked" : "off") : `unsupported: ${p.why}`;
      if (next !== pushLocal) {
        pushLocal = next;
        render();
      }
    })
    .catch(() => {});
}

function buildSettings(): SettingsView {
  const root = h("section", { class: "settings" });
  const pushStatus = h("p", { class: "muted" });
  const pushBtn = h("button", { type: "button" }, "Enable");
  pushBtn.onclick = async () => {
    const key = state.me?.push_key;
    if (pushBusy || !key) return;
    pushBusy = true;
    render();
    const error = pushLocal === "on" ? await disablePush() : await enablePush(key);
    pushBusy = false;
    if (error) toast(error);
    refreshPushLocal();
    render();
  };
  const preview = h("input", { type: "checkbox" });
  preview.onchange = () => {
    if (!send({ t: "settings", push_preview: preview.checked })) toast("Not connected; try again in a moment.");
  };
  const loc = h("input", { type: "checkbox" });
  loc.onchange = () => {
    if (!loc.checked && !confirm("Turn location off? Claude's requests are refused and the last shared location is deleted.")) {
      loc.checked = true;
      return;
    }
    if (!send({ t: "settings", location: loc.checked })) toast("Not connected; try again in a moment.");
  };
  const locStatus = h("p", { class: "muted" });
  const installBox = h("div", {});
  const pushCount = h("p", { class: "muted" });
  root.append(
    h("h2", {}, "Notifications on this phone"),
    pushStatus,
    h("div", { class: "row" }, pushBtn),
    h("label", { class: "toggle" }, preview, " Show the first words of a message in notifications (also on the lock screen)"),
    h(
      "p",
      { class: "muted small" },
      "A session's message notifies you only while the app is not open: silent = no notification, normal = a notification, urgent = high priority, stays until dismissed.",
    ),
    pushCount,
    h("h2", {}, "Location"),
    h("label", { class: "toggle" }, loc, " Claude may ask for this phone's location (you confirm every time)"),
    locStatus,
    h("h2", {}, "App"),
    installBox,
  );
  return { root, pushStatus, pushBtn, preview, location: loc, locStatus, installBox, pushCount };
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function updateSettings(v: SettingsView): void {
  const st = state.settings;
  const key = state.me?.push_key ?? null;
  const unsupported = pushSupported();
  let status: string;
  if (!key || (st && !st.push_available)) status = "Notifications are not set up on the server (VAPID keys; see SETUP).";
  else if (unsupported) status = `Not available here: ${unsupported}. Install the app from Chrome on Android.`;
  else if (pushLocal === "blocked") status = "Blocked for this site. Allow notifications in Chrome: site settings (lock icon) > Notifications.";
  else if (pushLocal === "on") status = `On for this phone (${st?.push_devices.length ?? 1} of at most 5 devices on this account).`;
  else status = "Off for this phone.";
  v.pushStatus.textContent = status;
  v.pushBtn.textContent = pushBusy ? "…" : pushLocal === "on" ? "Turn off" : "Turn on";
  v.pushBtn.disabled = pushBusy || !key || !!unsupported || pushLocal === "blocked";
  v.pushBtn.hidden = !key || !!unsupported;
  v.preview.checked = st?.push_preview ?? true;
  v.preview.disabled = !st || !state.connected;
  v.location.checked = st?.location ?? true;
  v.location.disabled = !st || !state.connected;
  v.locStatus.textContent = !st?.location
    ? "Off: requests from sessions are refused."
    : st.location_at
      ? `Last shared ${ago(st.location_at)}; kept for 6 hours, then deleted.`
      : "No location stored. It is only sent when you tap Share on a request.";
  const u = state.usage;
  v.pushCount.textContent = u?.push_cap ? `Today (UTC): ${u.pushes ?? 0} of ${u.push_cap} notifications.` : "";
  v.pushCount.hidden = !u?.push_cap;
  if (isStandalone()) v.installBox.replaceChildren(h("p", { class: "muted" }, "Installed on this device."));
  else if (canInstall()) {
    const b = h("button", { type: "button" }, "Install app");
    b.onclick = () => void install().then(() => render());
    v.installBox.replaceChildren(b);
  } else {
    v.installBox.replaceChildren(h("p", { class: "muted" }, "To install: Chrome menu (⋮) > Add to Home screen (or Install app)."));
  }
}

/** Banners above every view: a waiting app update, open location requests. */
function renderBanners(): void {
  const el = document.querySelector("#banners");
  if (!el) return;
  const items: Node[] = [];
  if (state.applyUpdate) {
    const b = h("button", { type: "button", class: "small" }, "Reload");
    const apply = state.applyUpdate;
    b.onclick = () => apply();
    items.push(h("div", { class: "banner" }, h("span", {}, "A new version of the app is available."), b));
  }
  for (const req of state.locRequests.values()) {
    const busy = state.sharing.has(req.rid);
    const share = h("button", { type: "button", class: "small" }, busy ? "Locating…" : "Share");
    share.disabled = busy;
    share.onclick = () => void shareLocation(req);
    const no = h("button", { type: "button", class: "small ghost" }, "Not now");
    no.disabled = busy;
    no.onclick = () => declineLocation(req);
    items.push(
      h(
        "div",
        { class: "banner loc", "data-rid": req.rid },
        h("span", {}, `${req.project || "A session"} asks for your location${req.reason ? `: ${req.reason}` : "."}`),
        share,
        no,
      ),
    );
  }
  el.replaceChildren(...items);
}

let lastView = "";
let settingsView: SettingsView | null = null;
let threadView: ThreadView | null = null;
let machinesView: MachinesView | null = null;
let sessionsView: SessionsView | null = null;

function render(_force = false): void {
  const main = document.querySelector("#main");
  if (!main || !state.me) return;
  renderBanners();
  const sid = currentSession();
  const view = sid ? `s:${sid}` : location.hash === "#/machines" ? "machines" : location.hash === "#/settings" ? "settings" : "sessions";
  if (view !== "settings") settingsView = null;
  if (sid) sessionsView = null;
  for (const tab of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
    tab.classList.toggle("active", (tab.dataset.view ?? "") === (sid ? "sessions" : view));
  }
  const changed = view !== lastView || !main.firstChild;
  lastView = view;
  if (sid) {
    if (changed || !threadView || threadView.sid !== sid) {
      threadView = buildThread(sid);
      main.replaceChildren(threadView.root);
    }
    updateThread(threadView);
    return;
  }
  threadView = null;
  if (view === "settings") {
    sessionsView = null;
    machinesView = null;
    if (changed || !settingsView) {
      settingsView = buildSettings();
      main.replaceChildren(settingsView.root);
      refreshPushLocal();
    }
    updateSettings(settingsView);
    return;
  }
  if (view === "machines") {
    sessionsView = null;
    if (changed || !machinesView) {
      machinesView = buildMachines();
      main.replaceChildren(machinesView.root);
    }
    updateMachines(machinesView);
    return;
  }
  machinesView = null;
  if (changed || !sessionsView) {
    sessionsView = buildSessions();
    main.replaceChildren(sessionsView.root);
  }
  updateSessions(sessionsView);
}

function renderSignedOut(): void {
  const app = $("#app");
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const devForm = local
    ? h(
        "form",
        { class: "dev", action: "/auth/dev", method: "get" },
        h("p", { class: "muted" }, "Local dev sign-in (needs DEV_AUTH=1 in .dev.vars):"),
        h("input", { name: "user", placeholder: "alice", pattern: "[a-z0-9_-]{1,32}", required: "" }),
        h("button", { type: "submit" }, "Dev sign-in"),
      )
    : null;
  app.replaceChildren(
    h(
      "div",
      { class: "signin" },
      h("img", { src: "/favicon.svg", alt: "", width: "64", height: "64" }),
      h("h1", {}, "mcp remote"),
      h("p", { class: "muted" }, "Talk to your coding sessions from your phone."),
      h("a", { class: "button", href: "/auth/login" }, "Sign in with Google"),
      devForm,
    ),
  );
}

function renderShell(): void {
  const app = $("#app");
  const logout = h("form", { method: "post", action: "/auth/logout", class: "logout" }, h("button", { type: "submit" }, "Sign out"));
  logout.onsubmit = async (ev) => {
    // fetch() always sends our Origin on POST; a plain form post may send "Origin: null".
    ev.preventDefault();
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } }).catch(() => null);
    if (!r || !r.ok) {
      toast("Sign-out failed; try again.");
      return;
    }
    location.hash = "";
    void boot();
  };
  app.replaceChildren(
    h(
      "header",
      {},
      h("span", { id: "conn", class: "dot off" }),
      h("strong", {}, "mcp remote"),
      h("span", { class: "muted me" }, state.me?.email ?? ""),
      logout,
    ),
    h(
      "nav",
      {},
      h("a", { href: "#/", "data-view": "sessions" }, "Sessions"),
      h("a", { href: "#/machines", "data-view": "machines" }, "Machines"),
      h("a", { href: "#/settings", "data-view": "settings" }, "Settings"),
    ),
    h("div", { id: "banners" }),
    h("main", { id: "main" }),
  );
  renderStatus();
}

let bootTimer: number | undefined;

async function boot(): Promise<void> {
  link.stop();
  window.clearTimeout(bootTimer);
  const r = await fetch("/api/me").catch(() => null);
  if (!r || !r.ok) {
    state.me = null;
    if (r && r.status === 401) renderSignedOut();
    else {
      // The app shell itself comes from the service worker's cache, so this also shows offline.
      const offline = !navigator.onLine || !r;
      $("#app").replaceChildren(
        h(
          "div",
          { class: "signin" },
          h("img", { src: "/favicon.svg", alt: "", width: "64", height: "64" }),
          h("h1", {}, "mcp remote"),
          h("p", { class: "muted" }, offline ? "You are offline. The app reconnects when the network is back." : "Cannot reach the server. Retrying..."),
        ),
      );
      bootTimer = window.setTimeout(() => void boot(), backoffDelay(attempt++, { baseMs: 1000, capMs: 30_000 }));
    }
    return;
  }
  state.me = (await r.json()) as Me;
  renderShell();
  render(true);
  link.start();
  // Opened from a "Claude wants your location" notification (the tap was the consent).
  const here = new URL(location.href);
  if (here.searchParams.has("loc")) {
    takeLocationParams(here);
    history.replaceState(null, "", `/${location.hash}`);
  }
}

// An offline start retries as soon as the network is back (no waiting for the backoff timer).
window.addEventListener("online", () => {
  if (!state.me) void boot();
});

watchInstallPrompt(() => render());
void registerServiceWorker({
  onUpdateReady: (apply) => {
    state.applyUpdate = apply;
    render();
  },
  onOpen: (url) => openFromNotification(url),
});

void boot();
