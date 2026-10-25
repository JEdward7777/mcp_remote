// Desk-side CLI commands for remote launch: projects, config, setup-claude, attach.
import { execFileSync, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DaemonToShim, LaunchId } from "@mcp-remote/shared";
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
  out(`roots (each sub-folder is launchable): ${cfg.roots.length ? "" : "none"}`);
  for (const r of cfg.roots) out(`  ${r}`);
  out(`projects the phone can start (${projects.length}):`);
  if (!projects.length) out("  none yet: mcp-remote projects add <dir>   or   mcp-remote projects add-root <dir>");
  for (const p of projects) out(`  ${p.name.padEnd(24)} ${p.id}  ${p.path}${p.source === "root" ? "  [root]" : ""}${trustNote(p.path, trusted)}`);
  if (!which("tmux") && !cfg.tmux_path) out("warning: tmux is not installed; the phone cannot launch sessions until it is (tmux 3.2+).");
}

export async function projectsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const cfg = loadLaunchConfig();
  const ni = rest.indexOf("--name");
  const name = ni >= 0 ? rest[ni + 1] : undefined;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(ni >= 0 && i === ni + 1));
  switch (sub) {
    case "list":
    case undefined:
      listProjects();
      return;
    case "add": {
      const dir = positional[0];
      if (!dir) throw new Error("usage: mcp-remote projects add <dir> [--name <name>]");
      const path = normalizeDir(dir);
      cfg.projects = cfg.projects.filter((p) => p.path !== path);
      cfg.projects.push(name ? { path, name } : { path });
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

const CONFIG_KEYS = ["permission-mode", "claude-path", "extra-args", "max-sessions", "auto-restart", "tmux-path", "server-name", "startup-timeout"] as const;

export async function configCommand(args: string[]): Promise<void> {
  const [sub, key, ...vals] = args;
  const cfg = loadLaunchConfig();
  if (sub === "get" || sub === undefined) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  if (sub === "modes") {
    for (const m of PERMISSION_MODES) out(`  ${m.padEnd(18)} ${PERMISSION_MODE_HELP[m]}`);
    return;
  }
  if (sub !== "set" && sub !== "unset") throw new Error("usage: mcp-remote config get | modes | set <key> <value> | unset <key>");
  if (!key || !(CONFIG_KEYS as readonly string[]).includes(key)) throw new Error(`key must be one of: ${CONFIG_KEYS.join(", ")}`);
  const value = vals.join(" ");
  if (sub === "set" && !value && key !== "extra-args") throw new Error(`missing value for ${key}`);
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
