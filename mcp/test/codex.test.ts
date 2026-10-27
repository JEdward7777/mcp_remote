// Codex backend helpers: argv construction, extra-args allowlist, prompt, JSONL event folding.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_RE,
  CODEX_INSTRUCTIONS,
  NOT_GIT_RE,
  NO_ROLLOUT_RE,
  SHIM_ENV_VARS,
  codexArgv,
  codexExtraArgsIssues,
  codexPrompt,
  foldEvent,
  newSummary,
  tomlString,
} from "../src/codex";
import { LaunchConfig } from "../src/launch-config";

const base = {
  bin: "/usr/bin/codex",
  mode: "workspace-write" as const,
  extraArgs: [] as string[],
  resume: null as string | null,
  skipGitRepoCheck: false,
  serverName: "mcp-remote",
  shim: ["/usr/bin/node", "/opt/mcp remote/cli.js"],
};
const fixture = (n: string) => readFileSync(join(__dirname, "fixtures", n), "utf8").trim().split("\n");

describe("codexArgv", () => {
  it("starts a new conversation with the prompt on stdin after --", () => {
    const a = codexArgv(base);
    expect(a.slice(0, 3)).toEqual(["/usr/bin/codex", "exec", "--json"]);
    expect(a.slice(-2)).toEqual(["--", "-"]);
    expect(a).not.toContain("resume");
    expect(a).toContain('approval_policy="never"');
    expect(a).toContain('sandbox_mode="workspace-write"');
    expect(a).not.toContain("--skip-git-repo-check");
    // The shim is defined per run: command, args (TOML array, path with a space), forwarded env vars, timeouts.
    expect(a).toContain('mcp_servers.mcp-remote.command="/usr/bin/node"');
    expect(a).toContain('mcp_servers.mcp-remote.args=["/opt/mcp remote/cli.js", "shim"]');
    expect(a).toContain(`mcp_servers.mcp-remote.env_vars=[${SHIM_ENV_VARS.map((v) => `"${v}"`).join(", ")}]`);
    expect(a.some((x) => /tool_timeout_sec=\d+/.test(x))).toBe(true);
    // Every -c value is its own argv element right after "-c".
    for (let i = 0; i < a.length; i++) if (a[i]!.startsWith("mcp_servers.")) expect(a[i - 1]).toBe("-c");
  });

  it("resumes an exact thread (id after --) or the folder's last one", () => {
    const id = "01a17b47-7383-7830-b9f5-1582b9c56491";
    const r = codexArgv({ ...base, resume: id });
    expect(r.slice(0, 4)).toEqual(["/usr/bin/codex", "exec", "resume", "--json"]);
    expect(r.slice(-3)).toEqual(["--", id, "-"]);
    const l = codexArgv({ ...base, resume: "last" });
    expect(l).toContain("--last");
    expect(l.slice(-2)).toEqual(["--", "-"]);
    expect(() => codexArgv({ ...base, resume: "--last; rm -rf /" })).toThrow(/thread id/);
  });

  it("maps modes: bypass flag, no sandbox when unset, skip-git when configured", () => {
    const b = codexArgv({ ...base, mode: "bypass" });
    expect(b).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(b.join(" ")).not.toMatch(/sandbox_mode|approval_policy/);
    const n = codexArgv({ ...base, mode: null });
    expect(n.join(" ")).not.toMatch(/sandbox_mode/);
    expect(n).toContain('approval_policy="never"');
    expect(codexArgv({ ...base, skipGitRepoCheck: true })).toContain("--skip-git-repo-check");
  });

  it("puts allowed extra args before -- and refuses managed ones", () => {
    const a = codexArgv({ ...base, extraArgs: ["-m", "gpt-5-codex", "-c", 'model_reasoning_effort="high"'] });
    expect(a.indexOf("gpt-5-codex")).toBeLessThan(a.indexOf("--"));
    expect(() => codexArgv({ ...base, extraArgs: ["--last"] })).toThrow(/not allowed/);
    expect(() => codexArgv({ ...base, serverName: "x.y" })).toThrow(/server name/);
  });

  it("never carries message text: hostile messages only reach the prompt", () => {
    const hostile = ["--dangerously-bypass-approvals-and-sandbox", "-", "a\nb", "it's \"quoted\"", "#(touch /tmp/pwned)", "$(id); `id`", "x;"];
    const msgs = hostile.map((text, i) => ({ id: i + 1, text, created_at: 0 }));
    const a = codexArgv(base);
    for (const h of hostile.slice(2)) expect(a.join("\0")).not.toContain(h);
    const p = codexPrompt(msgs, false);
    for (const h of hostile) expect(p).toContain(h);
  });
});

