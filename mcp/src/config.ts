// Local configuration: ~/.config/mcp-remote/config.json (0600) in a 0700 directory.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
# Put secrets and shell-only settings here, not in the service unit/plist.
# Syntax: KEY=value or export KEY=value, one per line; # starts a comment (also after an unquoted value).
# 'single quotes' are literal; "double quotes" and unquoted values expand $VAR and \${VAR} from the daemon's
# environment and earlier lines (e.g. PATH="$HOME/.local/bin:$PATH"). Lines with other shell syntax ($(...),
# backticks, backslashes, \${VAR:-default}, an unquoted ~) are skipped with a warning: write $HOME instead of ~.
# HOME, XDG_CONFIG_HOME, APPDATA, USERPROFILE, MCP_REMOTE_CONFIG_DIR and MCP_REMOTE_SOCKET are ignored here.
# Examples:
#   CLAUDE_CODE_OAUTH_TOKEN=...        (from \`claude setup-token\`)
#   CLAUDE_CODE_USE_BEDROCK=1
#   AWS_PROFILE=work
#   HTTPS_PROXY=http://proxy.example:3128
# After editing: restart the daemon. Sessions already running keep their old environment, and the
# dedicated tmux server keeps the environment it started with until it exits (no launched sessions left,
# or \`tmux -L mcp-remote kill-server\`).
`;

/** A problem with the daemon's own settings: restarting can't fix it (exit code 5, see service.ts). */
export class ConfigError extends Error {}

/**
 * Keys service.env may not set: they would move the config dir / socket away from the config.json that was
 * already read (or point the file at another one).
 */
export const SERVICE_ENV_BLOCKED = ["MCP_REMOTE_CONFIG_DIR", "MCP_REMOTE_SOCKET", "HOME", "XDG_CONFIG_HOME", "APPDATA", "USERPROFILE"];

/**
 * Parse one service.env value: 'single quotes' are literal; "double quotes" and unquoted values expand
 * $VAR / ${VAR} from `env`; an unquoted value ends at " #" (inline comment). Undefined variables expand
 * to "". Returns null for anything else that is shell syntax (command substitution, backticks, backslashes,
 * ${VAR:-x} and other ${...} forms, an unterminated quote, trailing text), so the line is skipped with a warning.
 */
export function parseEnvValue(raw: string, env: NodeJS.ProcessEnv): string | null {
  const expand = (t: string) =>
    t.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_m, a: string | undefined, b: string | undefined) => env[a ?? b ?? ""] ?? "");
  const v = raw.trim();
  // Any ${...} other than exactly ${NAME} (e.g. ${VAR:-x}) is shell syntax this parser doesn't implement.
  const badBraces = (t: string) => /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(t);
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end < 0 || !/^\s*(#.*)?$/.test(v.slice(end + 1))) return null;
    return v.slice(1, end);
  }
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    if (end < 0 || !/^\s*(#.*)?$/.test(v.slice(end + 1))) return null;
    const inner = v.slice(1, end);
    if (/[`\\]/.test(inner) || inner.includes("$(") || badBraces(inner)) return null;
    return expand(inner);
  }
  const unquoted = v.replace(/\s+#.*$/, "");
  // A shell would expand an unquoted leading ~ (also after ':'); we don't: refuse rather than keep it literally.
  if (/(^|:)~/.test(unquoted)) return null;
  if (/["'`\\]/.test(unquoted) || /\$\(/.test(unquoted) || badBraces(unquoted)) return null; // shell syntax we don't support
  return expand(unquoted);
}

/**
 * Load <config dir>/service.env into process.env. Syntax: `KEY=value` or `export KEY=value`, one per line;
 * # comments; values as in parseEnvValue. The file must be a regular file owned by you (not a symlink) and
 * is kept at mode 0600. Returns the variable names loaded (values are never logged).
 */
export function loadServiceEnv(path = serviceEnvPath()): string[] {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return [];
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new ConfigError(`${path} must be a regular file, not a symlink or anything else`);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new ConfigError(`${path} is owned by uid ${st.uid}, not you (uid ${uid}); refusing to read it`);
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      try {
        chmodSync(path, 0o600);
      } catch (e) {
        throw new ConfigError(`${path} has mode ${mode.toString(8)} and could not be made 0600 (${e instanceof Error ? e.message : e}); fix it with chmod 600`);
      }
      log(`warning: ${path} had mode ${mode.toString(8)}; tightened to 600 (it may hold secrets)`);
    }
  }
  const keys: string[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) {
      log(`warning: ${path}:${i + 1} ignored: not KEY=value`);
      return;
    }
    const key = m[1]!;
    if (SERVICE_ENV_BLOCKED.includes(key)) {
      log(`warning: ${path}:${i + 1} ignored: ${key} can't be set here (it would move mcp-remote's config dir or socket)`);
      return;
    }
    const value = parseEnvValue(m[2]!, process.env);
    if (value === null) {
      log(`warning: ${path}:${i + 1} ignored: the value of ${key} uses syntax this file doesn't support (see the comments at the top)`);
      return;
    }
    process.env[key] = value;
    keys.push(key);
  });
  return keys;
}
