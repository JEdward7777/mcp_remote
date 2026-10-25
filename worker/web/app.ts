// Phone PWA (no framework). Bundled to public/app.js by build-web.mjs.
import type { HubToPhone, MachineRecord, MessageRecord, PhoneToHub, SessionRecord, Urgency } from "@mcp-remote/shared";
import { backoffDelay } from "@mcp-remote/shared/backoff";

interface Me {
  tenant: string;
  email: string;
  name: string | null;
  dev: boolean;
}

const state = {
  me: null as Me | null,
  machines: [] as MachineRecord[],
  sessions: [] as SessionRecord[],
  threads: new Map<string, MessageRecord[]>(),
  hasMore: new Map<string, boolean>(),
  connected: false,
};

let ws: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: number | undefined;
let pingTimer: number | undefined;
let clientSeq = 0;
/** Sends waiting for the Hub's echo; the draft is only cleared once the echo arrives. */
const pendingSends = new Map<string, { sid: string; text: string }>();

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

function fmtTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function urgencyBadge(u: Urgency | null): HTMLElement | null {
  if (!u) return null;
  const label = u === "urgent" ? "URGENT" : u === "silent" ? "fyi" : "normal";
  return h("span", { class: `badge u-${u}`, title: `urgency: ${u}` }, label);
}

// ---------------------------------------------------------------------------
// Networking

function send(frame: PhoneToHub): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

function connect(): void {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/api/ws`);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    state.connected = true;
    renderStatus();
    clearInterval(pingTimer);
    pingTimer = window.setInterval(() => sock.readyState === WebSocket.OPEN && sock.send("ping"), 30_000);
    // Anything may have happened while we were disconnected: drop every cached thread except the
    // visible one (refetched now; the fresh copy wins on merge) so others reload when opened.
    const sid = currentSession();
    for (const k of [...state.threads.keys()]) if (k !== sid) state.threads.delete(k);
    if (sid) send({ t: "history", session_id: sid });
  };
  sock.onmessage = (ev) => {
    if (ev.data === "pong") return;
    let f: HubToPhone;
    try {
      f = JSON.parse(String(ev.data)) as HubToPhone;
    } catch {
      return;
    }
    onFrame(f);
  };
  sock.onclose = (ev) => {
    if (ws === sock) ws = null;
    state.connected = false;
    if (pendingSends.size) {
      // Unconfirmed sends: keep the text in the compose box so nothing typed is lost.
      pendingSends.clear();
      toast("Connection lost before the message was confirmed; it is still in the box.");
      render();
    }
    clearInterval(pingTimer);
    renderStatus();
    if (ev.code === 1008 || ev.code === 4401) {
      void boot();
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  const delay = backoffDelay(attempt++, { baseMs: 1000, capMs: 30_000 });
  reconnectTimer = window.setTimeout(async () => {
    // If the cookie expired, go back to the sign-in screen instead of looping.
    const r = await fetch("/api/me").catch(() => null);
    if (r && r.status === 401) {
      void boot();
      return;
    }
    connect();
  }, delay);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.me && !ws) {
    attempt = 0;
    connect();
  }
});

function onFrame(f: HubToPhone): void {
  switch (f.t) {
    case "state":
      state.machines = f.machines;
      state.sessions = f.sessions;
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
      if (list && !list.some((m) => m.id === f.message.id)) list.push(f.message);
      const s = state.sessions.find((x) => x.session_id === f.message.session_id);
      if (s) {
        s.last_message_at = f.message.created_at;
        if (f.message.direction === "out") s.last_urgency = f.message.urgency;
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
      render();
      return;
    }
    case "error":
      if (f.client_id) pendingSends.delete(f.client_id);
      toast(f.error);
      render();
      return;
  }
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

function renderStatus(): void {
  const el = document.querySelector("#conn");
  if (!el) return;
  el.className = state.connected ? "dot on" : "dot off";
  el.setAttribute("title", state.connected ? "connected" : "reconnecting...");
}

function machineName(id: string): string {
  return state.machines.find((m) => m.machine_id === id)?.name ?? "unknown machine";
}

function renderSessions(): HTMLElement {
  const root = h("section", { class: "list" });
  if (state.sessions.length === 0) {
    root.append(
      h(
        "p",
        { class: "empty" },
        state.machines.length === 0
          ? "No computers paired yet. Open Machines to pair one."
          : "No sessions yet. Start Claude Code with the mcp-remote shim on a paired computer.",
      ),
    );
    return root;
  }
  const byMachine = new Map<string, SessionRecord[]>();
  for (const s of state.sessions) {
    const arr = byMachine.get(s.machine_id) ?? [];
    arr.push(s);
    byMachine.set(s.machine_id, arr);
  }
  for (const [mid, sessions] of byMachine) {
    const m = state.machines.find((x) => x.machine_id === mid);
    const head = h(
      "h2",
      { class: "machine" },
      h("span", { class: m?.online ? "dot on" : "dot off" }),
      machineName(mid),
      m?.revoked ? h("span", { class: "muted" }, " (revoked)") : null,
    );
    root.append(head);
    sessions.sort((a, b) => Number(b.online) - Number(a.online) || (b.last_message_at ?? 0) - (a.last_message_at ?? 0));
    for (const s of sessions) {
      const a = h(
        "a",
        { class: "session", href: `#/s/${s.session_id}`, "data-session": s.session_id },
        h("span", { class: s.online ? "dot on" : "dot off", title: s.online ? "online" : "offline" }),
        h("span", { class: "proj" }, s.project),
        h("span", { class: "sid" }, s.session_id.slice(0, 8)),
        urgencyBadge(s.last_urgency),
        s.pending_in ? h("span", { class: "pending", title: "messages waiting for the session" }, String(s.pending_in)) : null,
        h("span", { class: "time" }, fmtTime(s.last_message_at ?? s.last_seen)),
      );
      root.append(a);
    }
  }
  return root;
}

