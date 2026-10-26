// pair(): config must be saved before the server is told "claimed" (an authenticated POST since Phase 3).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { pair, pairWithCode } from "../src/pair";

let dir: string;
let server: Server;
let wss: WebSocketServer;
let base: string;
let received: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mcpr-p-"));
  received = [];
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/pair/claim?")) {
      const u = new URL(req.url, "http://x");
      received.push(`claim ${u.searchParams.get("code")} ${u.searchParams.get("pairing_id")} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "POST" && req.url === "/api/pair/redeem") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(`redeem ${body}`);
        res.setHeader("content-type", "application/json");
        if (JSON.parse(body).code === "ZZZZ-ZZZZ-ZZZZ-ZZZZ") {
          res.statusCode = 404;
          res.end('{"error":"unknown or expired code; get a new install command from the app (Machines)"}');
          return;
        }
        res.end(JSON.stringify({ token: "mrm1.a.b.c.d", machine_id: "m2", machine_name: "laptop", account: "me@x", pairing_id: "pid2", poll_secret: "sec2" }));
      });
      return;
    }
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

describe("pair --code (one-line install, Phase 4b)", () => {
  it("redeems the pre-approved code, saves the config, then claims", async () => {
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
    const out = await pairWithCode(base, "abcd-efgh-jkmn-pqrs", { name: "laptop" });
    expect(existsSync(out.configPath)).toBe(true);
    expect(out).toMatchObject({ machine_id: "m2", machine_name: "laptop", account: "me@x" });
    expect(received[0]).toBe('redeem {"code":"ABCD-EFGH-JKMN-PQRS","hostname":"laptop"}');
    expect(received[1]).toBe("claim ABCD-EFGH-JKMN-PQRS pid2 Bearer sec2");
  });

  it("refuses a malformed code locally and explains an unknown one", async () => {
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
    await expect(pairWithCode(base, "ABCD-EFGH")).rejects.toThrow(/XXXX-XXXX-XXXX-XXXX/);
    await expect(pairWithCode(base, "ZZZZ-ZZZZ-ZZZZ-ZZZZ")).rejects.toThrow(/unknown or expired code.*HTTP 404/);
    expect(existsSync(join(dir, "cfg", "config.json"))).toBe(false);
  });
});

describe("pair", () => {
  it("saves the config, then claims over HTTP (no frame on the wait socket)", async () => {
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
    const out = await pair(base, { name: "box", onCode: () => {} });
    expect(existsSync(out.configPath)).toBe(true);
    expect(received).toEqual(["claim ABCD-EFGH pid Bearer sec"]);
  });

  it("does not claim when saving fails", async () => {
    writeFileSync(join(dir, "afile"), "x");
    process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "afile", "cfg"); // mkdir under a file fails
    await expect(pair(base, { name: "box", onCode: () => {} })).rejects.toThrow(/could not save/);
    await new Promise((r) => setTimeout(r, 50));
    expect(received.filter((x) => x.startsWith("claim"))).toEqual([]);
  });
});