describe("codex extra args allowlist", () => {
  it("accepts model/config/feature flags", () => {
    expect(codexExtraArgsIssues(["-m", "o3", "--model=o3", "--enable", "x", "--disable=y", "--strict-config", "-c", "model=\"o3\""])).toEqual([]);
  });
  it("refuses flags that would change what mcp-remote manages", () => {
    for (const args of [
      ["--json"],
      ["-s", "danger-full-access"],
      ["--sandbox=read-only"],
      ["-a", "on-request"],
      ["--dangerously-bypass-approvals-and-sandbox"],
      ["--skip-git-repo-check"],
      ["-C", "/"],
      ["--cd=/"],
      ["--last"],
      ["--ephemeral"],
      ["-o", "/tmp/x"],
      ["resume"],
      ["some prompt"],
      ["-c", "sandbox_mode=\"danger-full-access\""],
      ["--config=approval_policy=\"on-request\""],
      ["-c", "mcp_servers.mcp-remote.command=\"/bin/sh\""],
      ["-c", "mcp_servers.other.command=\"x\""],
      ["-m"],
      ["--strict-config=1"],
    ]) {
      expect(codexExtraArgsIssues(args), JSON.stringify(args)).not.toEqual([]);
    }
  });
  it("is enforced by launch.json validation", () => {
    expect(LaunchConfig.safeParse({ codex_extra_args: ["-s", "danger-full-access"] }).success).toBe(false);
    expect(LaunchConfig.safeParse({ codex_extra_args: ["-m", "o3"] }).success).toBe(true);
    expect(LaunchConfig.parse({}).agents).toEqual(["claude"]);
    expect(LaunchConfig.parse({ agents: ["codex", "claude", "codex"] }).agents).toEqual(["codex", "claude"]);
  });
});

describe("tomlString", () => {
  it("quotes paths and refuses control characters", () => {
    expect(tomlString('C:\\a "b"')).toBe('"C:\\\\a \\"b\\""');
    expect(() => tomlString("a\nb")).toThrow();
  });
});

describe("codexPrompt", () => {
  it("has full guidance on a new conversation and a reminder on resume", () => {
    const m = [
      { id: 3, text: "first", created_at: Date.UTC(2026, 9, 27) },
      { id: 4, text: "second", created_at: Date.UTC(2026, 9, 27, 0, 1) },
    ];
    const fresh = codexPrompt(m, true);
    expect(fresh).toContain(CODEX_INSTRUCTIONS);
    expect(fresh.indexOf("first")).toBeLessThan(fresh.indexOf("second"));
    expect(fresh).toContain("message 3");
    const again = codexPrompt(m, false);
    expect(again).not.toContain(CODEX_INSTRUCTIONS);
    expect(again).toMatch(/send_message/);
  });
});

describe("foldEvent (JSONL from codex exec --json)", () => {
  it("reads a real offline run (codex-cli 0.164.0, no network): thread id, retries are not the outcome", () => {
    const s = newSummary();
    for (const l of fixture("codex-exec-offline.jsonl")) foldEvent(s, l);
    expect(s.thread_id).toBe("01a17b47-7383-7830-b9f5-1582b9c56491");
    expect(s.started).toBe(true);
    expect(s.completed).toBe(false);
    expect(s.error).toBeNull();
    expect(s.auth).toBe(false);
  });

  it("reads a completed turn (format from codex-rs exec_events.rs): final message, send_message calls", () => {
    const s = newSummary();
    const human = fixture("codex-exec-turn.jsonl").map((l) => foldEvent(s, l, "mcp-remote"));
    expect(s).toMatchObject({ completed: true, final: "I listed the files and messaged you.", sends: 1, auth: false });
    expect(human).toContain("$ bash -lc ls");
    expect(human).toContain("tool mcp-remote.send_message: completed");
    // Another server's send_message is not ours.
    const t = newSummary();
    for (const l of fixture("codex-exec-turn.jsonl")) foldEvent(t, l, "other");
    expect(t.sends).toBe(0);
  });

  it("flags an authentication failure (401 wording UNVERIFIED, derived)", () => {
    const s = newSummary();
    for (const l of fixture("codex-exec-auth.jsonl")) foldEvent(s, l);
    expect(s).toMatchObject({ completed: false, auth: true });
    expect(s.error).toMatch(/401/);
  });

  it("ignores junk and unknown events", () => {
    const s = newSummary();
    for (const l of ["", "not json", "[]", "null", '{"type":"x.y"}', '{"type":"thread.started","thread_id":"../../etc"}']) foldEvent(s, l);
    expect(s).toEqual(newSummary());
  });

  it("recognises Codex's stderr failures", () => {
    expect(NO_ROLLOUT_RE.test("Error: thread/resume: thread/resume failed: no rollout found for thread id 0000 (code -32600)")).toBe(true);
    expect(NOT_GIT_RE.test("Not inside a trusted directory and --skip-git-repo-check was not specified.")).toBe(true);
    expect(AUTH_RE.test("Not logged in")).toBe(true);
    expect(AUTH_RE.test("stream disconnected before completion: failed to lookup address information")).toBe(false);
  });
});
