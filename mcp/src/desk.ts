// Desk-side CLI commands for remote launch: projects, config, setup-claude, attach.
import { execFileSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS, Agent, DaemonToShim, LaunchId } from "@mcp-remote/shared";
import { CODEX_FINAL, CODEX_MODES, CODEX_MODE_HELP, CodexMode, codexExtraArgsIssues } from "./codex";
import { socketPath } from "./config";
import { LineConn } from "./ipc";
import {
  type LaunchConfig,
  PERMISSION_MODES,
  PERMISSION_MODE_HELP,
  PermissionMode,
  claudeTrustedDirs,
  isTrusted,
  launchConfigPath,
  loadLaunchConfig,
  normalizeDir,
  resolveProjects,
  saveLaunchConfig,
} from "./launch-config";
import { baseArgs, which } from "./tmux";

const out = (s: string) => process.stderr.write(s.endsWith("\n") ? s : s + "\n");

/** Ask a running daemon to re-read launch.json. Silent if no daemon is running. */
export async function notifyDaemon(sock = socketPath()): Promise<void> {
  await new Promise<void>((resolve) => {
    const s = createConnection(sock);
    const timer = setTimeout(() => {
      s.destroy();
      resolve();
    }, 3000);
    s.once("error", () => {
      clearTimeout(timer);
      out("(daemon not running; it reads the new settings when it starts)");
      resolve();
    });
    s.once("connect", () => {
      const c = new LineConn(
        s,
        DaemonToShim,
        (f) => {
          if (f.t !== "reloaded") return;
          clearTimeout(timer);
          out(f.ok ? "daemon reloaded; the phone shows the new project list" : `daemon reloaded, but launching is unavailable: ${f.error}`);
          c.close();
          resolve();
        },
        () => {},
      );
      c.send({ t: "reload" });
    });
  });
}

function save(cfg: LaunchConfig): void {
  out(`saved ${saveLaunchConfig(cfg)}`);
}

function trustNote(path: string, trusted: Set<string> | null): string {
  if (!trusted) return "";
  return isTrusted(trusted, path) ? "" : "  (Claude Code will ask to trust this folder: run `claude` there once and accept)";
}

export function listProjects(): void {
  const cfg = loadLaunchConfig();
  const projects = resolveProjects(cfg);
  const trusted = claudeTrustedDirs();
  out(`launch settings: ${launchConfigPath()}`);
  out(`  permission mode: ${cfg.permission_mode ?? "(not passed; Claude Code's default)"}`);
  out(`  claude: ${cfg.claude_path ?? `${which("claude") ?? "NOT FOUND on PATH"} (from PATH)`}`);
  if (cfg.extra_args.length) out(`  extra args: ${JSON.stringify(cfg.extra_args)}`);
  out(`  max sessions: ${cfg.max_sessions}, auto-restart default: ${cfg.auto_restart ? "on" : "off"}`);
  out(`  agents: ${cfg.agents.join(", ")} (default for new projects and root folders: ${cfg.default_agent})`);
  if (cfg.agents.includes("codex")) {
    out(`  codex: ${cfg.codex_path ?? `${which("codex") ?? "NOT FOUND on PATH"} (from PATH)`}, mode: ${cfg.codex_mode ?? "(not passed; Codex's own default)"}`);
    if (cfg.codex_extra_args.length) out(`  codex extra args: ${JSON.stringify(cfg.codex_extra_args)}`);
  }
  out(`roots (each sub-folder is launchable): ${cfg.roots.length ? "" : "none"}`);
  for (const r of cfg.roots) out(`  ${r}`);
  out(`projects the phone can start (${projects.length}):`);
  if (!projects.length) out("  none yet: mcp-remote projects add <dir>   or   mcp-remote projects add-root <dir>");
  for (const p of projects) {
    out(`  ${p.name.padEnd(24)} ${p.id}  ${p.agent.padEnd(6)} ${p.path}${p.source === "root" ? "  [root]" : ""}${p.agent === "claude" ? trustNote(p.path, trusted) : ""}`);
  }
  if (!which("tmux") && !cfg.tmux_path) out("warning: tmux is not installed; the phone cannot launch sessions until it is (tmux 3.2+).");
}

