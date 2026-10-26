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
  // `tmux kill-session` signals the pane's process (this wrapper), not the whole group. Pass the signal on
  // to our process group (we are its leader: tmux starts the pane with setsid), so claude gets it even when
  // it sits behind a non-exec wrapper (Volta, npm's cli-wrapper, a shell script). We receive our own copy
  // too and ignore it; stay alive until claude has exited so its status is recorded.
  // Keyboard SIGINT/SIGQUIT (Ctrl-C, Ctrl-\ when not in raw mode) already reach the whole foreground group
  // from the terminal: just survive them, don't forward (that would deliver them twice).
  for (const sig of ["SIGINT", "SIGQUIT"] as const) process.on(sig, () => {});
  const echoes: Record<string, number> = {};
  for (const sig of ["SIGHUP", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (echoes[sig]) {
        echoes[sig]--;
        return;
      }
      try {
        if (process.platform === "win32") throw new Error("no process groups");
        // Succeeds only if a group with our pid as id exists, i.e. we lead it.
        echoes[sig] = (echoes[sig] ?? 0) + 1;
        process.kill(-process.pid, sig);
      } catch {
        if (echoes[sig]) echoes[sig]--;
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
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
