import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, normalizeWorkerUrl, saveConfig, socketPath, wsUrl } from "../src/config";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "mcpr-cfg-")), "nested");
  process.env.MCP_REMOTE_CONFIG_DIR = dir;
});
afterEach(() => {
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("config", () => {
  it("saves with 0600 in a 0700 dir and loads back", () => {
    const cfg = { url: "https://x.example.workers.dev", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" };
    const p = saveConfig(cfg);
    expect(p).toBe(configPath());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(loadConfig()).toEqual(cfg);
    expect(socketPath()).toBe(join(dir, "daemon.sock"));
  });

  it("tightens a too-open config file on load", () => {
    const p = saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    chmodSync(p, 0o644);
    loadConfig();
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("errors clearly when not paired or malformed", () => {
    expect(() => loadConfig()).toThrow(/mcp-remote pair/);
    saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    writeFileSync(configPath(), "{}", { mode: 0o600 });
    expect(() => loadConfig()).toThrow();
  });
});

describe("urls", () => {
  it("requires https except for localhost", () => {
    expect(normalizeWorkerUrl("https://a.b.workers.dev/some/path")).toBe("https://a.b.workers.dev");
    expect(normalizeWorkerUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeWorkerUrl("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(() => normalizeWorkerUrl("http://a.b.workers.dev")).toThrow(/https/);
    expect(() => normalizeWorkerUrl("ftp://x")).toThrow();
  });

  it("maps http(s) to ws(s)", () => {
    expect(wsUrl("https://a.b", "/api/daemon/ws")).toBe("wss://a.b/api/daemon/ws");
    expect(wsUrl("http://localhost:1", "/x")).toBe("ws://localhost:1/x");
  });
});
