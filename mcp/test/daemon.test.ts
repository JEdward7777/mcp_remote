// Daemon routing against a fake Hub (ws server) and raw IPC shim clients.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { DaemonToShim } from "@mcp-remote/shared";
import { mkdirSync, realpathSync } from "node:fs";
import { Daemon } from "../src/daemon";
import { LineConn } from "../src/ipc";
import { LaunchConfig, projectIdFor } from "../src/launch-config";
import { FakeTmux } from "./fake-tmux";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeout = 4000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

let dir: string;
let wss: WebSocketServer;
let hubSockets: WsSocket[];
let hubFrames: any[];
let authHeaders: string[];
let daemon: Daemon | null;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpr-d-"));
  process.env.MCP_REMOTE_CONFIG_DIR = dir;
  hubSockets = [];
  hubFrames = [];
  authHeaders = [];
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  port = (wss.address() as { port: number }).port;
  wss.on("connection", (ws, req) => {
    authHeaders.push(String(req.headers.authorization));
    hubSockets.push(ws);
    ws.send(JSON.stringify({ t: "welcome", machine_id: "m1", name: "box" }));
    ws.on("message", (d) => {
      const s = d.toString();
      if (s === "ping") return ws.send("pong");
      const f = JSON.parse(s);
      hubFrames.push(f);
      if (f.t === "send") ws.send(JSON.stringify({ t: "sent", req_id: f.req_id, message_id: 42 }));
    });
  });
  daemon = null;
});

