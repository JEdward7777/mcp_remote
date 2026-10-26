// Owner-only Admin page (Phase 4b, D13). Shown only when /api/me says `owner`; every /api/admin/* call
// is checked against OWNER_EMAILS on the server again. Loaded on open and with Refresh (no polling).
import { api, commandBox, fmtDate, h, toast } from "./dom";

type Status = "active" | "waitlisted" | "denied" | "disabled";
interface Totals {
  do_requests: number;
  rows_read: number;
  rows_written: number;
}
interface DayRow extends Totals {
  day: string;
  signups: number;
  waitlist_joins: number;
  dau: number;
  messages: number;
  pushes: number;
  machines: number;
  sessions: number;
  reg_requests: number;
  reg_rows_read: number;
  reg_rows_written: number;
}
interface Top extends Totals {
  tid: string;
  email: string;
  status: Status;
  plan: string;
  via: string;
  messages: number;
  pushes: number;
  machines: number;
  sessions: number;
  percent: number;
}
interface Overview {
  day: string;
  totals: Totals;
  limits: Totals;
  level: { percent: number; metric: keyof Totals; per: Totals };
  guard: { day: string; paused: boolean; free_share: number | null };
  owner_paused: boolean;
  alerts_today: number[];
  config: {
    mode: "closed" | "waitlist" | "open";
    user_cap: number;
    waitlist_max: number;
    pause_at: number | null;
    tighten_at: number | null;
    tighten_share: number;
    alert_at: number[];
    alert_signups: number | null;
    report_minutes: number | null;
  };
  counts: Record<Status, number>;
  days: DayRow[];
  top: Top[];
}
interface Tenant {
  tid: string;
  email: string;
  name: string | null;
  status: Status;
  via: string;
  plan: string;
  created_at: number;
  last_active_day: string | null;
}
interface Invite {
  id: string;
  created_at: number;
  expires_at: number;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
  note: string;
  open: boolean;
  link: string | null;
}
interface Audit {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

export interface AdminView {
  root: HTMLElement;
  refresh(): Promise<void>;
}

const LABEL: Record<keyof Totals, string> = {
  do_requests: "Durable Object requests",
  rows_read: "Database rows read",
  rows_written: "Database rows written",
};
const MODE: Record<Overview["config"]["mode"], string> = {
  closed: "closed (ALLOWED_EMAILS, owners and invite links only)",
  waitlist: "waitlist (everyone else waits for your approval)",
  open: "open (auto-approved up to the user cap, then the waitlist)",
};
const PLANS = ["free", "owner"];

const n = (x: number) => x.toLocaleString();

export function buildAdmin(): AdminView {
  const root = h("section", { class: "admin settings" });
  const status = h("p", { class: "muted small" }, "Loading...");
  const refreshBtn = h("button", { type: "button", class: "small ghost" }, "Refresh");
  const today = h("div", {});
  const accounts = h("div", {});
  const waitlist = h("div", {});
  const top = h("div", {});
  const all = h("div", {});
  const invites = h("div", {});
  const audit = h("div", {});
  root.append(
    h("div", { class: "admin-head" }, h("h2", {}, "Admin"), refreshBtn),
    status,
    today,
    accounts,
    waitlist,
    top,
    all,
    invites,
    audit,
  );

  async function act(path: string, body: unknown, done: string): Promise<void> {
    try {
      const r = await api<{ ok: boolean; warning?: string }>(path, { method: "POST", body });
      toast(r.warning ?? done);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed");
    }
    await refresh();
  }

  function renderToday(o: Overview): void {
    const rows: Node[] = [h("h2", {}, `Today (UTC ${o.day}) vs the free plan's daily limits`)];
    for (const k of Object.keys(LABEL) as (keyof Totals)[]) {
      const pct = o.level.per[k];
      const meter = h("meter", { min: "0", max: "100", low: "50", high: "80", optimum: "0", value: String(Math.min(100, pct)) });
      rows.push(
        h(
          "div",
          { class: "row usage-row", "data-metric": k },
          h("span", { class: "usage-label" }, LABEL[k]),
          meter,
          h("span", { class: "small" }, `${n(o.totals[k])} of ${n(o.limits[k])} (${pct.toFixed(1)}%)`),
        ),
      );
    }
    const g = o.guard;
    rows.push(
      h(
        "p",
        { class: "small" },
        `Guard: new sign-ups ${g.paused ? "PAUSED (they go to the waitlist)" : "auto-approved as configured"}` +
          `${o.config.pause_at !== null ? ` (pauses at ${o.config.pause_at}%)` : ""}; free accounts ` +
          `${g.free_share !== null ? `LIMITED to ${g.free_share}% each today` : "at their normal share"}` +
          `${o.config.tighten_at !== null ? ` (tightens at ${o.config.tighten_at}%)` : ""}. ` +
          `Alerts at ${o.config.alert_at.join("% / ") || "-"}%${o.alerts_today.length ? `; sent today: ${o.alerts_today.join("%, ")}%` : ""}.`,
      ),
      h(
        "p",
        { class: "muted small" },
        "Counted: what each account's Hub and the Registry metered (Durable Object requests incl. WebSocket frames / 20, " +
          "SQLite rows), reported at most every " +
          (o.config.report_minutes === null ? "(reports off)" : `${o.config.report_minutes} min`) +
          " per account. Worker-only requests (static files, /api/me, sign-in, pairing) are not included. The limits are " +
          "assumed free-plan numbers (see SETUP, verify at the desk).",
      ),
    );
    const pause = h("input", { type: "checkbox" }) as HTMLInputElement;
    pause.checked = o.owner_paused;
    pause.onchange = () => void act("/api/admin/signups", { paused: pause.checked }, pause.checked ? "Sign-ups paused" : "Sign-ups resumed");
    rows.push(h("label", { class: "toggle" }, pause, h("span", {}, "Pause new sign-ups (strangers go to the waitlist; invites still work)")));
    today.replaceChildren(...rows);
  }

  function renderAccounts(o: Overview): void {
    const c = o.counts;
    const days = o.days.slice(0, 14);
    const table = h(
      "table",
      { class: "admin-table" },
      h("tr", {}, h("th", {}, "UTC day"), h("th", {}, "Sign-ups"), h("th", {}, "Active"), h("th", {}, "DO req."), h("th", {}, "Rows written"), h("th", {}, "Messages")),
      ...days.map((d) =>
        h(
          "tr",
          {},
          h("td", {}, d.day.slice(5)),
          h("td", {}, n(d.signups)),
          h("td", {}, n(d.dau)),
          h("td", {}, n(d.do_requests + d.reg_requests)),
          h("td", {}, n(d.rows_written + d.reg_rows_written)),
          h("td", {}, n(d.messages)),
        ),
      ),
    );
    accounts.replaceChildren(
      h("h2", {}, "Accounts"),
      h(
        "p",
        { class: "small", "data-counts": "" },
        `${c.active} active (user cap ${o.config.user_cap}), ${c.waitlisted} waiting, ${c.disabled} disabled, ${c.denied} denied. Sign-up: ${MODE[o.config.mode]}.`,
      ),
      days.length ? table : h("p", { class: "muted small" }, "No activity recorded yet."),
    );
  }

  function renderWaitlist(list: Tenant[]): void {
    const rows = list.map((t) => {
      const ok = h("button", { type: "button", class: "small" }, "Approve");
      ok.onclick = () => void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/approve`, {}, `Approved ${t.email}`);
      const no = h("button", { type: "button", class: "small ghost" }, "Deny");
      no.onclick = () => {
        if (confirm(`Deny ${t.email}? They can't sign up again unless you approve them later.`)) void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/deny`, {}, `Denied ${t.email}`);
      };
      return h("div", { class: "machine-row", "data-tid": t.tid }, h("span", { class: "proj" }, t.email), h("span", { class: "time" }, `since ${fmtDate(t.created_at)}`), ok, no);
    });
    waitlist.replaceChildren(h("h2", {}, `Waitlist (${list.length})`), ...(rows.length ? rows : [h("p", { class: "muted small" }, "Nobody is waiting.")]));
  }

