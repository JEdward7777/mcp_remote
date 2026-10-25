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

export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700);
    } catch (e) {
      log("warning: could not chmod config dir:", e);
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
