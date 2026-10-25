// Recognize Claude Code's interactive startup dialogs in a captured tmux pane.
//
// Verified against Claude Code 2.1.310 in tmux (scratch HOME, fixtures in mcp/test/fixtures/):
//   order: workspace trust -> "New MCP server found" (.mcp.json servers only) -> Bypass Permissions warning
//   (only with bypassPermissions) -> development-channels warning. MCP servers are spawned only after the
//   development-channels warning is accepted. In the trust, MCP-consent and bypass dialogs the highlighted
//   default is the refusing option, so pressing Enter blindly would exit or disable the shim.
//
// Policy: the daemon answers exactly one dialog, the development-channels warning, and only when it lists
// nothing but our own server (the user opted into it by configuring launches), only when the screen is
// exactly that dialog (strict layout check), and only for a session it just spawned whose shim has never
// connected (Claude Code starts MCP servers only after this warning, so a linked shim means it is past it). Everything else is a
// decision the user makes at the desk, reported to the phone as needs_attention with what to do.

export type Dialog =
  /** `wellFormed`: the screen is exactly the full-screen warning (see devChannelsDialog); only then is it answerable. */
  | { kind: "dev_channels"; channels: string[]; wellFormed: boolean }
  | { kind: "trust" }
  | { kind: "mcp_consent"; server: string }
  | { kind: "bypass" }
  | { kind: "login" };

const DEV_HEADER = "WARNING: Loading development channels";
const DEV_OPTION1 = /^(?:\u276F\s*)?1\.\s*I am using this for local development$/;
const DEV_OPTION2 = /^(?:\u276F\s*)?2\.\s*Exit$/;
const FOOTER = /^Enter to confirm \u00B7 Esc to cancel$/;
const RULE = /^[\u2500\u2501\u2550-]{20,}$/;
/** Text of any other Claude Code prompt; if it is on screen too, nothing is answered. */
const OTHER_PROMPTS = /Do you want to|Yes, I trust this folder|New MCP server found|Bypass Permissions mode|Select login method|\b(?:3|4)\.\s/;

/**
 * The development-channels warning, strictly: a full-screen dialog whose top border is the first non-blank
 * line, the header right below it, then the Channels line, option 1, option 2 ("Exit") and the footer in
 * that order, nothing but blank lines after the footer, and no other prompt's text anywhere on screen.
 * (Layout verified on Claude Code 2.1.310: test/fixtures/dev-channels-raw.txt.) Anything that merely
 * contains the wording, e.g. Claude printing it in a live session, is not well-formed.
 */
function devChannelsDialog(screen: string): Dialog | null {
  if (!screen.includes(DEV_HEADER) || !screen.includes("I am using this for local development")) return null;
  const lines = screen.split("\n").map((l) => l.trim());
  const m = /Channels:\s*(.+)/.exec(screen);
  const channels = m ? m[1]!.trim().split(/\s+/).filter(Boolean) : [];
  const bad: Dialog = { kind: "dev_channels", channels, wellFormed: false };
  const nonBlank = lines.map((l, i) => [l, i] as const).filter(([l]) => l.length > 0);
  if (nonBlank.length < 6) return bad;
  const [first, header] = nonBlank;
  if (!RULE.test(first![0]) || header![0] !== DEV_HEADER) return bad;
  if (lines.filter((l) => l === DEV_HEADER).length !== 1) return bad;
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const ch = idx(/^Channels:\s/);
  const o1 = idx(DEV_OPTION1);
  const o2 = idx(DEV_OPTION2);
  const ft = idx(FOOTER);
  if (!(header![1] < ch && ch < o1 && o1 < o2 && o2 < ft)) return bad;
  if (ft - header![1] > 20) return bad;
  if (lines.slice(ft + 1).some((l) => l.length > 0)) return bad;
  if (OTHER_PROMPTS.test(screen)) return bad;
  return { kind: "dev_channels", channels, wellFormed: true };
}

export function detectDialog(screen: string): Dialog | null {
  const s = screen.replace(/\r/g, "");
  const dev = devChannelsDialog(s);
  if (dev) return dev;
  if (/Yes, I trust this folder/.test(s) || /Is this a project you created or one you trust\?/.test(s)) return { kind: "trust" };
  const mcp = /New MCP server found in this project:\s*(\S+)/.exec(s);
  if (mcp) return { kind: "mcp_consent", server: mcp[1]! };
  if (/WARNING: Claude Code running in Bypass Permissions mode/.test(s)) return { kind: "bypass" };
  // ASSUMED (not observable here: this sandbox was already authenticated): the login method picker.
  if (/Select login method/i.test(s) || /Missing API key/i.test(s)) return { kind: "login" };
  return null;
}

/** May the daemon answer this dialog itself? */
export function autoAcceptable(d: Dialog, serverName: string): boolean {
  return d.kind === "dev_channels" && d.wellFormed && d.channels.length === 1 && d.channels[0] === `server:${serverName}`;
}

/** Keys that select "1. I am using this for local development" (verified: the digit selects and confirms). */
export const DEV_CHANNELS_KEYS = ["1"];

/** What the phone shows for a dialog the daemon leaves to the user. */
export function attentionText(d: Dialog, ctx: { project: string; serverName: string; attach: string }): string {
  switch (d.kind) {
    case "trust":
      return `Claude Code asks whether you trust "${ctx.project}". At the desk run \`claude\` once in that folder (or a parent folder) and choose "Yes, I trust this folder", then restart. Or answer it now: ${ctx.attach}`;
    case "mcp_consent":
      return `Claude Code asks to approve the project's .mcp.json server "${d.server}". Register the shim for all projects with \`mcp-remote setup-claude\` (no prompt), or answer it at the desk: ${ctx.attach}`;
    case "bypass":
      return `Claude Code shows its Bypass Permissions warning. Accept it once at the desk (${ctx.attach}); Claude Code then remembers it (skipDangerousModePermissionPrompt in ~/.claude/settings.json)`;
    case "login":
      return `Claude Code needs you to log in. Run \`claude\` at the desk and log in, then restart. (${ctx.attach})`;
    case "dev_channels":
      return d.channels.length === 1 && d.channels[0] === `server:${ctx.serverName}`
        ? `The development-channels warning (or text like it) is on screen and was not answered automatically. Answer it at the desk: ${ctx.attach}`
        : `The development-channels warning lists other channels too (${d.channels.join(" ")}); not answered automatically. Check extra_args, or answer it at the desk: ${ctx.attach}`;
  }
}

/** Last non-empty line of a dead pane, trimmed for the phone. */
export function lastLine(screen: string, max = 200): string | null {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const l = lines[lines.length - 1];
  if (!l) return null;
  // Strip anything that is not printable (escape sequences are not captured without -e, but be safe).
  const clean = l.replace(/[\u0000-\u001f\u007f]/g, "");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

export const NO_CONVERSATION = /No conversation found to continue/;
