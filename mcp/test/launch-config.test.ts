import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LaunchConfig,
  findProject,
  isTrusted,
  launchConfigPath,
  loadLaunchConfig,
  normalizeDir,
  projectIdFor,
  resolveProjects,
  saveLaunchConfig,
} from "../src/launch-config";

let dir: string;
let code: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mcpr-lc-")));
  process.env.MCP_REMOTE_CONFIG_DIR = join(dir, "cfg");
  code = join(dir, "code");
  for (const d of ["alpha", "beta", ".hidden", "node_modules"]) mkdirSync(join(code, d), { recursive: true });
  writeFileSync(join(code, "README.md"), "not a folder");
  mkdirSync(join(dir, "other", "alpha"), { recursive: true });
});
afterEach(() => {
  delete process.env.MCP_REMOTE_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("launch config", () => {
  it("defaults when missing and saves 0600", () => {
    const cfg = loadLaunchConfig();
    expect(cfg).toMatchObject({ projects: [], roots: [], permission_mode: null, max_sessions: 4, auto_restart: false, tmux_socket: "mcp-remote" });
    cfg.permission_mode = "acceptEdits";
    const p = saveLaunchConfig(cfg);
    expect(p).toBe(launchConfigPath());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadLaunchConfig().permission_mode).toBe("acceptEdits");
  });

  it("rejects unknown permission modes and tmux-separator extra args", () => {
    expect(LaunchConfig.safeParse({ permission_mode: "yolo" }).success).toBe(false);
    for (const m of ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]) {
      expect(LaunchConfig.safeParse({ permission_mode: m }).success).toBe(true);
    }
    expect(LaunchConfig.safeParse({ extra_args: ["--model", "opus"] }).success).toBe(true);
    expect(LaunchConfig.safeParse({ extra_args: [";"] }).success).toBe(false);
    expect(LaunchConfig.safeParse({ extra_args: ["kill-server;"] }).success).toBe(false);
    expect(LaunchConfig.safeParse({ extra_args: ["a\nb"] }).success).toBe(false);
    expect(LaunchConfig.safeParse({ max_sessions: 99 }).success).toBe(false);
  });

  it("reports a clear error for a broken launch.json", () => {
    saveLaunchConfig(LaunchConfig.parse({}));
    writeFileSync(launchConfigPath(), JSON.stringify({ permission_mode: "nope" }));
    expect(() => loadLaunchConfig()).toThrow(/permission_mode/);
    writeFileSync(launchConfigPath(), "{");
    expect(() => loadLaunchConfig()).toThrow(/not valid JSON/);
  });

  it("resolves explicit projects and one level of non-hidden root sub-folders", () => {
    const cfg = LaunchConfig.parse({
      projects: [{ path: join(dir, "other", "alpha") }, { path: join(dir, "missing") }],
      roots: [code, join(dir, "no-such-root")],
    });
    const ps = resolveProjects(cfg);
    expect(ps.map((p) => [p.name, p.source])).toEqual([
      ["alpha", "explicit"],
      ["alpha-2", "root"],
      ["beta", "root"],
      ["node_modules", "root"],
    ]);
    // Ids are opaque and stable; they never contain the path.
    for (const p of ps) {
      expect(p.id).toMatch(/^p[0-9a-f]{15}$/);
      expect(p.id).toBe(projectIdFor(p.path));
      expect(p.id).not.toContain("alpha");
    }
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
  });

  it("dedupes the same folder reached through a symlink", () => {
    symlinkSync(join(code, "alpha"), join(dir, "link"));
    const cfg = LaunchConfig.parse({ projects: [{ path: join(dir, "link"), name: "via-link" }], roots: [code] });
    const ps = resolveProjects(cfg);
    expect(ps.filter((p) => p.path === join(code, "alpha"))).toHaveLength(1);
  });

  it("maps launch requests by id only", () => {
    const cfg = LaunchConfig.parse({ roots: [code] });
    const beta = resolveProjects(cfg).find((p) => p.name === "beta")!;
    expect(findProject(cfg, beta.id)?.path).toBe(join(code, "beta"));
    expect(findProject(cfg, join(code, "beta"))).toBeUndefined();
    expect(findProject(cfg, "beta")).toBeUndefined();
    expect(findProject(cfg, projectIdFor(join(dir, "other", "alpha")))).toBeUndefined(); // not allowlisted
  });

  it("normalizes user-typed folders and refuses files", () => {
    expect(normalizeDir(join(code, "alpha", ".."))).toBe(code);
    expect(() => normalizeDir(join(code, "README.md"))).toThrow(/not an existing directory/);
  });

  it("treats trust of a parent folder as covering sub-folders (verified with Claude Code 2.1.310)", () => {
    const t = new Set([code]);
    expect(isTrusted(t, join(code, "alpha"))).toBe(true);
    expect(isTrusted(t, join(dir, "other"))).toBe(false);
  });
});
