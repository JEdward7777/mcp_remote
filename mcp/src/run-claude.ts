// `mcp-remote run-claude --status-file <file> -- <claude> <args...>` (internal; the daemon uses it).
// Runs Claude Code in the foreground of the tmux pane and records how it ended, because tmux 3.4 sometimes
// never records a dead pane's exit status (reproduced: the pty closing and the process exiting at the same
// moment leaves #{pane_dead_status} empty for good). argv only, no shell.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { writeFileSync } from "node:fs";

export interface ExitRecord {
  token: string | null;
  code: number | null;
  signal: string | null;
  error?: string;
}

export function exitCodeOf(r: ExitRecord): number | null {
  if (r.code !== null) return r.code;
  const n = r.signal ? (constants.signals as Record<string, number>)[r.signal] : undefined;
  return n ? 128 + n : null;
}

export function runClaude(args: string[]): void {
  const si = args.indexOf("--status-file");
  const dd = args.indexOf("--");
  const file = si >= 0 ? args[si + 1] : undefined;
  const cmd = dd >= 0 ? args.slice(dd + 1) : [];
  if (!file || !cmd[0]) throw new Error("usage: mcp-remote run-claude --status-file <file> -- <command> [args...]");
  const token = process.env.MCP_REMOTE_LAUNCH_TOKEN ?? null;
  const record = (r: Omit<ExitRecord, "token">) => {
    try {
      writeFileSync(file, JSON.stringify({ token, ...r }), { mode: 0o600 });
    } catch {
      /* the daemon falls back to tmux's status */
    }
  };
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
  // `tmux kill-session` signals the pane's process (this wrapper), not the whole group: pass signals on to
  // Claude Code and stay alive until it has exited, so its status is recorded.
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    });
  }
  child.on("error", (e) => {
    record({ code: 127, signal: null, error: e.message });
    process.stderr.write(`mcp-remote: cannot run ${cmd[0]}: ${e.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    const r = { code, signal };
    record(r);
    process.exit(exitCodeOf({ token, ...r }) ?? 1);
  });
}
