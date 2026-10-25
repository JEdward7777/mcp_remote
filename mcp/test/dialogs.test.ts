// Fixtures are tmux captures of Claude Code 2.1.310 (scratch HOME), paths sanitized.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_CONVERSATION, attentionText, autoAcceptable, detectDialog, lastLine } from "../src/dialogs";

const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");
const ctx = { project: "proj1", serverName: "mcp-remote", attach: "mcp-remote attach mr-0123456789ab" };

describe("startup dialogs", () => {
  it("recognizes the development-channels warning and accepts it only for our own server", () => {
    const d = detectDialog(fx("dev-channels.txt"));
    expect(d).toEqual({ kind: "dev_channels", channels: ["server:mcp-remote"], wellFormed: true });
    expect(detectDialog(fx("dev-channels-raw.txt"))).toEqual(d); // unfiltered 160x50 capture
    expect(autoAcceptable(d!, "mcp-remote")).toBe(true);
    expect(autoAcceptable(d!, "other-name")).toBe(false);
    const extra = detectDialog(fx("dev-channels-extra.txt"))!;
    expect(extra).toMatchObject({ kind: "dev_channels", channels: ["server:mcp-remote", "server:evil"] });
    expect(autoAcceptable(extra, "mcp-remote")).toBe(false);
    expect(attentionText(extra, ctx)).toMatch(/other channels too/);
  });

  it("never auto-answers trust, MCP consent or the bypass warning", () => {
    const trust = detectDialog(fx("trust.txt"))!;
    expect(trust.kind).toBe("trust");
    expect(autoAcceptable(trust, "mcp-remote")).toBe(false);
    expect(attentionText(trust, ctx)).toMatch(/trust "proj1"/);
    const mcp = detectDialog(fx("mcp-consent.txt"))!;
    expect(mcp).toEqual({ kind: "mcp_consent", server: "mcp-remote" });
    expect(autoAcceptable(mcp, "mcp-remote")).toBe(false);
    expect(attentionText(mcp, ctx)).toMatch(/setup-claude/);
    const bp = detectDialog(fx("bypass.txt"))!;
    expect(bp.kind).toBe("bypass");
    expect(autoAcceptable(bp, "mcp-remote")).toBe(false);
    expect(attentionText(bp, ctx)).toContain("mcp-remote attach mr-0123456789ab");
  });

  it("sees no dialog on a started session or on exit messages", () => {
    expect(detectDialog(fx("running.txt"))).toBeNull();
    expect(detectDialog(fx("no-conversation.txt"))).toBeNull();
    expect(NO_CONVERSATION.test(fx("no-conversation.txt"))).toBe(true);
  });

  it("extracts a short last line", () => {
    expect(lastLine(fx("root-refused.txt"))).toMatch(/cannot be used with root\/sudo/);
    expect(lastLine("\n\n")).toBeNull();
    expect(lastLine("x".repeat(500))!.length).toBe(200);
  });

  it("does not treat the wording inside a live session as the dialog (round-1 finding)", () => {
    const dialog = fx("dev-channels-raw.txt");
    const ok = (t: string) => autoAcceptable(detectDialog(t)!, "mcp-remote");
    expect(ok(dialog)).toBe(true);
    // Claude printed the fixture in a running session: banner and prompt around it.
    expect(ok(fx("running.txt") + "\n" + dialog)).toBe(false);
    expect(ok(dialog.trimEnd() + "\n\n\u276F \n  \u23F5\u23F5 auto mode on\n")).toBe(false);
    // A real permission prompt below text that looks like the warning.
    const perm = dialog.trimEnd() + "\n\n Do you want to proceed?\n \u276F 1. Yes\n   2. No\n";
    expect(ok(perm)).toBe(false);
    // Header not right below the top border.
    const lines = dialog.split("\n");
    const hi = lines.findIndex((l) => l.includes("WARNING: Loading development channels"));
    const shifted = [...lines.slice(0, hi), "  some other text", ...lines.slice(hi)].join("\n");
    expect(ok(shifted)).toBe(false);
    // Text above the border (not a full-screen dialog).
    expect(ok("$ cat notes.txt\n" + dialog)).toBe(false);
    // Channels line after the options.
    const swapped = dialog.replace("  Channels: server:mcp-remote\n", "").replace("    2. Exit", "    2. Exit\n  Channels: server:mcp-remote");
    expect(ok(swapped)).toBe(false);
    // Still reported (needs_attention), just never answered.
    expect(detectDialog(perm)).toMatchObject({ kind: "dev_channels", wellFormed: false });
  });
});
