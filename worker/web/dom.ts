// Tiny DOM helpers shared by the app's views (no framework).

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

export function h<K extends keyof HTMLElementTagNameMap>(
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

export function nodes(...items: (Node | string | null | undefined)[]): (Node | string)[] {
  return items.filter((x): x is Node | string => x !== null && x !== undefined);
}

export function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 4000);
}

/** A read-only command line with a Copy button. */
export function commandBox(text: string, label = "Copy"): HTMLElement {
  const code = h("code", { class: "cmd" }, text);
  const btn = h("button", { type: "button", class: "small ghost" }, label);
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      // Clipboard blocked: select the text so a long-press copy works.
      const r = document.createRange();
      r.selectNodeContents(code);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      toast("Select the text and copy it");
    }
  };
  return h("div", { class: "cmd-row" }, code, btn);
}

/** JSON fetch for same-origin API calls; throws an Error with the server's message on failure. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
