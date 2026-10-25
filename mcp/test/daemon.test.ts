// Daemon routing against a fake Hub (ws server) and raw IPC shim clients.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { DaemonToShim } from "@mcp-remote/shared";
import { Daemon } from "../src/daemon";
import { LineConn } from "../src/ipc";

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

function startDaemon(onRevoked?: () => void): Daemon {
  daemon = new Daemon({
    config: { url: `http://127.0.0.1:${port}`, token: "mrm1.test.token.value.sig", machine_id: "m1" },
    socket: join(dir, "d.sock"),
    ...(onRevoked ? { onRevoked } : {}),
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
  await waitFor(() => s.frames.find((f) => f.t === "registered" || f.t === "error"), "register reply");
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
    expect(second.frames[0]).toMatchObject({ t: "error", error: "session id already connected" });
    await waitFor(() => second.closed, "closed");
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
    let revoked = false;
    await startDaemon(() => (revoked = true)).start();
    await waitFor(() => hubSockets.length === 1, "connect");
    hubSockets[0]!.close(4001, "machine revoked");
    await waitFor(() => revoked, "onRevoked");
  });

  it("refuses to start twice on the same socket", async () => {
    await startDaemon().start();
    const second = new Daemon({
      config: { url: `http://127.0.0.1:${port}`, token: "t".repeat(20), machine_id: "m1" },
      socket: join(dir, "d.sock"),
    });
    await expect(second.start()).rejects.toThrow(/already listening/);
  });
});
