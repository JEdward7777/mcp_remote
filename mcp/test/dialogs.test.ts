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
    expect(d).toEqual({ kind: "dev_channels", channels: ["server:mcp-remote"], option1: true });
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
});
