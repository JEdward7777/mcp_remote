// mcp-remote CLI: pair | daemon | shim
import { Daemon } from "./daemon";
import { configPath, loadConfig } from "./config";
import { log, setLogPrefix } from "./log";
import { pair } from "./pair";
import { runShim } from "./shim";

const USAGE = `usage:
  mcp-remote pair <worker-url> [--name <machine name>]   pair this computer with your account
  mcp-remote daemon                                     run the per-computer daemon
  mcp-remote shim                                       stdio MCP channel server (Claude Code runs this)

env:
  MCP_REMOTE_CONFIG_DIR   config directory (default ~/.config/mcp-remote)
  MCP_REMOTE_SOCKET       daemon IPC socket path (default <config dir>/daemon.sock)
  MCP_REMOTE_SESSION_ID   fixed session id for this shim (default: random per launch)
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
        `Paired "${out.machine_name}" to ${out.account}.\nSaved ${out.configPath}\nNext: run \`mcp-remote daemon\`.\n`,
      );
      return;
    }
    case "daemon": {
      setLogPrefix("mcp-remote daemon");
      const config = loadConfig();
      log(`using ${configPath()} (machine ${config.machine_name ?? config.machine_id})`);
      const d = new Daemon({ config });
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
