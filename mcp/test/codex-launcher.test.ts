// Codex launches (Phase 5) against a fake tmux: turns, queueing, acks, failures, stop, re-adoption.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRecord, MessageRecord, Urgency } from "@mcp-remote/shared";
import { type CodexExitRecord, newSummary } from "../src/codex";
import { LaunchConfig, projectIdFor } from "../src/launch-config";
import { Launcher } from "../src/launcher";
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
let runDir: string;
let tmux: FakeTmux;
let cfg: LaunchConfig;
let acks: { sid: string; ids: number[] }[];
let notes: { sid: string; text: string; urgency: Urgency }[];
let launchers: Launcher[];
let loginProblem: string | null;
let changes: number;
let connected: boolean;
let sentItems: { sid: string; id: string }[];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcpr-cx-")));
  process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
  proj = join(dir, "code", "alpha");
  mkdirSync(proj, { recursive: true });
  runDir = join(dir, "run");
  tmux = new FakeTmux();
  acks = [];
  notes = [];
  launchers = [];
  loginProblem = null;
  changes = 0;
  connected = true;
  sentItems = [];
  cfg = LaunchConfig.parse({
    roots: [join(dir, "code")],
    claude_path: "/opt/fake/claude",
    codex_path: "/opt/fake/codex",
    agents: ["claude", "codex"],
    codex_mode: "workspace-write",
    max_sessions: 3,
  });
});
afterEach(() => {
  for (const l of launchers) l.dispose();
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function make(): Launcher {
  const l = new Launcher({
    loadConfig: () => cfg,
    onChange: () => changes++,
    tmux,
    tickMs: 10,
    livenessMs: 20,
    stopWaitMs: 100,
    wrapper: ["/usr/bin/node", "/opt/mcp/cli.js"],
    runDir,
    statePath: join(dir, "launches.json"),
    extraEnv: { MCP_REMOTE_SOCKET: "/tmp/d.sock" },
    onAck: (sid, ids) => acks.push({ sid, ids }),
    onNotify: (sid, item) => {
      if (!connected) return false;
      notes.push({ sid, text: item.text, urgency: item.urgency });
      sentItems.push({ sid, id: item.id });
      return true;
    },
    codexLoginCheck: async () => loginProblem,
  });
  launchers.push(l);
  return l;
}
const alpha = () => projectIdFor(proj);
const rec = (l: Launcher, id: string): LaunchRecord => l.records().find((r) => r.launch_id === id)!;
let seq = 0;
const msg = (sid: string, text: string, id = ++seq): MessageRecord => ({
  id,
  session_id: sid,
  direction: "in",
  text,
  urgency: null,
  created_at: Date.now(),
  delivered: false,
});

/** Finish the running turn the way run-codex does: status file (token of the spawn), then the pane dies. */
function endTurn(name: string, o: Partial<CodexExitRecord["codex"]> & { code?: number | null; signal?: string | null } = {}): void {
  const spawn = tmux.sessions.get(name)!.spec;
  const { code = 0, signal = null, ...codex } = o;
  const r: CodexExitRecord = {
    token: spawn.env.MCP_REMOTE_LAUNCH_TOKEN!,
    code,
    signal,
    codex: { ...newSummary(), started: true, completed: code === 0, stderr_tail: "", ...codex },
  };
  writeFileSync(join(runDir, `${name}.exit`), JSON.stringify(r));
  tmux.die(name, code);
}

async function startCodex(l: Launcher, opts: { continue?: boolean } = {}): Promise<string> {
  const r = await l.launch(alpha(), { continue: opts.continue ?? false, agent: "codex" });
  expect(r).toMatchObject({ ok: true });
  return (r as { launch_id: string }).launch_id;
}

describe("codex launches", () => {
  it("advertises agents and the project's agent; refuses Codex when it is not enabled", async () => {
    const l = make();
    await l.init();
    expect(l.info().agents).toEqual(["claude", "codex"]);
    expect(l.info().projects[0]).toMatchObject({ name: "alpha", agent: "claude" });
    cfg = LaunchConfig.parse({ ...cfg, agents: ["claude"] });
    const r = await l.launch(alpha(), { continue: false, agent: "codex" });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/setup-codex/) });
    cfg = LaunchConfig.parse({ ...cfg, agents: ["claude", "codex"], projects: [{ path: proj, agent: "codex" }], roots: [] });
    const d = await l.launch(alpha(), { continue: false });
    expect(d.ok && rec(l, d.launch_id!).agent).toBe("codex");
  });

  it("a session with no process: running, announced by the daemon, no tmux until a message arrives", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    expect(rec(l, id)).toMatchObject({ state: "running", agent: "codex", auto_restart: false });
    expect(tmux.spawns).toHaveLength(0);
    expect(l.agentSessions()).toEqual([{ session_id: id, project: "alpha", cwd: proj }]);
    expect(l.isAgentSession(id)).toBe(true);
  });

  it("a phone message becomes one turn: argv without the text, prompt in a 0600 file, acked once started", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    const hostile = "--dangerously-bypass-approvals-and-sandbox\n$(id) `id` #(touch /tmp/x) it's;";
    const m = msg(id, hostile);
    l.deliver(id, [m]);
    const spawn = await waitFor(() => tmux.spawns[0], "turn spawned");
    expect(spawn.name).toBe(id);
    expect(spawn.cwd).toBe(proj);
    expect(spawn.argv.join("\0")).not.toContain("$(id)");
    expect(spawn.argv.slice(0, 3)).toEqual(["/usr/bin/node", "/opt/mcp/cli.js", "run-codex"]);
    const dd = spawn.argv.indexOf("--");
    expect(spawn.argv.slice(dd + 1, dd + 4)).toEqual(["/opt/fake/codex", "exec", "--json"]);
    expect(spawn.argv.slice(-2)).toEqual(["--", "-"]);
    expect(spawn.env).toMatchObject({ MCP_REMOTE_SESSION_ID: id, MCP_REMOTE_AGENT: "codex", MCP_REMOTE_SOCKET: "/tmp/d.sock" });
    const pf = spawn.argv[spawn.argv.indexOf("--prompt-file") + 1]!;
    expect(statSync(pf).mode & 0o777).toBe(0o600);
    expect(readFileSync(pf, "utf8")).toContain(hostile);
    expect(acks).toEqual([{ sid: id, ids: [m.id] }]);
    // A redelivery of the same message (lost ack) is acknowledged again, not run twice.
    l.deliver(id, [m]);
    expect(acks).toHaveLength(2);
    await sleep(30);
    expect(tmux.spawns).toHaveLength(1);
  });

  it("queues messages during a turn and runs them as the next turn, resuming the thread", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "msg-one")]);
    await waitFor(() => tmux.spawns.length === 1, "turn 1");
    l.deliver(id, [msg(id, "two"), msg(id, "three")]);
    await sleep(40);
    expect(tmux.spawns).toHaveLength(1); // one turn at a time
    const thread = "01a17b47-7383-7830-b9f5-1582b9c56491";
    endTurn(id, { thread_id: thread, sends: 1, final: "done" });
    l.noteSend(id); // the shim's send_message, counted by the daemon
    const s2 = await waitFor(() => tmux.spawns[1], "turn 2");
    expect(s2.argv).toContain("resume");
    expect(s2.argv.slice(-3)).toEqual(["--", thread, "-"]);
    const prompt = readFileSync(s2.argv[s2.argv.indexOf("--prompt-file") + 1]!, "utf8");
    expect(prompt.indexOf("two")).toBeLessThan(prompt.indexOf("three"));
    expect(prompt).not.toContain("msg-one");
    expect(notes).toEqual([]); // Codex messaged the phone itself: nothing extra
    expect(rec(l, id).state).toBe("running");
  });

  it("a normal turn costs no launches report (the Hub is not told about turn start/end)", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    const before = changes;
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { final: "x", sends: 1 });
    await waitFor(() => !tmux.sessions.has(id), "turn processed");
    await sleep(30);
    expect(changes).toBe(before);
    // ...but it is persisted locally (a restarted daemon must know a turn is running).
    l.deliver(id, [msg(id, "q2")]);
    await waitFor(() => tmux.spawns.length === 2, "turn 2");
    expect(JSON.parse(readFileSync(join(dir, "launches.json"), "utf8")).launches[0].turn_at).toBeTypeOf("number");
  });

  it("forwards the final answer only when Codex never used send_message (fallback)", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { thread_id: "01a17b47-7383-7830-b9f5-1582b9c56491", final: "42" });
    await waitFor(() => notes.length === 1, "fallback");
    expect(notes[0]).toEqual({ sid: id, text: "42", urgency: "normal" });
    cfg = LaunchConfig.parse({ ...cfg, codex_final_message: "never" });
    await l.reload();
    l.deliver(id, [msg(id, "q2")]);
    await waitFor(() => tmux.spawns.length === 2, "turn 2");
    endTurn(id, { final: "43" });
    await waitFor(() => !l.records()[0]!.detail && !tmux.sessions.has(id), "turn 2 processed");
    expect(notes).toHaveLength(1);
  });

  it("a failed turn is reported to the phone; the session stays (a turn failing is not the session ending)", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { code: 1, error: "model overloaded" });
    await waitFor(() => notes.length === 1, "failure note");
    expect(notes[0]!.text).toMatch(/^\[mcp-remote\] the Codex turn failed \(exit 1\): model overloaded/);
    expect(rec(l, id)).toMatchObject({ state: "running", exit_code: 1 });
    expect(l.agentSessions()).toHaveLength(1);
  });

  it("authentication failures -> needs_attention with the fix; a later good turn clears it", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { code: 1, auth: true, error: "unexpected status 401 Unauthorized" });
    await waitFor(() => rec(l, id).state === "needs_attention", "attention");
    expect(rec(l, id).detail).toMatch(/codex login/);
    expect(notes[0]!.text).toMatch(/codex login/);
    l.deliver(id, [msg(id, "again")]); // still accepts messages (the user may have logged in meanwhile)
    await waitFor(() => tmux.spawns.length === 2, "turn 2");
    endTurn(id, { final: "ok", sends: 1 });
    await waitFor(() => rec(l, id).state === "running", "running again");
  });

  it("not logged in at start -> needs_attention right away", async () => {
    loginProblem = "Codex is not logged in on this computer: run `codex login` at the desk";
    const l = make();
    await l.init();
    const id = await startCodex(l);
    expect(rec(l, id)).toMatchObject({ state: "needs_attention", detail: expect.stringMatching(/codex login/) });
    expect(l.agentSessions()).toHaveLength(1);
  });

  it("an unknown thread resets the conversation; a non-git folder explains the fix", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { thread_id: "01a17b47-7383-7830-b9f5-1582b9c56491", final: "x", sends: 1 });
    l.deliver(id, [msg(id, "q2")]);
    await waitFor(() => tmux.spawns.length === 2, "turn 2");
    endTurn(id, { code: 1, completed: false, started: false, stderr_tail: "Error: thread/resume: thread/resume failed: no rollout found for thread id 01a17b47-7383-7830-b9f5-1582b9c56491 (code -32600)" });
    await waitFor(() => notes.length === 1, "note");
    expect(notes[0]!.text).toMatch(/earlier conversation/);
    l.deliver(id, [msg(id, "q3")]);
    const s3 = await waitFor(() => tmux.spawns[2], "turn 3");
    expect(s3.argv).not.toContain("resume");
    endTurn(id, { code: 1, completed: false, started: false, stderr_tail: "Not inside a trusted directory and --skip-git-repo-check was not specified." });
    await waitFor(() => notes.length === 2, "git note");
    expect(notes[1]!.text).toMatch(/git repository/);
    expect(rec(l, id).state).toBe("needs_attention");
  });

  it("stop kills the running turn (tmux session) and ends the session; restart picks the conversation up", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { thread_id: "01a17b47-7383-7830-b9f5-1582b9c56491", final: "x", sends: 1 });
    l.deliver(id, [msg(id, "long job")]);
    await waitFor(() => tmux.spawns.length === 2 && tmux.sessions.has(id), "turn 2");
    l.deliver(id, [msg(id, "queued")]);
    expect(await l.stop(id)).toEqual({ ok: true });
    expect(tmux.sessions.has(id)).toBe(false);
    expect(rec(l, id)).toMatchObject({ state: "exited", detail: "stopped from the phone" });
    expect(l.agentSessions()).toEqual([]);
    expect(l.isAgentSession(id)).toBe(false);
    expect(existsSync(join(runDir, `${id}.prompt`))).toBe(false);
    // Restart + resume keeps the thread; the queued message (never acked) comes back from the Hub later.
    expect(await l.restart(id, true)).toMatchObject({ ok: true });
    expect(rec(l, id).state).toBe("running");
    l.deliver(id, [msg(id, "after restart")]);
    const s = await waitFor(() => tmux.spawns[2], "turn 3");
    expect(s.argv.slice(-3)).toEqual(["--", "01a17b47-7383-7830-b9f5-1582b9c56491", "-"]);
    // Fresh restart: new conversation.
    endTurn(id, { final: "x", sends: 1 });
    await waitFor(() => !tmux.sessions.has(id), "turn 3 done");
    await l.restart(id, false);
    l.deliver(id, [msg(id, "fresh")]);
    const f = await waitFor(() => tmux.spawns[3], "turn 4");
    expect(f.argv).not.toContain("resume");
  });

  it("resume on a new launch uses the folder's last conversation; refused while another Codex session runs there", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l, { continue: true });
    l.deliver(id, [msg(id, "q")]);
    const s = await waitFor(() => tmux.spawns[0], "turn");
    expect(s.argv).toContain("--last");
    const again = await l.launch(alpha(), { continue: true, agent: "codex" });
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/could pick its conversation/) });
  });

  it("a turn over the time limit is stopped and reported", async () => {
    cfg = LaunchConfig.parse({ ...cfg, codex_turn_timeout_s: 60 });
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    // Pretend it started over a minute ago.
    const st = JSON.parse(readFileSync(join(dir, "launches.json"), "utf8"));
    expect(st.launches[0].turn_at).toBeTypeOf("number");
    (l as unknown as { entries: { turn_at: number }[] }).entries[0]!.turn_at = Date.now() - 61_000;
    await waitFor(() => !tmux.sessions.has(id), "killed");
    await waitFor(() => notes.length === 1, "note");
    expect(notes[0]!.text).toMatch(/longer than 1 min/);
  });

  it("re-adopts a running turn after a daemon restart and processes its result", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    l.dispose();
    const l2 = make();
    await l2.init();
    expect(rec(l2, id)).toMatchObject({ state: "running", agent: "codex" });
    expect(l2.agentSessions()).toHaveLength(1);
    // The turn shim of the re-adopted turn can still link with its token.
    const tok = tmux.sessions.get(id)!.spec.env.MCP_REMOTE_LAUNCH_TOKEN;
    expect(l2.shimRegister(id, tok, [tmux.sessions.get(id)!.pid])).toBe("turn");
    expect(l2.shimRegister(id, "wrong")).toBe("reject");
    endTurn(id, { thread_id: "01a17b47-7383-7830-b9f5-1582b9c56491", final: "late answer" });
    l2.turnEnded(id, tok!);
    await waitFor(() => notes.length === 1, "result processed");
    expect(notes[0]!.text).toBe("late answer");
    expect(l2.shimRegister(id, tok)).toBe("reject"); // no turn running any more
  });

  it("a stale status file of an earlier turn (other token) is ignored", async () => {
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, `${id}.exit`), JSON.stringify({ token: "old", code: 0, signal: null, codex: { ...newSummary(), completed: true, final: "stale" } }));
    l.turnEnded(id, "old");
    await sleep(80);
    expect(tmux.sessions.has(id)).toBe(true);
    expect(notes).toEqual([]);
  });
});

