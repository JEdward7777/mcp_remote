import { describe, expect, it } from "vitest";
import { CHANNEL_FLAG, activation, ancestors, cmdlineOf, parentOf } from "../src/proc";

describe("shim activation (round-2 finding)", () => {
  it("activates only with launch env, a fixed id, an explicit override, or a channel-flagged parent", () => {
    expect(activation({ MCP_REMOTE_LAUNCH_TOKEN: "t" }, "claude -p hi").active).toBe(true);
    expect(activation({ MCP_REMOTE_SESSION_ID: "x" }, "claude mcp list").active).toBe(true);
    expect(activation({ MCP_REMOTE_ACTIVATE: "1" }, "claude -p hi").active).toBe(true);
    expect(activation({}, `claude ${CHANNEL_FLAG} server:mcp-remote --permission-mode acceptEdits`).active).toBe(true);
    expect(activation({}, `claude ${CHANNEL_FLAG}=server:mcp-remote`).active).toBe(true);
    for (const cmd of ["claude mcp list", "claude -p summarize", "claude", "claude --channels plugin:x@y", "claude --dangerously-load-development-channelsX"]) {
      const a = activation({}, cmd);
      expect(a.active).toBe(false);
      expect(a.reason).toContain(CHANNEL_FLAG);
    }
    expect(activation({}, null)).toMatchObject({ active: true, reason: expect.stringMatching(/cannot inspect/) });
  });

  it.skipIf(process.platform === "win32")("reads this process's parent and ancestors", () => {
    expect(parentOf(process.pid)).toBe(process.ppid);
    expect(cmdlineOf(process.pid)).toContain("node");
    const a = ancestors(4);
    expect(a[0]).toBe(process.ppid);
    expect(a.length).toBeGreaterThan(0);
  });
});
