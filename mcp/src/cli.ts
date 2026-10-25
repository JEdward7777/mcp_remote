// mcp-remote CLI: pair | daemon | shim | projects | config | setup-claude | attach | install-service | uninstall-service
import { Daemon } from "./daemon";
import { configPath, loadConfig } from "./config";
import { attach, configCommand, projectsCommand, setupClaude } from "./desk";
import { installService, uninstallService } from "./service";
import { runClaude } from "./run-claude";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log, setLogPrefix } from "./log";
import { pair } from "./pair";
import { runShim } from "./shim";

const USAGE = `usage:
  mcp-remote pair <worker-url> [--name <machine name>]   pair this computer with your account
  mcp-remote daemon                                     run the per-computer daemon
  mcp-remote shim                                       stdio MCP channel server (Claude Code runs this)

  remote launch (start Claude Code sessions from the phone, in tmux):
  mcp-remote projects list                              show launch settings and launchable projects
  mcp-remote projects add <dir> [--name <name>]         allow the phone to start sessions in <dir>
  mcp-remote projects add-root <dir>                    allow every sub-folder of <dir> (one level)
  mcp-remote projects remove <dir|name|id>
  mcp-remote config get | modes                         show launch settings / permission modes
  mcp-remote config set <key> <value> | unset <key>     keys: permission-mode, claude-path, extra-args,
                                                        max-sessions, auto-restart, tmux-path,
                                                        server-name, startup-timeout
  mcp-remote setup-claude [--scope user|local] [--force] [--dry-run]
                                                        register the shim with Claude Code (claude mcp add)
  mcp-remote attach <mr-id>                             open a phone-launched session's terminal
  mcp-remote install-service [--dry-run] [--no-start]   run the daemon as a user service (systemd/launchd)
  mcp-remote uninstall-service

env:
  MCP_REMOTE_CONFIG_DIR   config directory (default ~/.config/mcp-remote)
  MCP_REMOTE_SOCKET       daemon IPC socket path (default <config dir>/daemon.sock)
  MCP_REMOTE_SESSION_ID   fixed session id for this shim (default: random per launch)
  MCP_REMOTE_FATAL_EXIT_ZERO=1  exit 0 instead of 3/4 when restarting can't help (launchd/Task Scheduler)
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "pair": {
      setLogPrefix("mcp-remote pair");
      const url = rest.find((a) => !a.startsWith("--"));
      const ni = rest.indexOf("--name");
      const name = ni >= 0 ? rest[ni + 1] : undefined;
      if (!url) throw new Error("missing <worker-url>\n\n" + USAGE);
      const out = await pair(url, name ? { name } : {});
      process.stderr.write(
        `Paired "${out.machine_name}" to ${out.account}.\nSaved ${out.configPath}\n` +
          `If this computer was paired before, revoke its old entry on the phone (Machines) so its session ids are freed.\n` +
          `Next: run \`mcp-remote daemon\` (restart it if it was already running).\n`,
      );
      return;
    }
    case "daemon": {
      setLogPrefix("mcp-remote daemon");
      const config = loadConfig();
      log(`using ${configPath()} (machine ${config.machine_name ?? config.machine_id})`);
      // Launched sessions run under `mcp-remote run-claude` (this same CLI) so their exit status is recorded.
      const d = new Daemon({ config, launcher: { wrapper: [realpathSync(process.execPath), realpathSync(fileURLToPath(import.meta.url))] } });
      const stop = () => {
        d.stop();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await d.start();
      return;
    }
    case "shim":
      await runShim();
      return;
    case "projects":
      setLogPrefix("mcp-remote");
      await projectsCommand(rest);
      return;
    case "config":
      setLogPrefix("mcp-remote");
      await configCommand(rest);
      return;
    case "setup-claude":
      setupClaude(rest);
      return;
    case "run-claude":
      runClaude(rest);
      return;
    case "attach":
      attach(rest);
      return;
    case "install-service":
      installService({ dryRun: rest.includes("--dry-run"), noStart: rest.includes("--no-start") });
      return;
    case "uninstall-service":
      uninstallService();
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stderr.write(USAGE);
      return;
    default:
      throw new Error(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  log(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