describe("codex launches: review round 1", () => {
  it("status messages wait in a persisted outbox while the daemon is offline and go out after reconnecting", async () => {
    connected = false;
    const l = make();
    await l.init();
    const id = await startCodex(l);
    l.deliver(id, [msg(id, "q")]);
    await waitFor(() => tmux.spawns.length === 1, "turn");
    endTurn(id, { final: "the answer" });
    await waitFor(() => !tmux.sessions.has(id), "turn processed");
    expect(notes).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "launches.json"), "utf8")).launches[0].outbox).toMatchObject([{ text: "the answer", urgency: "normal" }]);
    // Bounded: only the newest 3 are kept.
    for (const t of ["f1", "f2", "f3"]) {
      l.deliver(id, [msg(id, t)]);
      await waitFor(() => tmux.sessions.has(id), "turn " + t);
      endTurn(id, { code: 1, error: t });
      await waitFor(() => !tmux.sessions.has(id), "done " + t);
    }
    // A daemon restart keeps them; after hello the daemon flushes; the Hub's answer removes each.
    l.dispose();
    const l2 = make();
    await l2.init();
    connected = true;
    expect(l2.outboxSessions()).toEqual([id]);
    l2.flushOutbox(id);
    expect(notes.map((n) => n.text.replace(/^.*: /, ""))).toEqual(["f1. Your message may not have been handled", "f2. Your message may not have been handled", "f3. Your message may not have been handled"]);
    l2.flushOutbox(id); // in flight: not sent twice
    expect(notes).toHaveLength(3);
    l2.outboxRetry(sentItems[0]!.id); // answer lost: resent on the next flush
    l2.flushOutbox(id);
    expect(notes).toHaveLength(4);
    for (const x of sentItems) l2.outboxDone(x.sid, x.id);
    expect(l2.outboxSessions()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "launches.json"), "utf8")).launches[0].outbox).toEqual([]);
  });

  it("a fresh start next to a session waiting to resume the folder's last conversation is refused (bypass A)", async () => {
    const l = make();
    await l.init();
    await startCodex(l, { continue: true });
    const b = await l.launch(alpha(), { continue: false, agent: "codex" });
    expect(b).toMatchObject({ ok: false, error: expect.stringMatching(/waiting to resume/) });
    // Claude Code in the same folder is unaffected.
    expect((await l.launch(alpha(), { continue: false, agent: "claude" })).ok).toBe(true);
  });

  it("Restart + resume of a session that never ran (no thread) is refused next to another active Codex session (bypass B)", async () => {
    const l = make();
    await l.init();
    const a = await startCodex(l);
    const b = await startCodex(l);
    expect(await l.restart(a, true)).toMatchObject({ ok: false, error: expect.stringMatching(/another Codex session is active/) });
    // With its own thread it resumes exactly that one: fine.
    l.deliver(a, [msg(a, "q")]);
    await waitFor(() => tmux.sessions.has(a), "turn");
    endTurn(a, { thread_id: "01a17b47-7383-7830-b9f5-1582b9c56491", final: "x", sends: 1 });
    await waitFor(() => !tmux.sessions.has(a), "turn done");
    expect((await l.restart(a, true)).ok).toBe(true);
    expect((await l.restart(b, false)).ok).toBe(true);
  });

  it("a codex-only computer starts projects without --agent with Codex", async () => {
    cfg = LaunchConfig.parse({ ...cfg, agents: ["codex"] });
    const l = make();
    await l.init();
    expect(l.info().projects[0]!.agent).toBe("codex");
    const r = await l.launch(alpha(), { continue: false });
    expect(r.ok && rec(l, r.launch_id!).agent).toBe("codex");
  });

  it("messages kept after a failed turn start run once the settings are fixed (reload)", async () => {
    cfg = LaunchConfig.parse({ ...cfg, codex_path: join(dir, "missing-codex") });
    const l = make();
    await l.init();
    // codex disappears after the start (start itself checks it)
    cfg = LaunchConfig.parse({ ...cfg, codex_path: "/opt/fake/codex" });
    await l.reload();
    const id = await startCodex(l);
    cfg = LaunchConfig.parse({ ...cfg, codex_path: null });
    const saved = process.env.PATH;
    process.env.PATH = join(dir, "nowhere");
    try {
      await l.reload();
      l.deliver(id, [msg(id, "keep me")]);
      await waitFor(() => notes.length === 1, "problem note");
      expect(notes[0]!.text).toMatch(/not found/);
      expect(tmux.spawns).toHaveLength(0);
    } finally {
      process.env.PATH = saved;
    }
    cfg = LaunchConfig.parse({ ...cfg, codex_path: "/opt/fake/codex" });
    await l.reload();
    l.retryQueued();
    const s = await waitFor(() => tmux.spawns[0], "turn after fix");
    expect(readFileSync(s.argv[s.argv.indexOf("--prompt-file") + 1]!, "utf8")).toContain("keep me");
  });
});
