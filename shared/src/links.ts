/**
 * Which parts of a message the phone shows as tappable links (Phase 4). DOM-free so it can be tested;
 * the PWA turns segments into text nodes and <a> elements (never innerHTML).
 *
 * Only map links become tappable: Google Maps URLs on an allowlisted host (https only) and `geo:`
 * URIs with plain coordinates. Everything else stays text the user can copy: a session reading
 * untrusted content could be tricked into sending a convincing phishing link, and a map link is
 * the only kind the agent is told to send (map_link tool).
 */

export type Segment = { text: string; href?: undefined } | { text: string; href: string; kind: "map" | "geo" };

/** Hosts whose links open as maps; `paths` restricts the path prefix (lower case). */
const MAP_HOSTS: Record<string, readonly string[] | null> = {
  "www.google.com": ["/maps"],
  "google.com": ["/maps"],
  "maps.google.com": null,
  "maps.app.goo.gl": null,
  "goo.gl": ["/maps"],
};

const CANDIDATE = /\b(?:https?:\/\/|geo:)[^\s<>"'`\u0000-\u001f\u007f]+/gi;
const TRAILING = /[.,;:!?'")\]}>]+$/;

/** Strip sentence punctuation after a URL, but keep a ")" that closes a "(" inside it. */
function trimTrailing(s: string): string {
  let out = s;
  for (;;) {
    const m = TRAILING.exec(out);
    if (!m) return out;
    const last = out[out.length - 1]!;
    if (last === ")" && (out.match(/\(/g)?.length ?? 0) >= (out.match(/\)/g)?.length ?? 0)) return out;
    out = out.slice(0, -1);
  }
}

/** The href to use for `url` if it is an allowed map link, else null. */
export function allowedMapHref(url: string): { href: string; kind: "map" | "geo" } | null {
  if (/^geo:/i.test(url)) {
    const m = /^geo:(-?\d{1,2}(?:\.\d{1,10})?),(-?\d{1,3}(?:\.\d{1,10})?)(\?q=[A-Za-z0-9%+.,_()-]{0,200})?$/.exec(url);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
    return { href: `geo:${m[1]},${m[2]}${m[3] ?? ""}`, kind: "geo" };
  }
  // https only; host = letters/digits/dots/dashes followed by "/", "?", "#" or the end (so no
  // "user@", ":port" or "\" tricks), and nothing that browsers would reinterpret.
  const m = /^https:\/\/([A-Za-z0-9.-]+)([/?#][^\s\\]*)?$/.exec(url);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const rest = m[2] ?? "";
  if (!Object.prototype.hasOwnProperty.call(MAP_HOSTS, host)) return null;
  const paths = MAP_HOSTS[host];
  if (paths) {
    const path = rest.toLowerCase();
    if (!paths.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) return null;
  }
  return { href: `https://${host}${rest}`, kind: "map" };
}

/** Split a message into plain text and allowed map links, in order. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.href === undefined) prev.text += t;
    else out.push({ text: t });
  };
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index ?? 0;
    const raw = trimTrailing(m[0]);
    const ok = allowedMapHref(raw);
    if (!ok) continue;
    push(text.slice(pos, start));
    out.push({ text: raw, href: ok.href, kind: ok.kind });
    pos = start + raw.length;
  }
  push(text.slice(pos));
  return out;
}
