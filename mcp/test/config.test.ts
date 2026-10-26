import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig, loadServiceEnv, normalizeWorkerUrl, parseEnvValue, saveConfig, serviceEnvPath, socketPath, wsUrl } from "../src/config";
import { ensureServiceEnv } from "../src/service";

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

describe("ensureConfigDir", () => {
  it("does not chmod a pre-existing directory", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
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

describe("service.env (round-6 finding)", () => {
  it("creates a 0600 template and loads KEY=value lines into the environment", () => {
    const p = ensureServiceEnv();
    expect(p).toBe(serviceEnvPath());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadServiceEnv()).toEqual([]); // only comments
    writeFileSync(
      p,
      "# comment\nCLAUDE_CODE_OAUTH_TOKEN=tok-123\nexport HTTPS_PROXY='http://p:3128'\nAWS_PROFILE=\"work\"\nMCP_REMOTE_CONFIG_DIR=/elsewhere\nHOME=/elsewhere\nnot a line\n",
      { mode: 0o644 },
    );
    chmodSync(p, 0o644);
    const saved = { ...process.env };
    try {
      expect(loadServiceEnv()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY", "AWS_PROFILE"]);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
      expect(process.env.HTTPS_PROXY).toBe("http://p:3128");
      expect(process.env.AWS_PROFILE).toBe("work");
      expect(process.env.MCP_REMOTE_CONFIG_DIR).toBe(dir); // never redirected by the file
      expect(statSync(p).mode & 0o777).toBe(0o600); // tightened
    } finally {
      for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "HTTPS_PROXY", "AWS_PROFILE"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    // An existing file is never overwritten.
    ensureServiceEnv();
    expect(readFileSync(p, "utf8")).toContain("tok-123");
  });
});

describe("service.env syntax and safety (round-7 findings)", () => {
  it("expands $VAR / ${VAR}, strips inline comments, keeps single quotes literal", () => {
    const env = { HOME: "/home/you", PATH: "/usr/bin:/bin" };
    expect(parseEnvValue('"$HOME/.local/bin:$PATH"', env)).toBe("/home/you/.local/bin:/usr/bin:/bin");
    expect(parseEnvValue("${HOME}/x", env)).toBe("/home/you/x");
    expect(parseEnvValue("plain # a comment", env)).toBe("plain");
    expect(parseEnvValue("'$HOME # not a comment'", env)).toBe("$HOME # not a comment");
    expect(parseEnvValue('"a#b" # c', env)).toBe("a#b");
    expect(parseEnvValue("$UNSET_VAR_X", env)).toBe("");
    expect(parseEnvValue("tok-123", env)).toBe("tok-123");
    for (const bad of ['"unterminated', "'x' trailing", "$(whoami)", "a\\b", "`id`"]) expect(parseEnvValue(bad, env)).toBeNull();
    // Round 8: inside double quotes too, and any ${...} that isn't exactly ${NAME}.
    for (const bad of ['"$(cat ~/.tok)"', '"`cat ~/.tok`"', '"a\\nb"', '"${VAR:-x}"', "${PATH:-/bin}", "${PATH#/usr}", '"${}"', "${1}"]) {
      expect(parseEnvValue(bad, env), bad).toBeNull();
    }
    expect(parseEnvValue('"${HOME}/$PATH"', env)).toBe("/home/you//usr/bin:/bin");
    // Round 9: an unquoted ~ (leading or after ':') is refused, not kept literally.
    for (const bad of ["~/.local/bin", "/usr/bin:~/bin"]) expect(parseEnvValue(bad, env), bad).toBeNull();
    expect(parseEnvValue("a~b", env)).toBe("a~b");
    expect(parseEnvValue("'~/x'", env)).toBe("~/x");
    expect(parseEnvValue("'${VAR:-x} $(y) `z`'", env)).toBe("${VAR:-x} $(y) `z`"); // literal in single quotes
  });

  it("applies expansion when loading, line by line", () => {
    const p = serviceEnvPath();
    saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    writeFileSync(p, 'export PATH="$HOME/.local/bin:$PATH"\nMR_TEST_A=one\nMR_TEST_B="${MR_TEST_A}-two" # inline\nMR_TEST_C=$(id)\n', { mode: 0o600 });
    const saved = process.env.PATH;
    try {
      expect(loadServiceEnv()).toEqual(["PATH", "MR_TEST_A", "MR_TEST_B"]);
      expect(process.env.PATH).toBe(`${process.env.HOME}/.local/bin:${saved}`);
      expect(process.env.MR_TEST_B).toBe("one-two");
      expect(process.env.MR_TEST_C).toBeUndefined();
    } finally {
      process.env.PATH = saved;
      delete process.env.MR_TEST_A;
      delete process.env.MR_TEST_B;
    }
  });

  it("refuses a symlinked or foreign-owned file", async () => {
    const { symlinkSync, chownSync, unlinkSync } = await import("node:fs");
    const p = serviceEnvPath();
    saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    writeFileSync(join(dir, "real.env"), "A=1\n", { mode: 0o600 });
    symlinkSync(join(dir, "real.env"), p);
    expect(() => loadServiceEnv()).toThrow(/not a symlink/);
    unlinkSync(p);
    if (process.getuid?.() === 0) {
      writeFileSync(p, "A=1\n", { mode: 0o600 });
      chownSync(p, 4321, 4321);
      expect(() => loadServiceEnv()).toThrow(/owned by uid 4321/);
    }
  });

  it("the daemon exits 5 (no systemd restart loop) on an unusable service.env", async () => {
    const { spawnSync } = await import("node:child_process");
    const { symlinkSync } = await import("node:fs");
    saveConfig({ url: "https://x.example", token: "mrm1.aaaa.bbbb.cccc.dddd", machine_id: "m1" });
    writeFileSync(join(dir, "real.env"), "A=1\n", { mode: 0o600 });
    symlinkSync(join(dir, "real.env"), serviceEnvPath());
    const cli = join(__dirname, "..", "dist", "cli.js");
    const r = spawnSync(process.execPath, [cli, "daemon"], { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: dir }, encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(5);
    expect(r.stderr).toMatch(/not a symlink/);
    const r0 = spawnSync(process.execPath, [cli, "daemon"], { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: dir, MCP_REMOTE_FATAL_EXIT_ZERO: "1" }, encoding: "utf8", timeout: 15000 });
    expect(r0.status).toBe(0);
  });
});
