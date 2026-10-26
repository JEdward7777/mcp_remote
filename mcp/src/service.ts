// `mcp-remote install-service` / `uninstall-service` (D6): run the daemon as a per-user service.
//
// Linux: systemd user unit. Restart=on-failure + RestartPreventExitStatus=3 4 (revoked / token in use
// elsewhere: restarting can't help). KillMode=process so stopping or restarting the daemon does not kill the
// tmux server that holds phone-launched Claude Code sessions; the next daemon re-adopts them.
//
// macOS: launchd agent. launchd has no "don't restart on these exit codes" setting: KeepAlive
// {SuccessfulExit: false} restarts on any non-zero exit (including signals) and not on exit 0. So the agent
// sets MCP_REMOTE_FATAL_EXIT_ZERO=1, which makes the daemon exit 0 instead of 3/4/5 (it logs the real reason
// first). Limit: after a revoke, the agent still starts at the next login (RunAtLoad), logs, and exits 0.
// AbandonProcessGroup keeps launched tmux sessions alive when the daemon stops.
//
// Windows: printed manual steps only (Task Scheduler); remote launch needs tmux, so use WSL for that.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { SERVICE_ENV_TEMPLATE, ensureConfigDir, serviceEnvPath } from "./config";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SYSTEMD_UNIT = "mcp-remote.service";
export const LAUNCHD_LABEL = "com.mcp-remote.daemon";

export interface ServiceSpec {
  node: string;
  cli: string;
  path: string;
  /** Only set when the user runs with a non-default config dir. */
  configDir?: string;
  /** Claude Code's config dir (CLAUDE_CONFIG_DIR) if the user has one: where the shim is registered and the login lives. */
  claudeConfigDir?: string;
  logDir?: string;
}

/**
 * Quote one systemd word: "..." with \ and " escaped and % (specifiers) as %%. ExecStart= also expands
 * $VAR, so there $ becomes $$; Environment= does not expand variables, so $ stays as is (systemd.exec(5)).
 */
export function sdQuote(s: string, kind: "exec" | "env" = "exec"): string {
  if (/[\n\r\0]/.test(s)) throw new Error("newline in unit value");
  let q = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (kind === "exec") q = q.replace(/\$/g, "$$$$");
  return `"${q}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = [`Environment=${sdQuote(`PATH=${spec.path}`, "env")}`];
  if (spec.configDir) env.push(`Environment=${sdQuote(`MCP_REMOTE_CONFIG_DIR=${spec.configDir}`, "env")}`);
  if (spec.claudeConfigDir) env.push(`Environment=${sdQuote(`CLAUDE_CONFIG_DIR=${spec.claudeConfigDir}`, "env")}`);
  return `# Written by \`mcp-remote install-service\`. Remove with \`mcp-remote uninstall-service\`.
[Unit]
Description=mcp-remote daemon (phone <-> Claude Code relay)

[Service]
Type=simple
ExecStart=${sdQuote(spec.node)} ${sdQuote(spec.cli)} daemon
Restart=on-failure
RestartSec=10
# 3 = machine revoked / account no longer allowed, 4 = token in use by another computer, 5 = unusable settings
# (config.json / service.env): restarting can't help.
RestartPreventExitStatus=3 4 5
# Phone-launched Claude Code sessions live in a tmux server this daemon starts. Only stop the daemon itself
# on stop/restart; the next daemon re-adopts the sessions.
KillMode=process
# PATH (and CLAUDE_CONFIG_DIR / MCP_REMOTE_CONFIG_DIR if set) captured at install time so node, claude and tmux
# are found (systemd's default PATH is minimal). Secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN), provider settings and
# proxies go in service.env (mode 0600) in the mcp-remote config dir, which the daemon reads; not in this file.
${env.join("\n")}

[Install]
WantedBy=default.target
`;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(spec: ServiceSpec): string {
  const logDir = spec.logDir ?? join(homedir(), "Library", "Logs");
  const env: [string, string][] = [
    ["PATH", spec.path],
    ["MCP_REMOTE_FATAL_EXIT_ZERO", "1"],
  ];
  if (spec.configDir) env.push(["MCP_REMOTE_CONFIG_DIR", spec.configDir]);
  if (spec.claudeConfigDir) env.push(["CLAUDE_CONFIG_DIR", spec.claudeConfigDir]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`mcp-remote install-service\`. Remove with \`mcp-remote uninstall-service\`. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.node)}</string>
    <string>${xml(spec.cli)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart only after a non-zero exit; the daemon exits 0 when restarting can't help (revoked, duplicate). -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- Keep phone-launched tmux sessions running when the daemon stops. -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "mcp-remote.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "mcp-remote.log"))}</string>
</dict>
</plist>
`;
}

export function windowsSteps(spec: ServiceSpec): string {
  return `Windows has no service installer yet. Create a Task Scheduler task (taskschd.msc):
  - General: "Run only when user is logged on".
  - Trigger: "At log on" (your user).
  - Action: Start a program
      Program:   ${spec.node}
      Arguments: "${spec.cli}" daemon
  - Settings: "If the task fails, restart every 1 minute", up to 3 times; "Stop the task if it runs longer than": off.
  - Set the user environment variable MCP_REMOTE_FATAL_EXIT_ZERO=1 so the daemon exits 0 (not 3/4/5) when it was
    revoked or its token is used elsewhere, which Task Scheduler does not count as a failure to restart.
Remote launch of Claude Code sessions needs tmux, so it is not available on native Windows; run mcp-remote inside
WSL for that.
`;
}

