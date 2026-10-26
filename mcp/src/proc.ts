// Process introspection for the shim (best effort, no shell): parent pid, command line, ancestor chain.
// Linux reads /proc; macOS and other Unixes use `ps` (argv via execFileSync). Windows: unknown (null).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function parentOf(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // "pid (comm) state ppid ..."; comm may contain spaces and parentheses.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(rest[1]);
      return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

export function cmdlineOf(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

/** [parent, grandparent, ...] of this process, up to `max` entries (stops at pid 1 or when unknown). */
export function ancestors(max = 6): number[] {
  const out: number[] = [];
  let pid: number | null = process.ppid;
  while (pid && pid > 1 && out.length < max) {
    out.push(pid);
    pid = parentOf(pid);
  }
  return out;
}

export const CHANNEL_FLAG = "--dangerously-load-development-channels";

export interface Activation {
  active: boolean;
  reason: string;
}

/**
 * Should this shim announce a session? Claude Code also starts MCP servers for `claude -p`, `claude mcp list`
 * and sessions without the channels flag (verified with 2.1.310: the shim's parent is the `claude` process
 * itself, whose command line carries the flags). Those can't receive phone messages, so the shim stays
 * dormant there instead of adding a random-id session to the phone.
 */
export function activation(env: NodeJS.ProcessEnv, parentCmdline: string | null): Activation {
  if (env.MCP_REMOTE_LAUNCH_TOKEN) return { active: true, reason: "phone-launched session" };
  if (env.MCP_REMOTE_SESSION_ID) return { active: true, reason: "MCP_REMOTE_SESSION_ID is set" };
  if (env.MCP_REMOTE_ACTIVATE === "1") return { active: true, reason: "MCP_REMOTE_ACTIVATE=1" };
  if (parentCmdline === null) return { active: true, reason: "cannot inspect the parent process; registering anyway" };
  if (parentCmdline.split(/\s+/).some((a) => a === CHANNEL_FLAG || a.startsWith(`${CHANNEL_FLAG}=`))) return { active: true, reason: `parent was started with ${CHANNEL_FLAG}` };
  return {
    active: false,
    reason:
      `the parent process (${parentCmdline.slice(0, 120)}) was not started with ${CHANNEL_FLAG}, so phone messages ` +
      "could not reach it (e.g. `claude -p`, `claude mcp list`)",
  };
}
