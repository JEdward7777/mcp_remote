// Real shim process (dist/cli.js, built by `npm test`) driven by an MCP client, against an
// in-process Daemon whose Hub is a fake ws server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Daemon } from "../src/daemon";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let wss: WebSocketServer;
let daemon: Daemon;
let hubFrames: any[];
const clients: Client[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpr-s-"));
  hubFrames = [];
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      const s = d.toString();
      if (s === "ping") return;
      const f = JSON.parse(s);
      hubFrames.push(f);
      if (f.t === "send") ws.send(JSON.stringify({ t: "sent", req_id: f.req_id, message_id: 1 }));
    });
  });
  const port = (wss.address() as { port: number }).port;
  daemon = new Daemon({
    config: { url: `http://127.0.0.1:${port}`, token: "mrm1.t.t.t.t", machine_id: "m1" },
    socket: join(dir, "d.sock"),
  });
  await daemon.start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  daemon.stop();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function startShim(sessionId: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "shim"],
    cwd: dir,
    env: { ...process.env, MCP_REMOTE_SOCKET: join(dir, "d.sock"), MCP_REMOTE_SESSION_ID: sessionId } as Record<string, string>,
    stderr: "pipe",
  });
  const c = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await c.connect(transport);
  clients.push(c);
  return c;
}

describe("shim", () => {
  it("reports the daemon's refusal (duplicate session id) from send_message instead of 'daemon not running'", async () => {
    const first = await startShim("same-id");
    const ok = async () => !(await first.callTool({ name: "send_message", arguments: { text: "hi" } })).isError;
    for (let i = 0; i < 50 && !(await ok()); i++) await sleep(100);
    expect(await ok()).toBe(true);

    let shimConnections = 0;
    const proto = Daemon.prototype as unknown as { onShim: (...a: unknown[]) => void };
    const orig = proto.onShim;
    proto.onShim = function (this: unknown, ...a: unknown[]) {
      shimConnections++;
      return orig.apply(this, a);
    };
    const second = await startShim("same-id");
    let text = "";
    for (let i = 0; i < 50; i++) {
      const r = await second.callTool({ name: "send_message", arguments: { text: "hello" } });
      text = (r.content as { text: string }[])[0]?.text ?? "";
      if (/refused/.test(text)) break;
      await sleep(100);
    }
    expect(text).toMatch(/refused this session: another live session on this computer already uses session id "same-id"/);
    expect(text).not.toMatch(/not running/);
    // No fast retry loop: after the refusal the shim waits >= 15 s before trying again.
    await sleep(2000);
    proto.onShim = orig;
    expect(shimConnections).toBe(1);
    expect(hubFrames.filter((f) => f.t === "session_up" && f.session.session_id === "same-id").length).toBe(1);
  }, 20_000);
});