// The thread and machines views are built once per visit and then updated in place, so the
// focused textarea/input (and Android IME composition) survives incoming frames.

interface ThreadView {
  sid: string;
  root: HTMLElement;
  head: HTMLElement;
  cwd: HTMLElement;
  list: HTMLElement;
  ta: HTMLTextAreaElement;
  btn: HTMLButtonElement;
  filled: boolean;
}

function buildThread(sid: string): ThreadView {
  const root = h("section", { class: "thread" });
  const head = h("div", { class: "thread-head" });
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
    const client_id = `c${++clientSeq}`;
    if (!send({ t: "send", session_id: sid, text, client_id })) {
      toast("Not connected; try again in a moment.");
      return;
    }
    pendingSends.set(client_id, { sid, text });
    render();
  };
  root.append(head, cwd, list, form);
  return { sid, root, head, cwd, list, ta, btn, filled: false };
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
  if (s && !s.online) {
    const forget = h("button", { class: "danger small" }, "Forget");
    forget.onclick = () => {
      if (!confirm(`Forget offline session ${s.project} (${s.session_id.slice(0, 8)}) and its history?`)) return;
      if (send({ t: "forget_session", session_id: sid })) {
        state.threads.delete(sid);
        location.hash = "#/";
      }
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
          h("div", { class: "text" }, m.text),
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
        btn,
      ),
    );
  }
  v.list.replaceChildren(...rows);
}

let lastView = "";
let threadView: ThreadView | null = null;
let machinesView: MachinesView | null = null;

function render(_force = false): void {
  const main = document.querySelector("#main");
  if (!main || !state.me) return;
  const sid = currentSession();
  const view = sid ? `s:${sid}` : location.hash === "#/machines" ? "machines" : "sessions";
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
  if (view === "machines") {
    if (changed || !machinesView) {
      machinesView = buildMachines();
      main.replaceChildren(machinesView.root);
    }
    updateMachines(machinesView);
    return;
  }
  machinesView = null;
  main.replaceChildren(renderSessions());
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
    ),
    h("main", { id: "main" }),
  );
  renderStatus();
}

async function boot(): Promise<void> {
  ws?.close();
  ws = null;
  const r = await fetch("/api/me").catch(() => null);
  if (!r || !r.ok) {
    state.me = null;
    if (r && r.status === 401) renderSignedOut();
    else {
      $("#app").replaceChildren(h("p", { class: "empty" }, "Cannot reach the server. Retrying..."));
      window.setTimeout(() => void boot(), backoffDelay(attempt++, { baseMs: 1000, capMs: 30_000 }));
    }
    return;
  }
  state.me = (await r.json()) as Me;
  renderShell();
  render(true);
  connect();
}

void boot();
