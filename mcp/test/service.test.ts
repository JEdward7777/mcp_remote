import { describe, expect, it } from "vitest";
import { mcpAddArgs } from "../src/desk";
import { launchdPlist, sdQuote, systemdUnit, windowsSteps } from "../src/service";

const spec = { node: "/home/you/.nvm/versions/node/v22.22.0/bin/node", cli: "/home/you/My Apps/mcp-remote/dist/cli.js", path: "/usr/bin:/bin" };

describe("service files", () => {
  it("writes a systemd user unit with absolute paths, exit-code policy and KillMode=process", () => {
    const u = systemdUnit(spec);
    expect(u).toContain(`ExecStart="${spec.node}" "/home/you/My Apps/mcp-remote/dist/cli.js" daemon`);
    expect(u).toMatch(/^Restart=on-failure$/m);
    expect(u).toMatch(/^RestartPreventExitStatus=3 4$/m);
    expect(u).toMatch(/^KillMode=process$/m);
    expect(u).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(u).not.toContain('Environment="MCP_REMOTE_CONFIG_DIR');
    expect(u).toMatch(/^WantedBy=default.target$/m);
    expect(systemdUnit({ ...spec, configDir: "/tmp/x" })).toContain('Environment="MCP_REMOTE_CONFIG_DIR=/tmp/x"');
    // Round 6: Claude Code's own config dir travels too (shim registration + login live there).
    expect(systemdUnit({ ...spec, claudeConfigDir: "/home/you/.claude-work" })).toContain('Environment="CLAUDE_CONFIG_DIR=/home/you/.claude-work"');
    expect(u).not.toContain('Environment="CLAUDE_CONFIG_DIR');
    expect(u).toMatch(/service\.env/); // points at where secrets go
  });

  it("escapes systemd specials", () => {
    expect(sdQuote('a "b" 100% $HOME \\x')).toBe('"a \\"b\\" 100%% $$HOME \\\\x"');
    // Environment= does not expand $ (round-1 nit): keep it literal there.
    expect(sdQuote("PATH=/opt/$x/bin", "env")).toBe('"PATH=/opt/$x/bin"');
    expect(systemdUnit({ ...spec, path: "/a$b:/bin" })).toContain('Environment="PATH=/a$b:/bin"');
    expect(systemdUnit({ ...spec, node: "/n$x/node" })).toContain('ExecStart="/n$$x/node"');
    expect(() => sdQuote("a\nb")).toThrow();
  });

  it("writes a launchd agent that restarts only on non-zero exit and maps 3/4 to exit 0", () => {
    const p = launchdPlist({ ...spec, cli: "/a&b/<cli>.js", logDir: "/Users/you/Library/Logs" });
    expect(p).toContain("<string>/a&amp;b/&lt;cli&gt;.js</string>");
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(p).toMatch(/<key>MCP_REMOTE_FATAL_EXIT_ZERO<\/key>\s*<string>1<\/string>/);
    expect(p).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    expect(p).toContain("<string>/Users/you/Library/Logs/mcp-remote.log</string>");
    expect(p).toContain("<string>daemon</string>");
    expect(launchdPlist({ ...spec, claudeConfigDir: "/Users/you/.claude-work" })).toMatch(
      /<key>CLAUDE_CONFIG_DIR<\/key>\s*<string>\/Users\/you\/.claude-work<\/string>/,
    );
  });

  it("prints Windows steps", () => {
    expect(windowsSteps(spec)).toMatch(/Task Scheduler/);
    expect(windowsSteps(spec)).toMatch(/MCP_REMOTE_FATAL_EXIT_ZERO=1/);
  });
});

describe("setup-claude", () => {
  it("puts the name first and --scope after the variadic -e (round-5 gotcha)", () => {
    expect(mcpAddArgs({ name: "mcp-remote", scope: "user", node: "/n", cli: "/c.js", env: {} })).toEqual([
      "mcp", "add", "mcp-remote", "--scope", "user", "--", "/n", "/c.js", "shim",
    ]);
    const a = mcpAddArgs({ name: "mcp-remote", scope: "user", node: "/n", cli: "/c.js", env: { MCP_REMOTE_CONFIG_DIR: "/d" } });
    expect(a).toEqual(["mcp", "add", "mcp-remote", "-e", "MCP_REMOTE_CONFIG_DIR=/d", "--scope", "user", "--", "/n", "/c.js", "shim"]);
    expect(a.join(" ")).not.toMatch(/MCP_REMOTE_SESSION_ID/);
  });
});
