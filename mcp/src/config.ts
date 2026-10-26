// Local configuration: ~/.config/mcp-remote/config.json (0600) in a 0700 directory.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./log";

export const Config = z.object({
  url: z.string().url(),
  token: z.string().min(10),
  machine_id: z.string().min(1),
  machine_name: z.string().optional(),
  account: z.string().optional(),
});
export type Config = z.infer<typeof Config>;

export function configDir(): string {
  if (process.env.MCP_REMOTE_CONFIG_DIR) return process.env.MCP_REMOTE_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "mcp-remote");
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config"), "mcp-remote");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Local IPC endpoint between shims and the daemon. */
export function socketPath(): string {
  if (process.env.MCP_REMOTE_SOCKET) return process.env.MCP_REMOTE_SOCKET;
  if (process.platform === "win32") {
    // Named pipes are per-user by default ACL; include the user name to avoid collisions.
    return `\\\\.\\pipe\\mcp-remote-${userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }
  return join(configDir(), "daemon.sock");
}

/**
 * Create the config dir with 0700. An existing directory is never chmod-ed (MCP_REMOTE_CONFIG_DIR
 * may point anywhere); it must belong to the current user, and a group/world-accessible one
 * only produces a warning.
 */
export function ensureConfigDir(): string {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(dir, 0o700); // umask can only remove bits; be explicit
    return dir;
  }
  if (process.platform !== "win32") {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new Error(`${dir} exists and is not a directory`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      throw new Error(`refusing to use ${dir}: it is owned by uid ${st.uid}, not you (uid ${uid})`);
    }
    if (st.mode & 0o077) {
      log(`warning: ${dir} is accessible by other users (mode ${(st.mode & 0o777).toString(8)}); consider chmod 700`);
    }
  }
  return dir;
}

export function saveConfig(cfg: Config): string {
  ensureConfigDir();
  const path = configPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`no config at ${path}; run \`mcp-remote pair <worker-url>\` first`);
  }
  if (process.platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      log(`warning: ${path} had mode ${mode.toString(8)}; tightening to 600`);
      chmodSync(path, 0o600);
    }
  }
  return Config.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** Normalize a Worker URL: https required except for local development hosts. */
export function normalizeWorkerUrl(input: string): string {
  const u = new URL(input);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("worker URL must be https:// (http:// is allowed only for localhost)");
  }
  return `${u.protocol}//${u.host}`;
}

export function wsUrl(base: string, path: string): string {
  const u = new URL(path, base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** Secrets / shell-only settings for the daemon and the sessions it launches (0600, never in the unit file). */
export function serviceEnvPath(): string {
  return join(configDir(), "service.env");
}

export const SERVICE_ENV_TEMPLATE = `# Environment for the mcp-remote daemon and the Claude Code sessions it launches from the phone.
# Read by \`mcp-remote daemon\` at startup (systemd, launchd or by hand); keep this file mode 0600.
# Put secrets and shell-only settings here, not in the service unit/plist. One KEY=value per line, e.g.:
#   CLAUDE_CODE_OAUTH_TOKEN=...        (from \`claude setup-token\`)
#   CLAUDE_CODE_USE_BEDROCK=1
#   AWS_PROFILE=work
#   HTTPS_PROXY=http://proxy.example:3128
# After editing: restart the daemon. Sessions already running keep their old environment, and the
# dedicated tmux server keeps the environment it started with until it exits (no launched sessions left,
# or \`tmux -L mcp-remote kill-server\`).
`;

/**
 * Load <config dir>/service.env into process.env (KEY=value lines, # comments, optional quotes).
 * Returns the variable names loaded (values are never logged).
 */
export function loadServiceEnv(path = serviceEnvPath()): string[] {
  if (!existsSync(path)) return [];
  if (process.platform !== "win32") {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      log(`warning: ${path} had mode ${mode.toString(8)}; tightening to 600 (it may hold secrets)`);
      chmodSync(path, 0o600);
    }
  }
  const keys: string[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      log(`warning: ignoring a line in ${path} that is not KEY=value`);
      continue;
    }
    const key = m[1]!;
    if (key === "MCP_REMOTE_CONFIG_DIR") continue; // would point away from the file being read
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    process.env[key] = v;
    keys.push(key);
  }
  return keys;
}
