// One-line install (Phase 4b, D12): the signed-in user gets a copy-paste command with a pairing code
// already filled in. The pairing is started here, server-side and charged to this account (so the
// global cap on anonymous pairing starts doesn't apply), and is pre-approved: the computer that runs
// the command is paired to this account without typing a code on the phone.
//
// The CLI comes from this server as a static file (/dl/mcp-remote-<version>-<sha8>.tgz, built from the
// repo by the deploy), installed with npm; nothing is piped into a shell.
import type { MachineRecord } from "@mcp-remote/shared";
import { api, commandBox, h, toast } from "./dom";

interface DlInfo {
  version: string;
  file: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface InstallView {
  root: HTMLElement;
  /** New machines since the code was issued: show "Paired". */
  update(machines: MachineRecord[]): void;
}

/** Read fresh on every "Get an install command" (a deploy may have replaced the tarball), and checked to exist. */
async function dlInfo(): Promise<DlInfo> {
  const missing = "the CLI package is not available on this server (it is built by `wrangler deploy`; redeploy)";
  const r = await fetch("/dl/mcp-remote.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(missing);
  const info = (await r.json()) as DlInfo;
  const head = await fetch(info.path, { method: "HEAD", cache: "no-cache" }).catch(() => null);
  if (!head || !head.ok) throw new Error(missing);
  return info;
}

/** Shell-safe enough for our own origin (https://host[:port]); anything else is quoted. */
function q(s: string): string {
  return /^[A-Za-z0-9:/._-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildInstall(opts: { first: boolean }): InstallView {
  const root = h("section", { class: "install" });
  const body = h("div", { class: "install-body" });
  const btn = h("button", { type: "button" }, opts.first ? "Add your first computer" : "Get an install command");
  const intro = h(
    "p",
    { class: "muted small" },
    "Shows one command to paste into a terminal on the computer (Linux, macOS or WSL with Node.js 22+). " +
      "It installs mcp-remote and pairs that computer to this account: no code to type here.",
  );
  root.append(h("h2", {}, "Add a computer"), intro, btn, body);
  let issuedAt = 0;
  let known = new Set<string>();
  let paired: HTMLElement | null = null;

  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const [start, dl] = await Promise.all([
        api<{ code: string; expires_at: number; url: string }>("/api/pair/start-signed", { method: "POST", body: {} }),
        dlInfo(),
      ]);
      issuedAt = Date.now();
      const origin = start.url;
      const tgz = `${origin}${dl.path}`;
      const line = `npm i -g ${q(tgz)} && mcp-remote pair --code ${start.code} ${q(origin)}`;
      const verify =
        `curl -fsSLO ${q(tgz)} && echo "${dl.sha256}  ${dl.file}" | sha256sum -c - && ` +
        `npm i -g ./${dl.file} && mcp-remote pair --code ${start.code} ${q(origin)}`;
      const mins = Math.max(1, Math.round((start.expires_at - Date.now()) / 60_000));
      paired = h("p", { class: "paired", hidden: "" });
      const details = h("details", {}, h("summary", {}, "Verify the download first"));
      details.append(
        h("p", { class: "muted small" }, `mcp-remote ${dl.version}, ${Math.round(dl.bytes / 1024)} KiB, sha256 ${dl.sha256}`),
        commandBox(verify),
        h("p", { class: "muted small" }, "On macOS use `shasum -a 256 -c -` instead of `sha256sum -c -`."),
      );
      body.replaceChildren(
        h("p", { class: "small" }, h("strong", {}, "1. "), "Paste this on the computer:"),
        commandBox(line),
        h(
          "p",
          { class: "muted small" },
          `The code works once and expires in ${mins} min. Anyone who sees it can pair a computer to your account until then, so don't share it. ` +
            "If `npm i -g` needs root, set a user prefix first: `npm config set prefix ~/.local` (with ~/.local/bin on your PATH).",
        ),
        details,
        h("p", { class: "small" }, h("strong", {}, "2. "), "Run the daemon as a user service (starts at login, restarts on crashes):"),
        commandBox("mcp-remote install-service"),
        h("p", { class: "small" }, h("strong", {}, "3. "), "Register the channel with Claude Code (once per computer):"),
        commandBox("mcp-remote setup-claude"),
        h(
          "p",
          { class: "muted small" },
          "Then start sessions from this app (allow folders first: `mcp-remote projects add <folder>`), or at the desk with " +
            "`claude --dangerously-load-development-channels server:mcp-remote`.",
        ),
        paired,
      );
      btn.textContent = "Get a new code";
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not start pairing");
    } finally {
      btn.disabled = false;
    }
  };

  return {
    root,
    update(machines: MachineRecord[]) {
      if (!issuedAt) {
        known = new Set(machines.map((m) => m.machine_id));
        return;
      }
      const fresh = machines.filter((m) => !known.has(m.machine_id) && !m.revoked && m.created_at >= issuedAt - 60_000);
      if (paired && fresh.length) {
        paired.hidden = false;
        paired.textContent = `Paired: ${fresh.map((m) => m.name).join(", ")}. ${fresh.some((m) => m.online) ? "Its daemon is connected." : "Waiting for its daemon to connect (step 2)."}`;
      }
    },
  };
}
