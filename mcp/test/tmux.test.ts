import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Tmux, parseList, spawnArgs, tmuxVersionOk, which } from "../src/tmux";

const O = { bin: "tmux", socket: "mcp-remote" };
const spec = {
  name: "mr-0123456789ab",
  cwd: "/home/you/code/my project",
  env: { MCP_REMOTE_SESSION_ID: "mr-0123456789ab", MCP_REMOTE_LAUNCH_TOKEN: "tok" },
  argv: ["/usr/bin/claude", "--dangerously-load-development-channels", "server:mcp-remote", "--permission-mode", "acceptEdits"],
};

describe("tmux argv", () => {
  it("builds a detached session on our own socket that runs claude directly (no shell)", () => {
    const a = spawnArgs(O, spec);
    expect(a.slice(0, 4)).toEqual(["-L", "mcp-remote", "-f", "/dev/null"]);
    const dd = a.indexOf("--");
    expect(a.slice(4, dd)).toEqual([
      "new-session", "-d", "-s", "mr-0123456789ab", "-x", "200", "-y", "50",
      "-c", "/home/you/code/my project",
      "-e", "MCP_REMOTE_SESSION_ID=mr-0123456789ab", "-e", "MCP_REMOTE_LAUNCH_TOKEN=tok",
    ]);
    const sep = a.indexOf(";");
    expect(a.slice(dd + 1, sep)).toEqual(spec.argv);
    expect(a.slice(sep + 1)).toEqual(["set-option", "-w", "-t", "mr-0123456789ab", "remain-on-exit", "on"]);
    expect(a.filter((x) => x === ";")).toHaveLength(1);
    expect(a).not.toContain("sh");
    expect(a).not.toContain("-c ");
  });

  it("refuses names, args and env that could escape", () => {
    expect(() => spawnArgs(O, { ...spec, name: "mr-x;kill" })).toThrow(/session name/);
    expect(() => spawnArgs(O, { ...spec, argv: ["claude"] })).toThrow(/at least 2/);
    expect(() => spawnArgs(O, { ...spec, argv: [...spec.argv, "x;"] })).toThrow(/refusing/);
    expect(() => spawnArgs(O, { ...spec, env: { "BAD KEY": "1" } })).toThrow(/bad env/);
    expect(() => spawnArgs(O, { ...spec, env: { K: "v;" } })).toThrow(/bad env/);
  });

  it("parses list-panes output and versions", () => {
    expect(parseList("mr-aaaaaaaaaaaa|0|\nmr-bbbbbbbbbbbb|1|7\nod|d|1|\n")).toEqual([
      { name: "mr-aaaaaaaaaaaa", dead: false, status: null },
      { name: "mr-bbbbbbbbbbbb", dead: true, status: 7 },
      { name: "od|d", dead: true, status: null },
    ]);
    expect(tmuxVersionOk("tmux 3.4")).toBe(true);
    expect(tmuxVersionOk("tmux 3.2a")).toBe(true);
    expect(tmuxVersionOk("tmux 3.1c")).toBe(false);
    expect(tmuxVersionOk("tmux next-3.6")).toBe(true);
    expect(tmuxVersionOk("garbage")).toBe(false);
  });
});

const tmuxBin = which("tmux");
const socket = `mr-test-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), "mcpr-tmux-"));
afterAll(() => {
  if (tmuxBin) {
    try {
      execFileSync(tmuxBin, ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* not running */
    }
  }
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!tmuxBin)("real tmux", () => {
  it("passes arguments literally, keeps the dead pane, reports the exit status and env", async () => {
    const t = new Tmux({ bin: tmuxBin!, socket });
    expect(tmuxVersionOk(await t.version())).toBe(true);
    expect(await t.list()).toEqual([]); // no server yet
    const name = "mr-00000000beef";
    await t.spawn({
      name,
      cwd: work,
      env: { MCP_REMOTE_SESSION_ID: name },
      argv: ["sh", "-c", 'printf "%s|%s|%s\\n" "$1" "$MCP_REMOTE_SESSION_ID" "$(pwd)"; exit 3', "argv0", "$(id);`whoami`"],
    });
    let p;
    for (let i = 0; i < 50; i++) {
      p = (await t.list()).find((x) => x.name === name);
      if (p?.dead) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(p).toEqual({ name, dead: true, status: 3 });
    expect(await t.capture(name)).toMatch(/Pane is dead/); // the screen only shows the notice
    const screen = await t.capture(name, 60);
    expect(screen).toContain(`$(id);\`whoami\`|${name}|${work}`);
    expect((await t.showEnv(name)).MCP_REMOTE_SESSION_ID).toBe(name);
    await t.kill(name);
    await t.kill(name); // idempotent
    expect((await t.list()).find((x) => x.name === name)).toBeUndefined();
  });
});
