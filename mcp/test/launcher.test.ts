// Launcher lifecycle against a fake tmux driver (no real Claude Code, no real tmux).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRecord } from "@mcp-remote/shared";
import { LaunchConfig, projectIdFor } from "../src/launch-config";
import { Launcher, MAX_AUTO_RESTARTS } from "../src/launcher";
import { FakeTmux } from "./fake-tmux";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeout = 3000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

let dir: string;
let proj: string;
let tmux: FakeTmux;
let changes: LaunchRecord[][];
let launchers: Launcher[];
let cfg: LaunchConfig;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcpr-l-")));
  process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
  proj = join(dir, "code", "alpha");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(dir, "code", "beta"));
  tmux = new FakeTmux();
  changes = [];
  launchers = [];
  cfg = LaunchConfig.parse({
    roots: [join(dir, "code")],
    claude_path: "/opt/fake/claude",
    permission_mode: "acceptEdits",
    extra_args: ["--model", "opus"],
    max_sessions: 2,
    startup_timeout_s: 10,
  });
});
afterEach(() => {
  for (const l of launchers) l.dispose();
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function make(over: Partial<ConstructorParameters<typeof Launcher>[0]> = {}): Launcher {
  const l = new Launcher({
    loadConfig: () => cfg,
    onChange: (r) => changes.push(r),
    tmux,
    tickMs: 10,
    livenessMs: 20,
    restartBaseMs: 20,
    stopWaitMs: 200,
    extraEnv: { MCP_REMOTE_SOCKET: "/tmp/d.sock" },
    ...over,
  });
  launchers.push(l);
  return l;
}
const alphaId = () => projectIdFor(proj);
const rec = (l: Launcher, id: string) => l.records().find((r) => r.launch_id === id)!;

describe("launcher", () => {
  it("advertises allowlisted projects without paths", async () => {
    const l = make();
    await l.init();
    const info = l.info();
    expect(info).toMatchObject({ available: true, launch_error: null, max_sessions: 2 });
    expect(info.projects.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(JSON.stringify(info)).not.toContain(dir);
  });

  it("launches in tmux with the configured mode, links the shim by token, and reports running", async () => {
    const l = make();
    await l.init();
    const r = await l.launch(alphaId(), { continue: false });
    expect(r.ok).toBe(true);
    const id = (r as { launch_id: string }).launch_id;
    expect(id).toMatch(/^mr-[0-9a-f]{12}$/);
    const spec = tmux.spawns[0]!;
    expect(spec.name).toBe(id);
    expect(spec.cwd).toBe(proj);
    expect(spec.argv).toEqual([
      "/opt/fake/claude",
      "--dangerously-load-development-channels",
      "server:mcp-remote",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
    ]);
    expect(spec.env).toMatchObject({ MCP_REMOTE_SESSION_ID: id, MCP_REMOTE_PROJECT_ID: alphaId(), MCP_REMOTE_SOCKET: "/tmp/d.sock" });
    expect(spec.env.MCP_REMOTE_LAUNCH_TOKEN).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(rec(l, id).state).toBe("starting");

    expect(l.shimRegister(id, "wrong")).toBe("reject");
    expect(l.shimRegister(id, undefined)).toBe("reject");
    expect(l.shimRegister("someone-else", undefined)).toBe("none");
    expect(l.shimRegister(id, spec.env.MCP_REMOTE_LAUNCH_TOKEN)).toBe("linked");
    expect(rec(l, id)).toMatchObject({ state: "running", session_id: id, project: "alpha", continued: false });
    expect(changes.at(-1)!.find((x) => x.launch_id === id)!.state).toBe("running");

    // state file is private and does not leak into the public record
    const st = statSync(l.statePath);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readFileSync(l.statePath, "utf8")).toContain(proj);
    expect(JSON.stringify(l.records())).not.toContain(spec.env.MCP_REMOTE_LAUNCH_TOKEN!);
  });

  it("refuses ids that are not allowlisted, and enforces the concurrent cap", async () => {
    const l = make();
    await l.init();
    expect(await l.launch(projectIdFor(join(dir, "elsewhere")), { continue: false })).toMatchObject({ ok: false, error: /allowlist/ });
    expect(await l.launch(proj, { continue: false })).toMatchObject({ ok: false });
    expect((await l.launch(alphaId(), { continue: false })).ok).toBe(true);
    expect((await l.launch(alphaId(), { continue: false })).ok).toBe(true);
    expect(await l.launch(alphaId(), { continue: false })).toMatchObject({ ok: false, error: /max 2/ });
    expect(tmux.spawns).toHaveLength(2);
  });

  it("accepts only the development-channels warning for our server, and reports other dialogs", async () => {
    const fx = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8");
    tmux.onKeys = (name) => {
      tmux.sessions.get(name)!.screen = fx("running.txt");
    };
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    tmux.sessions.get(a.launch_id)!.screen = fx("dev-channels.txt");
    await waitFor(() => tmux.keys.length === 1, "keys sent");
    expect(tmux.keys[0]).toEqual({ name: a.launch_id, keys: ["1"] });
    await sleep(50);
    expect(tmux.keys).toHaveLength(1);
    expect(rec(l, a.launch_id).state).toBe("starting");

    const b = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    tmux.sessions.get(b.launch_id)!.screen = fx("trust.txt");
    await waitFor(() => rec(l, b.launch_id).state === "needs_attention", "needs_attention");
    expect(rec(l, b.launch_id).detail).toMatch(/trust "alpha".*mcp-remote attach mr-/);
    expect(tmux.keys.filter((k) => k.name === b.launch_id)).toHaveLength(0);
    // Answered at the desk: the dialog goes away and the shim registers.
    tmux.sessions.get(b.launch_id)!.screen = fx("running.txt");
    await waitFor(() => rec(l, b.launch_id).state === "starting", "back to starting");
    l.shimRegister(b.launch_id, tmux.sessions.get(b.launch_id)!.spec.env.MCP_REMOTE_LAUNCH_TOKEN);
    expect(rec(l, b.launch_id).state).toBe("running");
  });

  it("gives up on a warning that won't go away, and times out when no shim appears", async () => {
    cfg = LaunchConfig.parse({ ...cfg, startup_timeout_s: 10 });
    const fx = readFileSync(join(__dirname, "fixtures", "dev-channels.txt"), "utf8");
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    tmux.sessions.get(a.launch_id)!.screen = fx;
    await waitFor(() => rec(l, a.launch_id).state === "needs_attention", "needs_attention", 3000);
    expect(tmux.keys).toHaveLength(3);
    expect(rec(l, a.launch_id).detail).toMatch(/could not be dismissed/);
  });

  it("reports exit codes and Claude Code's last line; stop is not a crash", async () => {
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: true })) as { launch_id: string };
    expect(tmux.spawns[0]!.argv).toContain("--continue");
    tmux.die(a.launch_id, 1, "No conversation found to continue");
    await waitFor(() => rec(l, a.launch_id).state === "exited", "exited");
    expect(rec(l, a.launch_id)).toMatchObject({ exit_code: 1, detail: expect.stringMatching(/restart without --continue/) });
    expect(tmux.sessions.has(a.launch_id)).toBe(false); // dead pane cleaned up

    const r = await l.restart(a.launch_id, false);
    expect(r.ok).toBe(true);
    expect(tmux.spawns[1]!.argv).not.toContain("--continue");
    expect(tmux.spawns[1]!.env.MCP_REMOTE_LAUNCH_TOKEN).not.toBe(tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    l.shimRegister(a.launch_id, tmux.spawns[1]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    expect((await l.stop(a.launch_id)).ok).toBe(true);
    expect(rec(l, a.launch_id)).toMatchObject({ state: "exited", exit_code: null, detail: "stopped from the phone" });
    expect(tmux.sessions.has(a.launch_id)).toBe(false);
    expect((await l.dismiss(a.launch_id)).ok).toBe(true);
    expect(l.records()).toEqual([]);
  });

  it("restarts a running session in place: kills the old spawn, waits for its shim, keeps the id", async () => {
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    l.shimRegister(a.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    setTimeout(() => l.shimDown(a.launch_id), 30); // the old shim goes away after the kill
    const r = await l.restart(a.launch_id, true);
    expect(r).toEqual({ ok: true, launch_id: a.launch_id });
    expect(tmux.spawns).toHaveLength(2);
    expect(tmux.spawns[1]!.name).toBe(a.launch_id);
    expect(tmux.spawns[1]!.argv).toContain("--continue");
    expect(rec(l, a.launch_id)).toMatchObject({ state: "starting", continued: true });
    expect(l.shimRegister(a.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN)).toBe("reject");
  });

  it("auto-restarts crashes with backoff and a cap, never a clean exit", async () => {
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false, auto_restart: true })) as { launch_id: string };
    l.shimRegister(a.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    for (let i = 1; i <= MAX_AUTO_RESTARTS; i++) {
      tmux.die(a.launch_id, 137, "Killed");
      await waitFor(() => tmux.spawns.length === i + 1, `restart ${i}`, 5000);
      // After the first successful run, auto-restart resumes the conversation.
      expect(tmux.spawns[i]!.argv).toContain("--continue");
      expect(rec(l, a.launch_id).restarts).toBe(i);
    }
    tmux.die(a.launch_id, 137, "Killed");
    await waitFor(() => rec(l, a.launch_id).state === "failed", "failed", 5000);
    expect(rec(l, a.launch_id).detail).toMatch(/auto-restart stopped/);
    await sleep(100);
    expect(tmux.spawns).toHaveLength(MAX_AUTO_RESTARTS + 1);

    const b = (await l.launch(alphaId(), { continue: false, auto_restart: true })) as { launch_id: string };
    tmux.die(b.launch_id, 0, "bye");
    await waitFor(() => rec(l, b.launch_id).state === "exited", "clean exit");
    await sleep(100);
    expect(tmux.spawns.filter((s) => s.name === b.launch_id)).toHaveLength(1);
  });

  it("stop cancels a pending auto-restart", async () => {
    const l = make({ restartBaseMs: 400 });
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false, auto_restart: true })) as { launch_id: string };
    tmux.die(a.launch_id, 2, "boom");
    await waitFor(() => rec(l, a.launch_id).detail?.includes("restarting in"), "restart pending");
    await l.stop(a.launch_id);
    await sleep(900);
    expect(tmux.spawns).toHaveLength(1);
    expect(rec(l, a.launch_id).detail).toBe("auto-restart cancelled");
  });

  it("re-adopts live sessions after a daemon restart and settles the ones that ended", async () => {
    const l1 = make();
    await l1.init();
    const live = (await l1.launch(alphaId(), { continue: false })) as { launch_id: string };
    const gone = (await l1.launch(alphaId(), { continue: false })) as { launch_id: string };
    l1.shimRegister(live.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    l1.dispose();
    await tmux.kill(gone.launch_id); // ended while no daemon was running

    const l2 = make();
    await l2.init();
    expect(rec(l2, gone.launch_id)).toMatchObject({ state: "exited", detail: expect.stringMatching(/not running/) });
    expect(rec(l2, live.launch_id)).toMatchObject({ state: "starting", detail: expect.stringMatching(/re-adopted/) });
    // The old shim reconnects to the new daemon with the token it inherited.
    expect(l2.shimRegister(live.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN)).toBe("linked");
    expect(rec(l2, live.launch_id).state).toBe("running");
  });

  it("adopts an orphan mr-* session only if it carries a launch identity for an allowlisted project", async () => {
    const mk = (name: string, env: Record<string, string>) =>
      tmux.spawn({ name, cwd: proj, env, argv: ["claude", "x"] });
    await mk("mr-aaaaaaaaaaaa", { MCP_REMOTE_SESSION_ID: "mr-aaaaaaaaaaaa", MCP_REMOTE_LAUNCH_TOKEN: "t1", MCP_REMOTE_PROJECT_ID: alphaId() });
    await mk("mr-bbbbbbbbbbbb", { MCP_REMOTE_SESSION_ID: "mr-bbbbbbbbbbbb", MCP_REMOTE_LAUNCH_TOKEN: "t2", MCP_REMOTE_PROJECT_ID: "pnotallowed00000" });
    await mk("mr-cccccccccccc", {});
    const l = make();
    await l.init();
    expect(l.records().map((r) => r.launch_id)).toEqual(["mr-aaaaaaaaaaaa"]);
    expect(l.shimRegister("mr-aaaaaaaaaaaa", "t1")).toBe("linked");
    expect(tmux.sessions.has("mr-bbbbbbbbbbbb")).toBe(true); // left alone
  });

  it("reports why launching is unavailable", async () => {
    const noTmux = new Launcher({ loadConfig: () => ({ ...cfg, tmux_path: null }), onChange: () => {}, platform: "win32" });
    launchers.push(noTmux);
    await noTmux.init();
    expect(noTmux.info()).toMatchObject({ available: false, launch_error: expect.stringMatching(/Windows/) });
    expect(await noTmux.launch(alphaId(), { continue: false })).toMatchObject({ ok: false, error: /Windows/ });

    tmux.version = async () => "tmux 3.0a";
    const old = make();
    await old.init();
    expect(old.info()).toMatchObject({ available: false, launch_error: expect.stringMatching(/3\.2/) });

    tmux.version = async () => "tmux 3.4";
    const bad = make({ loadConfig: () => { throw new Error("launch.json: permission_mode: invalid"); } });
    await bad.init();
    expect(bad.info()).toMatchObject({ available: false, launch_error: expect.stringMatching(/invalid/) });
  });

  it("fails clearly when claude cannot be found", async () => {
    cfg = LaunchConfig.parse({ ...cfg, claude_path: null });
    const l = make();
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      await l.init();
      const r = await l.launch(alphaId(), { continue: false });
      expect(r).toMatchObject({ ok: false, error: /claude command was not found/ });
    } finally {
      process.env.PATH = path;
    }
  });
});