export async function projectsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const cfg = loadLaunchConfig();
  const ni = rest.indexOf("--name");
  const name = ni >= 0 ? rest[ni + 1] : undefined;
  const ai = rest.indexOf("--agent");
  const agentArg = ai >= 0 ? rest[ai + 1] : undefined;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(ni >= 0 && i === ni + 1) && !(ai >= 0 && i === ai + 1));
  switch (sub) {
    case "list":
    case undefined:
      listProjects();
      return;
    case "add": {
      const dir = positional[0];
      if (!dir) throw new Error("usage: mcp-remote projects add <dir> [--name <name>] [--agent claude|codex]");
      let agent: Agent | undefined;
      if (ai >= 0) {
        const r = Agent.safeParse(agentArg);
        if (!r.success) throw new Error(`--agent must be one of: ${AGENTS.join(", ")}`);
        agent = r.data;
        if (!cfg.agents.includes(agent)) out(`note: ${agent} is not enabled on this computer yet (${agent === "codex" ? "mcp-remote setup-codex" : "mcp-remote config set agents claude,codex"})`);
      }
      const path = normalizeDir(dir);
      cfg.projects = cfg.projects.filter((p) => p.path !== path);
      cfg.projects.push({ path, ...(name ? { name } : {}), ...(agent ? { agent } : {}) });
      save(cfg);
      const trusted = claudeTrustedDirs();
      const note = trustNote(path, trusted);
      if (note) out(note.trim());
      await notifyDaemon();
      return;
    }
    case "add-root": {
      const dir = positional[0];
      if (!dir) throw new Error("usage: mcp-remote projects add-root <dir>");
      const path = normalizeDir(dir);
      if (!cfg.roots.includes(path)) cfg.roots.push(path);
      save(cfg);
      out(`every non-hidden sub-folder of ${path} is now launchable from the phone (one level deep).`);
      const note = trustNote(path, claudeTrustedDirs());
      if (note) out("Tip: trusting this root folder once in Claude Code (run `claude` in it) covers all its sub-folders.");
      await notifyDaemon();
      return;
    }
    case "remove": {
      const key = positional[0];
      if (!key) throw new Error("usage: mcp-remote projects remove <dir|name|id>");
      let abs: string | null = null;
      try {
        abs = normalizeDir(key);
      } catch {
        /* not a folder (any more): match by name/id/stored path */
      }
      const resolved = resolveProjects(cfg);
      const hit = resolved.find((p) => p.id === key || p.name === key || p.path === abs);
      const before = cfg.projects.length + cfg.roots.length;
      cfg.projects = cfg.projects.filter((p) => p.path !== key && p.path !== abs && p.path !== hit?.path);
      cfg.roots = cfg.roots.filter((r) => r !== key && r !== abs);
      if (cfg.projects.length + cfg.roots.length === before) {
        if (hit?.source === "root") throw new Error(`${hit.name} comes from a root folder; remove the root with \`mcp-remote projects remove <root dir>\``);
        throw new Error(`no project or root matches ${key}`);
      }
      save(cfg);
      await notifyDaemon();
      return;
    }
    default:
      throw new Error(`unknown projects command: ${sub} (list | add <dir> | add-root <dir> | remove <dir|name|id>)`);
  }
}

const CONFIG_KEYS = [
  "permission-mode",
  "claude-path",
  "extra-args",
  "max-sessions",
  "auto-restart",
  "tmux-path",
  "server-name",
  "startup-timeout",
  "agents",
  "default-agent",
  "codex-path",
  "codex-mode",
  "codex-extra-args",
  "codex-skip-git-check",
  "codex-turn-timeout",
  "codex-final-message",
] as const;