afterEach(async () => {
  daemon?.stop();
  for (const s of hubSockets) s.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function startDaemon(onFatal?: (code: number) => void): Daemon {
  daemon = new Daemon({
    config: { url: `http://127.0.0.1:${port}`, token: "mrm1.test.token.value.sig", machine_id: "m1" },
    socket: join(dir, "d.sock"),
    launcher: false,
    ...(onFatal ? { onFatal } : {}),
  });
  return daemon;
}

interface FakeShim {
  conn: LineConn<DaemonToShim>;
  frames: any[];
  closed: boolean;
}

async function shim(sessionId: string, project = "p"): Promise<FakeShim> {
  const sock = createConnection(join(dir, "d.sock"));
  await new Promise<void>((r, j) => {
    sock.once("connect", () => r());
    sock.once("error", j);
  });
  const s: FakeShim = { conn: null as never, frames: [], closed: false };
  s.conn = new LineConn(sock, DaemonToShim, (f) => s.frames.push(f), () => {});
  sock.on("close", () => (s.closed = true));
  s.conn.send({ t: "register", v: 1, session: { session_id: sessionId, project } });
  await waitFor(() => s.frames.find((f) => f.t === "registered" || f.t === "error" || f.t === "register_refused"), "register reply");
  return s;
}

describe("daemon", () => {
  it("authenticates to the hub, announces shims and routes by session id", async () => {
    await startDaemon().start();
    expect(statSync(join(dir, "d.sock")).mode & 0o777).toBe(0o600);
    await waitFor(() => hubFrames.find((f) => f.t === "hello"), "hello");
    expect(authHeaders[0]).toBe("Bearer mrm1.test.token.value.sig");

    const a = await shim("sa", "alpha");
    const b = await shim("sb", "beta");
    expect(a.frames[0]).toEqual({ t: "registered", hub_connected: true });
    await waitFor(() => hubFrames.filter((f) => f.t === "session_up").length === 2, "session_up x2");

    const msg = { id: 7, session_id: "sb", direction: "in", text: "hi b", urgency: null, created_at: 1, delivered: false };
    hubSockets[0]!.send(JSON.stringify({ t: "deliver", session_id: "sb", messages: [msg] }));
    await waitFor(() => b.frames.find((f) => f.t === "deliver"), "deliver at b");
    await sleep(50);
    expect(a.frames.find((f) => f.t === "deliver")).toBeUndefined();

    b.conn.send({ t: "ack", ids: [7] });
    await waitFor(() => hubFrames.find((f) => f.t === "ack"), "ack");
    expect(hubFrames.find((f) => f.t === "ack")).toEqual({ t: "ack", session_id: "sb", ids: [7] });

    a.conn.send({ t: "send", req_id: "x1", text: "done", urgency: "urgent" });
    const sent = await waitFor(() => a.frames.find((f) => f.t === "sent"), "sent");
    expect(sent).toEqual({ t: "sent", req_id: "x1", message_id: 42 });
    const up = hubFrames.find((f) => f.t === "send");
    expect(up).toMatchObject({ session_id: "sa", text: "done", urgency: "urgent" });
    expect(up.req_id).not.toBe("x1"); // daemon uses its own request ids

    a.conn.close();
    await waitFor(() => hubFrames.find((f) => f.t === "session_down"), "session_down");
    expect(hubFrames.find((f) => f.t === "session_down").session_id).toBe("sa");
  });

  it("rejects a duplicate session id", async () => {
    await startDaemon().start();
    await shim("dup");
    const second = await shim("dup");
    expect(second.frames[0]).toMatchObject({ t: "register_refused" });
    expect(second.frames[0].error).toMatch(/already uses session id "dup"/);
    await waitFor(() => second.closed, "closed");
  });

  it("caps registrations at MAX_SESSIONS_PER_MACHINE", async () => {
    await startDaemon().start();
    await waitFor(() => hubSockets.length === 1, "connect");
    for (let i = 0; i < 64; i++) await shim(`c${i}`);
    const extra = await shim("c64");
    expect(extra.frames[0]).toMatchObject({ t: "register_refused" });
    expect(extra.frames[0].error).toMatch(/too many live sessions/);
    // Reconnect hello stays within the protocol's max(64).
    hubSockets[0]!.close(1012, "restart");
    await waitFor(() => hubFrames.filter((f) => f.t === "hello").length === 2, "second hello", 8000);
    expect(hubFrames.filter((f) => f.t === "hello")[1].sessions.length).toBe(64);
  });

  it("re-announces live sessions in hello after reconnecting", async () => {
    await startDaemon().start();
    await waitFor(() => hubSockets.length === 1, "connect");
    const a = await shim("keep");
    hubSockets[0]!.close(1012, "restart");
    await waitFor(() => a.frames.find((f) => f.t === "hub_status" && !f.connected), "hub down status");
    a.conn.send({ t: "send", req_id: "y", text: "while down", urgency: "normal" });
    const err = await waitFor(() => a.frames.find((f) => f.t === "send_error"), "send_error");
    expect(err.error).toMatch(/not connected/);
    await waitFor(() => hubSockets.length === 2, "reconnect", 8000);
    const hellos = await waitFor(() => (hubFrames.filter((f) => f.t === "hello").length === 2 ? hubFrames.filter((f) => f.t === "hello") : null), "second hello");
    expect(hellos[1].sessions).toEqual([{ session_id: "keep", project: "p" }]);
  });

  it("stops on revocation (close 4001)", async () => {
    let exitCode = 0;
    await startDaemon((c) => (exitCode = c)).start();
    await waitFor(() => hubSockets.length === 1, "connect");
    hubSockets[0]!.close(4001, "machine revoked");
    await waitFor(() => exitCode === 3, "fatal 3");
  });

  it("gives up (exit 4) when another daemon with the same token keeps replacing it", async () => {
    let exitCode = 0;
    daemon = new Daemon({
      config: { url: `http://127.0.0.1:${port}`, token: "mrm1.test.token.value.sig", machine_id: "m1" },
      socket: join(dir, "d.sock"),
    launcher: false,
      onFatal: (c) => (exitCode = c),
      replacedDelayMs: 10,
    });
    wss.on("connection", (ws) => setTimeout(() => ws.close(4002, "replaced by a newer connection"), 20));
    await daemon.start();
    await waitFor(() => exitCode === 4, "fatal 4", 10_000);
    expect(hubSockets.length).toBe(3);
  });

  it("resets the replaced streak after a long stable connection", { timeout: 15_000 }, async () => {
    let exitCode = 0;
    daemon = new Daemon({
      config: { url: `http://127.0.0.1:${port}`, token: "mrm1.test.token.value.sig", machine_id: "m1" },
      socket: join(dir, "d.sock"),
    launcher: false,
      onFatal: (c) => (exitCode = c),
      replacedDelayMs: 10,
      stableAfterMs: 100,
    });
    // Every connection is replaced, but only after living longer than stableAfterMs.
    wss.on("connection", (ws) => setTimeout(() => ws.close(4002, "replaced"), 150));
    await daemon.start();
    await waitFor(() => hubSockets.length >= 5, "5 connections", 8_000);
    expect(exitCode).toBe(0);
  });

  it("remembers a refused session, fails its sends clearly, and retries on resync", async () => {
    await startDaemon().start();
    await waitFor(() => hubSockets.length === 1, "connect");
    const a = await shim("taken");
    await waitFor(() => hubFrames.find((f) => f.t === "session_up"), "session_up");
    hubSockets[0]!.send(JSON.stringify({ t: "error", error: "already used by another computer", session_id: "taken" }));
    await waitFor(() => a.frames.find((f) => f.t === "error"), "error at shim");
    a.conn.send({ t: "send", req_id: "q1", text: "hi", urgency: "normal" });
    const se = await waitFor(() => a.frames.find((f) => f.t === "send_error"), "send_error");
    expect(se.error).toMatch(/refused this session: already used by another computer/);
    expect(hubFrames.find((f) => f.t === "send")).toBeUndefined();
    hubSockets[0]!.send(JSON.stringify({ t: "resync" }));
    await waitFor(() => hubFrames.filter((f) => f.t === "hello").length === 2, "hello after resync");
    expect(hubFrames.filter((f) => f.t === "hello")[1].sessions[0].session_id).toBe("taken");
    a.conn.send({ t: "send", req_id: "q2", text: "hi again", urgency: "normal" });
    await waitFor(() => a.frames.find((f) => f.t === "sent" && f.req_id === "q2"), "sent after resync");
  });

  it("forwards a per-session server error to that shim", async () => {
    await startDaemon().start();
    await waitFor(() => hubSockets.length === 1, "connect");
    const a = await shim("sx");
    hubSockets[0]!.send(JSON.stringify({ t: "error", error: "session id is in use", session_id: "sx" }));
    const e = await waitFor(() => a.frames.find((f) => f.t === "error"), "error at shim");
    expect(e.error).toMatch(/server refused this session: session id is in use/);
  });

  it("refuses to start twice on the same socket", async () => {
    await startDaemon().start();
    const second = new Daemon({
      config: { url: `http://127.0.0.1:${port}`, token: "t".repeat(20), machine_id: "m1" },
      socket: join(dir, "d.sock"),
    launcher: false,
    });
    await expect(second.start()).rejects.toThrow(/already listening/);
  });
});

describe("daemon remote launch", () => {
  async function setup() {
    const code = join(realpathSync(dir), "code");
    mkdirSync(join(code, "alpha"), { recursive: true });
    const cfg = LaunchConfig.parse({ roots: [code], claude_path: "/opt/fake/claude", max_sessions: 1 });
    const tmux = new FakeTmux();
    daemon = new Daemon({
      config: { url: `http://127.0.0.1:${port}`, token: "mrm1.test.token.value.sig", machine_id: "m1" },
      socket: join(dir, "d.sock"),
      launcher: { loadConfig: () => cfg, tmux, tickMs: 10, livenessMs: 20, stopWaitMs: 200 },
    });
    await daemon.start();
    await waitFor(() => hubSockets.length === 1, "connect");
    return { tmux, alpha: projectIdFor(join(code, "alpha")) };
  }
  const hub = (f: unknown) => hubSockets[0]!.send(JSON.stringify(f));
  const lastLaunches = () => [...hubFrames].reverse().find((f) => f.t === "launches")?.launches ?? [];

  it("advertises projects after hello and launches only allowlisted ids from the Hub", async () => {
    const { tmux, alpha } = await setup();
    const proj = await waitFor(() => hubFrames.find((f) => f.t === "projects"), "projects frame");
    expect(proj).toMatchObject({ available: true, max_sessions: 1, projects: [{ id: alpha, name: "alpha" }] });
    expect(hubFrames.findIndex((f) => f.t === "hello")).toBeLessThan(hubFrames.findIndex((f) => f.t === "projects"));
    expect(JSON.stringify(proj)).not.toContain(dir);

    hub({ t: "launch", req_id: "c1", project_id: "pdeadbeefdeadbee", continue: false });
    const bad = await waitFor(() => hubFrames.find((f) => f.t === "launch_result" && f.req_id === "c1"), "refusal");
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/allowlist/) });
    expect(tmux.spawns).toHaveLength(0);

    hub({ t: "launch", req_id: "c2", project_id: alpha, continue: false });
    await waitFor(() => hubFrames.find((f) => f.t === "launch_result" && f.req_id === "c2" && f.ok), "launch ok");
    const id = tmux.spawns[0]!.name;
    expect(lastLaunches()[0]).toMatchObject({ launch_id: id, session_id: id, state: "starting" });

    // A shim without the launch token cannot take the launch's session id.
    const impostor = await shim(id, "alpha");
    expect(impostor.frames[0]).toMatchObject({ t: "register_refused", error: expect.stringMatching(/phone-launched/) });

    // The real shim (token from the tmux env) links the launch and comes up as a session.
    const sock = createConnection(join(dir, "d.sock"));
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const frames: any[] = [];
    const conn = new LineConn(sock, DaemonToShim, (f) => frames.push(f), () => {});
    conn.send({ t: "register", v: 1, session: { session_id: id, project: "alpha" }, launch_token: tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN });
    await waitFor(() => frames.find((f) => f.t === "registered"), "registered");
    await waitFor(() => lastLaunches()[0]?.state === "running", "running");
    expect(hubFrames.find((f) => f.t === "session_up" && f.session.session_id === id)).toBeTruthy();

    // Cap of 1 concurrent launch.
    hub({ t: "launch", req_id: "c3", project_id: alpha, continue: false });
    await waitFor(() => hubFrames.find((f) => f.t === "launch_result" && f.req_id === "c3"), "cap");
    expect(hubFrames.find((f) => f.t === "launch_result" && f.req_id === "c3")).toMatchObject({ ok: false, error: expect.stringMatching(/max 1/) });

    // Claude Code exits: shim goes away, the pane is dead -> exited with the code.
    tmux.die(id, 9, "segfault");
    conn.close();
    await waitFor(() => lastLaunches()[0]?.state === "exited", "exited");
    expect(lastLaunches()[0]).toMatchObject({ exit_code: 9, detail: "segfault" });

    hub({ t: "launch_dismiss", req_id: "c4", launch_id: id });
    await waitFor(() => hubFrames.find((f) => f.t === "launch_result" && f.req_id === "c4" && f.ok), "dismissed");
    expect(lastLaunches()).toEqual([]);
  });

  it("re-reads launch.json on a local reload request", async () => {
    await setup();
    await waitFor(() => hubFrames.find((f) => f.t === "projects"), "projects frame");
    const sock = createConnection(join(dir, "d.sock"));
    await new Promise<void>((r) => sock.once("connect", () => r()));
    const frames: any[] = [];
    const conn = new LineConn(sock, DaemonToShim, (f) => frames.push(f), () => {});
    conn.send({ t: "reload" });
    await waitFor(() => frames.find((f) => f.t === "reloaded"), "reloaded");
    expect(frames[0]).toEqual({ t: "reloaded", ok: true });
    await waitFor(() => hubFrames.filter((f) => f.t === "projects").length === 2, "re-advertised");
  });

  it("refuses a nested process that inherited the launch's id and token; the real shim keeps the session (round-1 finding)", async () => {
    const { tmux, alpha } = await setup();
    hub({ t: "launch", req_id: "n1", project_id: alpha, continue: false });
    await waitFor(() => hubFrames.find((f) => f.t === "launch_result" && f.req_id === "n1" && f.ok), "launch ok");
    const id = tmux.spawns[0]!.name;
    const token = tmux.spawns[0]!.env.MCP_REMOTE_LAUNCH_TOKEN;
    const connect = async () => {
      const sock = createConnection(join(dir, "d.sock"));
      await new Promise<void>((r) => sock.once("connect", () => r()));
      const c = { frames: [] as any[], closed: false, conn: null as unknown as LineConn<DaemonToShim> };
      c.conn = new LineConn(sock, DaemonToShim, (f) => c.frames.push(f), () => {});
      sock.on("close", () => (c.closed = true));
      c.conn.send({ t: "register", v: 1, session: { session_id: id, project: "alpha" }, launch_token: token });
      await waitFor(() => c.frames.find((f) => f.t === "registered" || f.t === "register_refused"), "reply");
      return c;
    };
    const real = await connect();
    expect(real.frames[0]).toMatchObject({ t: "registered" });
    await waitFor(() => lastLaunches()[0]?.state === "running", "running");
    const nested = await connect();
    expect(nested.frames[0]).toMatchObject({ t: "register_refused", error: expect.stringMatching(/already connected/) });
    await waitFor(() => nested.closed, "nested closed");
    await sleep(50);
    expect(real.closed).toBe(false);
    const msg = { id: 5, session_id: id, direction: "in", text: "for the real one", urgency: null, created_at: 1, delivered: false };
    hub({ t: "deliver", session_id: id, messages: [msg] });
    await waitFor(() => real.frames.find((f) => f.t === "deliver"), "deliver to real shim");
    expect(nested.frames.find((f) => f.t === "deliver")).toBeUndefined();
    expect(hubFrames.filter((f) => f.t === "session_down" && f.session_id === id)).toEqual([]);
    expect(lastLaunches()[0].state).toBe("running");
  });
});