/** The running CLI: node binary + this bundle (dist/cli.js), both absolute and symlink-free. */
export function currentSpec(): ServiceSpec {
  const cli = realpathSync(fileURLToPath(import.meta.url));
  const spec: ServiceSpec = { node: realpathSync(process.execPath), cli, path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  if (process.env.MCP_REMOTE_CONFIG_DIR) spec.configDir = process.env.MCP_REMOTE_CONFIG_DIR;
  if (process.env.CLAUDE_CONFIG_DIR) spec.claudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  return spec;
}

export function systemdUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config"), "systemd", "user", SYSTEMD_UNIT);
}

export function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function runVisible(cmd: string, args: string[]): void {
  process.stderr.write(`$ ${cmd} ${args.join(" ")}\n`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

/** Create an empty, commented service.env (0600) if there is none. Returns its path. */
export function ensureServiceEnv(): string {
  ensureConfigDir();
  const path = serviceEnvPath();
  if (!existsSync(path)) {
    writeFileSync(path, SERVICE_ENV_TEMPLATE, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(path, 0o600);
  }
  return path;
}

export function installService(opts: { dryRun?: boolean; noStart?: boolean; platform?: NodeJS.Platform } = {}): void {
  const platform = opts.platform ?? process.platform;
  const spec = currentSpec();
  const out = process.stderr;
  if (!opts.dryRun && platform !== "win32") {
    out.write(`secrets / provider settings for the service: ${ensureServiceEnv()} (0600; see the comments in it)\n`);
  }
  if (/[\\/]_npx[\\/]/.test(spec.cli)) {
    out.write(`warning: ${spec.cli} looks like a temporary npx copy; install mcp-remote globally first (see SETUP.md).\n`);
  }
  if (platform === "linux") {
    const path = systemdUnitPath();
    const unit = systemdUnit(spec);
    if (opts.dryRun) {
      out.write(`# would write ${path}\n${unit}`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, unit, { mode: 0o644 });
    out.write(`wrote ${path}\n`);
    if (opts.noStart) {
      out.write("start it with: systemctl --user daemon-reload && systemctl --user enable --now mcp-remote\n");
      return;
    }
    runVisible("systemctl", ["--user", "daemon-reload"]);
    runVisible("systemctl", ["--user", "enable", "--now", "mcp-remote"]);
    out.write(
      "Logs: journalctl --user -u mcp-remote -f\n" +
        "To keep it running while you are logged out (always-on desktop): loginctl enable-linger $USER\n",
    );
    return;
  }
  if (platform === "darwin") {
    const path = launchdPlistPath();
    const plist = launchdPlist(spec);
    if (opts.dryRun) {
      out.write(`# would write ${path}\n${plist}`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(join(homedir(), "Library", "Logs"), { recursive: true });
    writeFileSync(path, plist, { mode: 0o644 });
    out.write(`wrote ${path}\n`);
    if (opts.noStart) {
      out.write(`start it with: launchctl bootstrap gui/$(id -u) ${path}\n`);
      return;
    }
    const uid = String(process.getuid?.() ?? "");
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    runVisible("launchctl", ["bootstrap", `gui/${uid}`, path]);
    out.write(`Logs: ~/Library/Logs/mcp-remote.log\n`);
    return;
  }
  if (platform === "win32") {
    out.write(windowsSteps(spec));
    return;
  }
  throw new Error(`no service installer for ${platform}; run \`mcp-remote daemon\` under your own supervisor`);
}

export function uninstallService(opts: { platform?: NodeJS.Platform } = {}): void {
  const platform = opts.platform ?? process.platform;
  const out = process.stderr;
  if (platform === "linux") {
    const path = systemdUnitPath();
    try {
      runVisible("systemctl", ["--user", "disable", "--now", "mcp-remote"]);
    } catch {
      out.write("(systemctl could not disable it; continuing)\n");
    }
    if (existsSync(path)) rmSync(path);
    try {
      runVisible("systemctl", ["--user", "daemon-reload"]);
    } catch {
      /* ignore */
    }
    out.write(`removed ${path}. Phone-launched tmux sessions keep running: list them with \`tmux -L mcp-remote ls\`.\n`);
    return;
  }
  if (platform === "darwin") {
    const path = launchdPlistPath();
    try {
      runVisible("launchctl", ["bootout", `gui/${process.getuid?.() ?? ""}/${LAUNCHD_LABEL}`]);
    } catch {
      out.write("(launchctl could not unload it; continuing)\n");
    }
    if (existsSync(path)) rmSync(path);
    out.write(`removed ${path}\n`);
    return;
  }
  if (platform === "win32") {
    out.write("Delete the Task Scheduler task you created for mcp-remote (taskschd.msc).\n");
    return;
  }
  throw new Error(`no service installer for ${platform}`);
}
