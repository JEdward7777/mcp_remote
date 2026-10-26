import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Tmux, assertName, parseList, spawnArgs, tmuxVersionOk, which } from "../src/tmux";

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
      "-e", "MCP_REMOTE_SESSION_ID=mr-0123456789ab", "-e", "MCP_REMOTE_LAUNCH_TOKEN=tok",
    ]);
    const sep = a.indexOf(";");
    expect(a.slice(dd + 1, sep)).toEqual(spec.argv);
    expect(a.slice(sep + 1)).toEqual(["set-option", "-w", "-t", "mr-0123456789ab", "remain-on-exit", "on"]);
    expect(a.filter((x) => x === ";")).toHaveLength(1);
    expect(a).not.toContain("sh");
    // The folder is never a tmux argument (tmux format-expands -c): it is execFile's cwd instead.
    expect(a).not.toContain("-c");
    expect(a.join(" ")).not.toContain("my project");
  });

  it("refuses names, args and env that could escape", () => {
    expect(() => spawnArgs(O, { ...spec, name: "mr-x;kill" })).toThrow(/session name/);
    expect(() => spawnArgs(O, { ...spec, argv: ["claude"] })).toThrow(/at least 2/);
    expect(() => spawnArgs(O, { ...spec, argv: [...spec.argv, "x;"] })).toThrow(/refusing/);
    expect(() => spawnArgs(O, { ...spec, env: { "BAD KEY": "1" } })).toThrow(/bad env/);
    expect(() => spawnArgs(O, { ...spec, env: { K: "v;" } })).toThrow(/bad env/);
    for (const n of ["#(id)", "mr-0123456789ab#{x}", "=mr-0123456789ab", "mr-0123456789ab:1"]) expect(() => assertName(n)).toThrow();
  });

  it("parses list-panes output and versions", () => {
    expect(parseList("mr-aaaaaaaaaaaa|42|0|\nmr-bbbbbbbbbbbb|43|1|7\nod|d||1|\n")).toEqual([
      { name: "mr-aaaaaaaaaaaa", pid: 42, dead: false, status: null },
      { name: "mr-bbbbbbbbbbbb", pid: 43, dead: true, status: 7 },
      { name: "od|d", pid: null, dead: true, status: null },
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
const work = realpathSync(mkdtempSync(join(tmpdir(), "mcpr-tmux-")));
afterAll(() => {
  if (tmuxBin) {
    try {
      execFileSync(tmuxBin, ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      /* not running */
    }
    // kill-server can leave the socket file behind (round-3 nit).
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
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
    for (let i = 0; i < 60; i++) {
      p = (await t.list()).find((x) => x.name === name);
      if (p?.dead && p.status !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(p).toMatchObject({ name, dead: true });
    // tmux 3.4 occasionally never records the status (the reason run-claude exists; its own test is strict).
    expect([3, null]).toContain(p!.status);
    expect(p!.pid).toBeGreaterThan(1);
    expect(await t.capture(name)).toMatch(/Pane is dead/); // the screen only shows the notice
    const screen = await t.capture(name, 60);
    expect(screen).toContain(`$(id);\`whoami\`|${name}|${work}`);
    expect((await t.showEnv(name)).MCP_REMOTE_SESSION_ID).toBe(name);
    await t.kill(name);
    await t.kill(name); // idempotent
    expect((await t.list()).find((x) => x.name === name)).toBeUndefined();
  });

  it("starts in folders with hostile names without tmux expanding them (round-1 finding)", async () => {
    const t = new Tmux({ bin: tmuxBin!, socket });
    const base = join(work, "hostile");
    mkdirSync(base);
    const names = ["#(touch PWNED)", "#{session_name}", "x#(touch PWNED2)y", "trail;", "semi;colon", "q\"u'o $(touch PWNED3)", "new\nline", "#[fg=red]##"];
    let i = 0;
    for (const n of names) {
      const dir = join(base, n);
      mkdirSync(dir);
      const name = `mr-${(0xc0de00 + i).toString(16).padStart(12, "0")}`;
      const out = join(work, `cwd-${i++}.txt`);
      await t.spawn({
        name,
        cwd: dir,
        env: { V: n.replace(/;$/, "") },
        argv: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], process.cwd() + '\\0' + process.env.V)", out],
      });
      for (let k = 0; k < 100 && !existsSync(out); k++) await new Promise((r) => setTimeout(r, 30));
      const [cwd, v] = readFileSync(out, "utf8").split("\0");
      expect(cwd).toBe(dir);
      expect(v).toBe(n.replace(/;$/, ""));
      await t.kill(name);
    }
    const all = [...(readdirSync(work, { recursive: true }) as string[]), ...readdirSync(process.cwd())];
    expect(all.filter((f) => /(^|\/)PWNED/.test(f))).toEqual([]);
  });

  it("run-claude records the exit status even when tmux does not (round-1 follow-up)", async () => {
    const cli = join(__dirname, "..", "dist", "cli.js"); // built by `npm test`
    const t = new Tmux({ bin: tmuxBin!, socket });
    for (let i = 0; i < 12; i++) {
      const name = `mr-${(0xe0e000 + i).toString(16).padStart(12, "0")}`;
      const file = join(work, `${name}.exit`);
      await t.spawn({
        name,
        cwd: work,
        env: { MCP_REMOTE_LAUNCH_TOKEN: `tok${i}` },
        argv: [process.execPath, cli, "run-claude", "--status-file", file, "--", process.execPath, "-e", "console.log('bye'); process.exit(7)"],
      });
      for (let k = 0; k < 100 && !existsSync(file); k++) await new Promise((r) => setTimeout(r, 30));
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: `tok${i}`, code: 7, signal: null });
      await t.kill(name);
    }
  });
});