export async function configCommand(args: string[]): Promise<void> {
  const [sub, key, ...vals] = args;
  const cfg = loadLaunchConfig();
  if (sub === "get" || sub === undefined) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  if (sub === "modes") {
    out("Claude Code (permission-mode):");
    for (const m of PERMISSION_MODES) out(`  ${m.padEnd(18)} ${PERMISSION_MODE_HELP[m]}`);
    out("Codex (codex-mode; approvals are always \"never\": nobody can answer a prompt from the phone):");
    for (const m of CODEX_MODES) out(`  ${m.padEnd(18)} ${CODEX_MODE_HELP[m]}`);
    return;
  }
  if (sub !== "set" && sub !== "unset") throw new Error("usage: mcp-remote config get | modes | set <key> <value> | unset <key>");
  if (!key || !(CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`key must be one of: ${CONFIG_KEYS.join(", ")}`);
  const value = vals.join(" ");
  if (sub === "set" && !value && key !== "extra-args" && key !== "codex-extra-args") throw new Error(`missing value for ${key}`);
  const unset = sub === "unset";
  switch (key) {
    case "permission-mode": {
      if (unset) cfg.permission_mode = null;
      else {
        const m = PermissionMode.safeParse(value);
        if (!m.success) throw new Error(`permission mode must be one of: ${PERMISSION_MODES.join(", ")} (see \`mcp-remote config modes\`)`);
        cfg.permission_mode = m.data;
        out(`${m.data}: ${PERMISSION_MODE_HELP[m.data]}`);
        if (m.data === "default" || m.data === "manual" || m.data === "plan") {
          out("note: permission prompts can't be answered from the phone yet (D18); sessions will wait for you at the desk.");
        }
        if (m.data === "bypassPermissions") {
          out("note: Claude Code shows a Bypass Permissions warning the first time; accept it once at the desk (it is not answered automatically).");
        }
      }
      break;
    }
    case "claude-path":
      if (unset) cfg.claude_path = null;
      else {
        const p = which(value);
        if (!p) throw new Error(`${value} is not an executable file`);
        cfg.claude_path = realpathSync(p);
      }
      break;
    case "tmux-path":
      if (unset) cfg.tmux_path = null;
      else {
        const p = which(value);
        if (!p) throw new Error(`${value} is not an executable file`);
        cfg.tmux_path = p;
      }
      break;
    case "extra-args": {
      // Everything after the key, as separate arguments: mcp-remote config set extra-args --model opus
      cfg.extra_args = unset ? [] : vals;
      break;
    }
    case "max-sessions":
      cfg.max_sessions = unset ? 4 : Number(value);
      break;
    case "auto-restart":
      if (!unset && !["on", "off", "true", "false"].includes(value)) throw new Error("auto-restart must be on or off");
      cfg.auto_restart = !unset && (value === "on" || value === "true");
      break;
    case "server-name":
      cfg.server_name = unset ? "mcp-remote" : value;
      break;
    case "startup-timeout":
      cfg.startup_timeout_s = unset ? 90 : Number(value);
      break;
    case "agents": {
      if (unset) cfg.agents = ["claude"];
      else {
        const list = value.split(/[\s,]+/).filter(Boolean);
        const bad = list.find((a) => !Agent.safeParse(a).success);
        if (bad || !list.length) throw new Error(`agents: a comma-separated list of ${AGENTS.join(", ")}`);
        cfg.agents = [...new Set(list as Agent[])];
      }
      break;
    }
    case "default-agent": {
      if (unset) cfg.default_agent = "claude";
      else {
        const r = Agent.safeParse(value);
        if (!r.success) throw new Error(`default-agent must be one of: ${AGENTS.join(", ")}`);
        cfg.default_agent = r.data;
      }
      break;
    }
    case "codex-path":
      if (unset) cfg.codex_path = null;
      else {
        const p = which(value);
        if (!p) throw new Error(`${value} is not an executable file`);
        cfg.codex_path = realpathSync(p);
      }
      break;
    case "codex-mode": {
      if (unset) cfg.codex_mode = null;
      else {
        const m = CodexMode.safeParse(value);
        if (!m.success) throw new Error(`codex mode must be one of: ${CODEX_MODES.join(", ")} (see \`mcp-remote config modes\`)`);
        cfg.codex_mode = m.data;
        out(`${m.data}: ${CODEX_MODE_HELP[m.data]}`);
      }
      break;
    }
    case "codex-extra-args": {
      const args = unset ? [] : vals;
      const issues = codexExtraArgsIssues(args);
      if (issues.length) throw new Error(issues[0]);
      cfg.codex_extra_args = args;
      break;
    }
    case "codex-skip-git-check":
      if (!unset && !["on", "off", "true", "false"].includes(value)) throw new Error("codex-skip-git-check must be on or off");
      cfg.codex_skip_git_repo_check = !unset && (value === "on" || value === "true");
      break;
    case "codex-turn-timeout":
      cfg.codex_turn_timeout_s = unset ? 3600 : Number(value);
      break;
    case "codex-final-message":
      if (!unset && !(CODEX_FINAL as readonly string[]).includes(value)) throw new Error(`codex-final-message must be one of: ${CODEX_FINAL.join(", ")}`);
      cfg.codex_final_message = unset ? "fallback" : (value as (typeof CODEX_FINAL)[number]);
      break;
  }
  save(cfg);
  await notifyDaemon();
}

/**
 * argv for `claude mcp add`: name first, then -e (variadic, so it is followed by another option, never the
 * name), then --scope, then `--` and the command. Verified against Claude Code 2.1.310.
 */
export function mcpAddArgs(o: { name: string; scope: "user" | "local"; node: string; cli: string; env: Record<string, string> }): string[] {
  const args = ["mcp", "add", o.name];
  for (const [k, v] of Object.entries(o.env)) args.push("-e", `${k}=${v}`);
  args.push("--scope", o.scope, "--", o.node, o.cli, "shim");
  return args;
}

export function setupClaude(args: string[]): void {
  const dry = args.includes("--dry-run");
  const force = args.includes("--force");
  const si = args.indexOf("--scope");
  const scope = (si >= 0 ? args[si + 1] : "user") as "user" | "local";
  if (scope !== "user" && scope !== "local") throw new Error("--scope must be user or local");
  const cfg = loadLaunchConfig();
  const claude = cfg.claude_path ?? which("claude");
  if (!claude) throw new Error("claude not found on PATH (install Claude Code, or `mcp-remote config set claude-path <path>`)");
  const env: Record<string, string> = {};
  if (process.env.MCP_REMOTE_CONFIG_DIR) env.MCP_REMOTE_CONFIG_DIR = process.env.MCP_REMOTE_CONFIG_DIR;
  const cli = realpathSync(fileURLToPath(import.meta.url));
  const argv = mcpAddArgs({ name: cfg.server_name, scope, node: realpathSync(process.execPath), cli, env });
  if (dry) {
    process.stdout.write(`${claude} ${argv.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    return;
  }
  if (force) {
    try {
      execFileSync(claude, ["mcp", "remove", cfg.server_name, "--scope", scope], { stdio: "ignore" });
    } catch {
      /* wasn't there */
    }
  }
  const r = spawnSync(claude, argv, { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    if (/already exists/.test(r.stderr ?? "")) {
      throw new Error(`Claude Code already has an MCP server named ${cfg.server_name} (${scope} scope). Re-run with --force to replace it.`);
    }
    throw new Error(`claude mcp add failed (exit ${r.status})`);
  }
  out(
    `Registered the shim with Claude Code (${scope} scope) as "${cfg.server_name}". Servers registered this way ` +
      "need no per-project approval. Don't also list it in a project's .mcp.json (that adds an approval prompt).",
  );
}

/** `mcp-remote attach <launch id>`: open a phone-launched session's terminal at the desk. */
export function attach(args: string[]): void {
  const id = args[0];
  const r = LaunchId.safeParse(id);
  if (!r.success) throw new Error("usage: mcp-remote attach mr-<id>   (the id is shown on the phone and in `tmux -L mcp-remote ls`)");
  const cfg = loadLaunchConfig();
  const tmux = cfg.tmux_path ?? which("tmux");
  if (!tmux) throw new Error("tmux is not installed");
  const res = spawnSync(tmux, [...baseArgs({ bin: tmux, socket: cfg.tmux_socket }), "attach-session", "-t", `=${r.data}`], { stdio: "inherit" });
  if (res.status !== 0) process.exitCode = res.status ?? 1;
}

/** Codex's config file (it honours CODEX_HOME, default ~/.codex). */
export function codexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml");
}

/** argv for `codex mcp add` (verified on 0.164.0: `codex mcp add <name> [--env K=V] -- <command>...`). */
export function codexMcpAddArgs(o: { name: string; node: string; cli: string; env: Record<string, string> }): string[] {
  const args = ["mcp", "add", o.name];
  for (const [k, v] of Object.entries(o.env)) args.push("--env", `${k}=${v}`);
  args.push("--", o.node, o.cli, "shim");
  return args;
}

interface CodexServerEntry {
  name: string;
  transport?: { type?: string; command?: string; args?: string[]; env?: Record<string, string> | null };
}

/**
 * `mcp-remote setup-codex [--force] [--dry-run] [--no-register]`: enable Codex launches on this computer.
 *  - checks the codex binary and its login (offline: `codex login status`);
 *  - registers the shim in Codex's config with `codex mcp add` (Codex writes its own TOML; the file is backed
 *    up first; nothing happens when the same registration exists; a different one needs --force).
 *    Optional for phone launches (the daemon passes the shim to every turn itself), but it shows up in
 *    `codex mcp list` and keeps the name taken. In your own Codex sessions the shim stays dormant (no tools);
 *  - adds "codex" to the agents the phone may start (launch.json).
 */
export async function setupCodex(args: string[]): Promise<void> {
  const dry = args.includes("--dry-run");
  const force = args.includes("--force");
  const register = !args.includes("--no-register");
  const cfg = loadLaunchConfig();
  const codex = cfg.codex_path ?? which("codex");
  if (!codex) throw new Error("codex not found on PATH (install it: npm i -g @openai/codex, or `mcp-remote config set codex-path <path>`)");
  const run = (a: string[]) => spawnSync(codex, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const ver = run(["--version"]);
  out(`codex: ${codex} (${(ver.stdout || "").trim() || "version unknown"})`);
  const login = run(["login", "status"]);
  const loginText = `${login.stdout ?? ""}${login.stderr ?? ""}`.split("\n").filter((l) => l.trim() && !/^WARNING:/.test(l)).join(" ").trim();
  if (login.status === 0) out(`login: ${loginText || "ok"}`);
  else if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) out(`login: ${loginText || "not logged in"} (an API key is set in this shell; the daemon needs it too: service.env)`);
  else out(`login: ${loginText || "not logged in"}. Run \`codex login\` before starting Codex sessions from the phone.`);

  const env: Record<string, string> = {};
  if (process.env.MCP_REMOTE_CONFIG_DIR) env.MCP_REMOTE_CONFIG_DIR = process.env.MCP_REMOTE_CONFIG_DIR;
  const node = realpathSync(process.execPath);
  const cli = realpathSync(fileURLToPath(import.meta.url));
  const addArgs = codexMcpAddArgs({ name: cfg.server_name, node, cli, env });
  if (register) {
    const listed = run(["mcp", "list", "--json"]);
    let existing: CodexServerEntry | undefined;
    try {
      existing = (JSON.parse(listed.stdout || "[]") as CodexServerEntry[]).find((x) => x.name === cfg.server_name);
    } catch {
      existing = undefined;
    }
    const same =
      existing?.transport?.type === "stdio" &&
      existing.transport.command === node &&
      JSON.stringify(existing.transport.args ?? []) === JSON.stringify([cli, "shim"]) &&
      JSON.stringify(existing.transport.env ?? {}) === JSON.stringify(env);
    const file = codexConfigPath();
    if (same) out(`Codex already has the shim registered as "${cfg.server_name}" (${file}); nothing to change.`);
    else if (existing && !force) {
      throw new Error(
        `Codex already has an MCP server named "${cfg.server_name}" with a different command (${file}). ` +
          "Re-run with --force to replace it (the file is backed up first), or pick another name: mcp-remote config set server-name <name>",
      );
    } else if (dry) {
      if (existsSync(file)) out(`would back up ${file} to ${file}.bak-<time>`);
      process.stdout.write(`${codex} ${addArgs.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    } else {
      if (existsSync(file)) {
        const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(file, bak);
        if (process.platform !== "win32") chmodSync(bak, 0o600);
        out(`backed up ${file} to ${bak}`);
      }
      const r = spawnSync(codex, addArgs, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30_000 });
      if (r.status !== 0) throw new Error(`codex mcp add failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
      out(`Registered the shim with Codex as "${cfg.server_name}" (${file}). Your own Codex sessions keep it dormant (no tools).`);
    }
  }
  if (cfg.agents.includes("codex")) out("Codex launches are already enabled on this computer.");
  else if (dry) out(`would enable Codex launches (agents: ${[...cfg.agents, "codex"].join(", ")})`);
  else {
    cfg.agents = [...cfg.agents, "codex"];
    save(cfg);
    out("Enabled Codex launches: the phone's Start picker now offers Codex.");
  }
  if (!cfg.codex_mode) {
    out(
      "Pick how Codex may act when started from the phone (D18), e.g. `mcp-remote config set codex-mode workspace-write` " +
        "(see `mcp-remote config modes`). Unset, mcp-remote passes no sandbox and Codex's own default / config.toml applies.",
    );
  }
  out("Choose Codex per project with `mcp-remote projects add <dir> --agent codex`, or pick it in the phone's Start picker.");
  if (!dry) await notifyDaemon();
}