  function planSelect(t: { tid: string; plan: string; email: string }): HTMLElement {
    const sel = h("select", {}) as HTMLSelectElement;
    for (const p of PLANS) sel.append(h("option", { value: p }, p));
    sel.value = t.plan;
    sel.onchange = () => void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/plan`, { plan: sel.value }, `${t.email}: plan ${sel.value}`);
    return sel;
  }

  function statusButton(t: { tid: string; status: Status; email: string }): HTMLElement | null {
    if (t.status === "active") {
      const b = h("button", { type: "button", class: "small danger" }, "Disable");
      b.onclick = () => {
        if (confirm(`Disable ${t.email}? Their phone and computers are disconnected at once (daemons exit with code 3) until you enable it again.`)) {
          void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/disable`, {}, `Disabled ${t.email}`);
        }
      };
      return b;
    }
    if (t.status === "disabled") {
      const b = h("button", { type: "button", class: "small" }, "Enable");
      b.onclick = () => void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/enable`, {}, `Enabled ${t.email}`);
      return b;
    }
    if (t.status === "denied") {
      const b = h("button", { type: "button", class: "small ghost" }, "Approve");
      b.onclick = () => void act(`/api/admin/tenants/${encodeURIComponent(t.tid)}/approve`, {}, `Approved ${t.email}`);
      return b;
    }
    return null;
  }

  function renderTop(o: Overview): void {
    const rows = o.top.map((t) =>
      h(
        "tr",
        { "data-tid": t.tid },
        h("td", { class: "email" }, t.email || t.tid),
        h("td", {}, `${t.percent.toFixed(1)}%`),
        h("td", {}, n(t.do_requests)),
        h("td", {}, n(t.rows_written)),
        h("td", {}, n(t.messages)),
        h("td", {}, `${t.machines}/${t.sessions}`),
      ),
    );
    top.replaceChildren(
      h("h2", {}, "Top accounts today (by share of a free limit)"),
      rows.length
        ? h(
            "table",
            { class: "admin-table" },
            h("tr", {}, h("th", {}, "Account"), h("th", {}, "Share"), h("th", {}, "DO req."), h("th", {}, "Rows written"), h("th", {}, "Messages"), h("th", {}, "Computers / sessions")),
            ...rows,
          )
        : h("p", { class: "muted small" }, "No usage reported today yet."),
    );
  }

  function renderAll(list: Tenant[]): void {
    const rows = list
      .filter((t) => t.status !== "waitlisted")
      .map((t) =>
        h(
          "div",
          { class: "machine-row", "data-tid": t.tid },
          h("span", { class: "proj" }, t.email || t.tid),
          h("span", { class: `badge st-${t.status === "active" ? "running" : t.status === "disabled" ? "failed" : "exited"}` }, t.status),
          h("span", { class: "time" }, t.last_active_day ? `active ${t.last_active_day}` : `joined ${fmtDate(t.created_at)}`),
          t.status === "active" || t.status === "disabled" ? planSelect(t) : null,
          statusButton(t),
        ),
      );
    all.replaceChildren(h("h2", {}, "All accounts"), ...(rows.length ? rows : [h("p", { class: "muted small" }, "None yet.")]));
  }

  function renderInvites(list: Invite[]): void {
    const form = h("form", { class: "invite-form" });
    const days = h("input", { type: "number", min: "1", max: "30", value: "7", "aria-label": "valid for days" }) as HTMLInputElement;
    const uses = h("input", { type: "number", min: "1", max: "1000", value: "5", "aria-label": "max uses (empty = unlimited)" }) as HTMLInputElement;
    const note = h("input", { maxlength: "100", placeholder: "Note (who it's for)" }) as HTMLInputElement;
    form.append(
      h("label", {}, "Days ", days),
      h("label", {}, "Max uses ", uses),
      note,
      h("button", { type: "submit", class: "small" }, "Create invite link"),
    );
    const created = h("div", {});
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const r = await api<{ invite: Invite }>("/api/admin/invites", {
          method: "POST",
          body: { days: Number(days.value) || 7, max_uses: uses.value.trim() ? Number(uses.value) : null, note: note.value.trim() },
        });
        created.replaceChildren(h("p", { class: "small" }, "New invite link (skips the waitlist; share it privately):"), commandBox(r.invite.link ?? ""));
        await refresh(false);
      } catch (e) {
        toast(e instanceof Error ? e.message : "failed");
      }
    };
    const rows = list.map((i) => {
      const state = i.revoked_at ? "revoked" : i.expires_at <= Date.now() ? "expired" : !i.open ? "used up" : "open";
      const revoke = h("button", { type: "button", class: "small ghost" }, "Revoke");
      revoke.onclick = async () => {
        try {
          await api(`/api/admin/invites/${i.id}`, { method: "DELETE" });
          toast("Invite revoked");
        } catch (e) {
          toast(e instanceof Error ? e.message : "failed");
        }
        await refresh();
      };
      const copy = h("button", { type: "button", class: "small ghost" }, "Copy link");
      copy.onclick = () => i.link && void navigator.clipboard.writeText(i.link).then(() => toast("Copied"), () => toast(i.link ?? ""));
      return h(
        "div",
        { class: "machine-row", "data-invite": i.id },
        h("span", { class: "proj" }, i.note || i.id.slice(0, 8)),
        h("span", { class: "time" }, `${i.uses}/${i.max_uses ?? "∞"} used, ${state}${state === "open" ? `, until ${fmtDate(i.expires_at)}` : ""}`),
        state === "open" && i.link ? copy : null,
        state === "open" ? revoke : null,
      );
    });
    invites.replaceChildren(h("h2", {}, "Invite links"), form, created, ...rows);
  }

  function renderAudit(list: Audit[]): void {
    audit.replaceChildren(
      h("h2", {}, "Audit log"),
      ...(list.length
        ? list.slice(0, 50).map((a) => h("p", { class: "small audit" }, `${fmtDate(a.at)} ${a.actor}: ${a.action} ${a.target}${a.detail ? ` (${a.detail})` : ""}`))
        : [h("p", { class: "muted small" }, "No owner actions yet.")]),
    );
  }

  async function refresh(all_ = true): Promise<void> {
    refreshBtn.disabled = true;
    try {
      const [o, wl, ts, inv, au] = await Promise.all([
        api<Overview>("/api/admin/overview"),
        api<{ tenants: Tenant[] }>("/api/admin/tenants?status=waitlisted"),
        api<{ tenants: Tenant[] }>("/api/admin/tenants?status=all"),
        api<{ invites: Invite[] }>("/api/admin/invites"),
        api<{ audit: Audit[] }>("/api/admin/audit"),
      ]);
      status.textContent = `Updated ${new Date().toLocaleTimeString()}. Emails are shown to the owner only.`;
      renderToday(o);
      renderAccounts(o);
      renderWaitlist(wl.tenants);
      renderTop(o);
      renderAll(ts.tenants);
      if (all_) renderInvites(inv.invites);
      else renderInviteRowsOnly(inv.invites);
      renderAudit(au.audit);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Could not load the admin data";
    } finally {
      refreshBtn.disabled = false;
    }
  }

  /** After creating an invite: keep the "new link" box, refresh the list below it. */
  function renderInviteRowsOnly(list: Invite[]): void {
    const keepForm = invites.querySelector("form");
    const keepCreated = keepForm?.nextElementSibling ?? null;
    renderInvites(list);
    if (keepForm && keepCreated) {
      const nf = invites.querySelector("form");
      nf?.replaceWith(keepForm);
      keepForm.nextElementSibling?.replaceWith(keepCreated);
    }
  }

  refreshBtn.onclick = () => void refresh();
  return { root, refresh };
}
