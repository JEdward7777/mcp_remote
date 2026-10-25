// pair(): config must be saved before the server is told "claimed".
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { pair } from "../src/pair";

let dir: string;
let server: Server;
let wss: WebSocketServer;
let base: string;
let received: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpr-p-"));
  received = [];
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/pair/start") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: "ABCD-EFGH", pairing_id: "pid", poll_secret: "sec", expires_at: Date.now() + 60_000 }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (d) => received.push(d.toString()));
    ws.send(
      JSON.stringify({ t: "approved", token: "mrm1.a.b.c.d", machine_id: "m1", machine_name: "box", account: "me@x" }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("pair", () => {
  it("saves the config, then sends claimed", async () => {
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
    const out = await pair(base, { name: "box", onCode: () => {} });
    expect(existsSync(out.configPath)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toContain("claimed");
  });

  it("does not claim when saving fails", async () => {
    writeFileSync(join(dir, "afile"), "x");
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "afile", "cfg"); // mkdir under a file fails
    await expect(pair(base, { name: "box", onCode: () => {} })).rejects.toThrow(/could not save/);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).not.toContain("claimed");
  });
});
