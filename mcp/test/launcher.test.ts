// Launcher lifecycle against a fake tmux driver (no real Claude Code, no real tmux).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRecord } from "@mcp-remote/shared";
import { LaunchConfig, projectIdFor } from "../src/launch-config";
import { Launcher, MAX_AUTO_RESTARTS, deadStatus } from "../src/launcher";
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
    keyRetryMs: 50,
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

  it("counts concurrent restarts against the cap", async () => {
    cfg = LaunchConfig.parse({ ...cfg, max_sessions: 1 });
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    await l.stop(a.launch_id);
    const b = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    await l.stop(b.launch_id);
    const rs = await Promise.all([l.restart(a.launch_id, false), l.restart(b.launch_id, false)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ error: /max 1/ });
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
    expect(rec(l, a.launch_id).detail).toMatch(/not answered automatically/);
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

  it("never reads or types into a re-adopted session, even if the warning is on its screen (round-1 finding)", async () => {
    const dialog = readFileSync(join(__dirname, "fixtures", "dev-channels-raw.txt"), "utf8");
    const l1 = make();
    await l1.init();
    const a = (await l1.launch(alphaId(), { continue: false })) as { launch_id: string };
    l1.shimRegister(a.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    l1.dispose();
    // Orphan too (state file doesn't know it).
    await tmux.spawn({
      name: "mr-aaaaaaaaaaaa",
      cwd: proj,
      env: { MCP_REMOTE_SESSION_ID: "mr-aaaaaaaaaaaa", MCP_REMOTE_LAUNCH_TOKEN: "t1", MCP_REMOTE_PROJECT_ID: alphaId() },
      argv: ["claude", "x"],
    });
    for (const s of tmux.sessions.values()) s.screen = dialog;
    const capt: string[] = [];
    const orig = tmux.capture.bind(tmux);
    tmux.capture = async (n: string, h?: number) => {
      capt.push(n);
      return orig(n, h);
    };
    const l2 = make();
    await l2.init();
    await sleep(200);
    expect(tmux.keys).toEqual([]);
    expect(capt).toEqual([]);
    expect(l2.records().map((r) => r.state)).toEqual(["starting", "starting"]);
  });

  it("stops looking for dialogs once the spawn's shim linked", async () => {
    const dialog = readFileSync(join(__dirname, "fixtures", "dev-channels-raw.txt"), "utf8");
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    l.shimRegister(a.launch_id, tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN);
    l.shimDown(a.launch_id); // e.g. shim crashed; Claude Code keeps running
    tmux.sessions.get(a.launch_id)!.screen = dialog;
    await sleep(150);
    expect(tmux.keys).toEqual([]);
  });

  it("keeps a pending auto-restart across a daemon restart", async () => {
    const l1 = make({ restartBaseMs: 300 });
    await l1.init();
    const a = (await l1.launch(alphaId(), { continue: false, auto_restart: true })) as { launch_id: string };
    tmux.die(a.launch_id, 3, "boom");
    await waitFor(() => rec(l1, a.launch_id).detail?.includes("restarting in"), "pending");
    l1.dispose();
    expect(JSON.parse(readFileSync(l1.statePath, "utf8")).launches[0].restart_at).toBeGreaterThan(Date.now() - 1000);
    const l2 = make({ restartBaseMs: 300 });
    await l2.init();
    await waitFor(() => tmux.spawns.length === 2, "re-armed restart", 3000);
    expect(rec(l2, a.launch_id).state).toBe("starting");
  });

  it("auto-restart re-checks the allowlist", async () => {
    const l = make({ restartBaseMs: 100 });
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false, auto_restart: true })) as { launch_id: string };
    cfg = LaunchConfig.parse({ ...cfg, roots: [] }); // project removed while it runs
    tmux.die(a.launch_id, 3, "boom");
    await waitFor(() => rec(l, a.launch_id).state === "failed", "failed", 3000);
    expect(rec(l, a.launch_id).detail).toMatch(/no longer in the computer's allowlist/);
    expect(tmux.spawns).toHaveLength(1);
  });

  it("reads the exit status from tmux's dead-pane line when list-panes has none yet", () => {
    expect(deadStatus("x\nPane is dead (status 7, Sun Oct 25 21:57:43 2026)\n")).toBe(7);
    expect(deadStatus("Pane is dead (signal 9, Sun Oct 25 21:57:43 2026)")).toBeNull();
    expect(deadStatus("")).toBeNull();
  });

  it("tells the session's own shim from a nested one by the pane pid (round-2 finding)", async () => {
    const l = make();
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    const pane = tmux.sessions.get(a.launch_id)!.pid;
    expect(l.isOwnShim(a.launch_id, [5000, pane, 1])).toBe(true); // shim -> claude -> wrapper(pane)
    expect(l.isOwnShim(a.launch_id, [pane])).toBe(true); // no wrapper: shim -> claude(pane)
    expect(l.isOwnShim(a.launch_id, [6000, 6001, 5000, pane])).toBe(false); // nested claude via a shell
    expect(l.isOwnShim(a.launch_id, [6000, 5000, pane])).toBe(false); // nested claude exec'd directly
    expect(l.isOwnShim(a.launch_id, undefined)).toBeNull();
    expect(l.isOwnShim("mr-ffffffffffff", [1])).toBeNull();
  });

  it("presses the key again only after the screen changed or the retry delay passed (round-2 finding)", async () => {
    const dialog = readFileSync(join(__dirname, "fixtures", "dev-channels-raw.txt"), "utf8");
    const l = make({ keyRetryMs: 400 });
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    tmux.sessions.get(a.launch_id)!.screen = dialog;
    await waitFor(() => tmux.keys.length === 1, "first key");
    await sleep(250); // many ticks (10ms) on the same screen: no second key yet
    expect(tmux.keys).toHaveLength(1);
    await waitFor(() => tmux.keys.length === 2, "retry after the delay", 2000);
  });

  it("a stop arriving while the launch is still spawning stops what it started (round-2 finding)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const origSpawn = tmux.spawn.bind(tmux);
    tmux.spawn = async (spec) => {
      await gate;
      return origSpawn(spec);
    };
    const l = make();
    await l.init();
    const launching = l.launch(alphaId(), { continue: false });
    await sleep(20);
    const id = l.records()[0]!.launch_id;
    expect(l.records()[0]!.state).toBe("starting");
    const stopping = l.stop(id);
    const restarting = l.restart(id, false);
    await sleep(50);
    release();
    expect((await launching).ok).toBe(true);
    expect((await stopping).ok).toBe(true);
    expect((await restarting).ok).toBe(true);
    // Stopped first, then restarted: one tmux session, a new spawn, nothing marked failed.
    expect(tmux.spawns).toHaveLength(2);
    expect(rec(l, id).state).toBe("starting");
  });

  it("removes the run-claude status file of stopped and dismissed launches", async () => {
    const runDir = join(dir, "run");
    const l = make({ wrapper: ["/n", "/cli.js"], runDir });
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    expect(tmux.spawns[0]!.argv.slice(0, 6)).toEqual(["/n", "/cli.js", "run-claude", "--status-file", join(runDir, `${a.launch_id}.exit`), "--"]);
    const f = join(runDir, `${a.launch_id}.exit`);
    writeFileSync(f, JSON.stringify({ token: "old", code: 1, signal: null }));
    await l.stop(a.launch_id);
    expect(existsSync(f)).toBe(false);
    writeFileSync(f, "{}");
    await l.dismiss(a.launch_id);
    expect(existsSync(f)).toBe(false);
  });

  it("prefers the run-claude status file (token-checked) over tmux's status", async () => {
    const runDir = join(dir, "run");
    const l = make({ wrapper: ["/n", "/cli.js"], runDir });
    await l.init();
    const a = (await l.launch(alphaId(), { continue: false })) as { launch_id: string };
    const token = tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN;
    writeFileSync(join(runDir, `${a.launch_id}.exit`), JSON.stringify({ token, code: null, signal: "SIGKILL" }));
    tmux.die(a.launch_id, null, "Killed");
    await waitFor(() => rec(l, a.launch_id).state === "exited", "exited", 6000);
    expect(rec(l, a.launch_id).exit_code).toBe(137);
  });
});
