// tmux driver for phone-launched sessions (D6). Every call is execFile with an argv array: no shell is
// ever involved, and tmux itself executes a multi-argument command directly (verified on tmux 3.4:
// `new-session -- printf '%s' '$(id)'` prints the literal text).
//
// tmux format-expands some arguments (`#(cmd)` runs cmd through /bin/sh, `#{...}` substitutes). Verified on
// tmux 3.4: `new-session -c <dir>` IS expanded; `-e K=V` values and the command's arguments are NOT. So the
// project folder is never passed as an argument: new-session starts in the tmux client's own working
// directory, which we set with execFile's `cwd` (verified, also when the server is already running). Every
// other argument is either a constant or a validated `mr-<12 hex>` session name.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface TmuxOptions {
  /** tmux binary (absolute path or a name looked up on PATH). */
  bin: string;
  /** Dedicated server socket name (-L). */
  socket: string;
  /** Environment for tmux client calls; the first call starts the server, whose environment panes inherit. */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnSpec {
  name: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

export interface PaneInfo {
  name: string;
  /** pid of the pane's process (the run-claude wrapper, or claude itself); null if unknown. */
  pid: number | null;
  dead: boolean;
  /** Exit status of a dead pane (null if unknown or killed by a signal). */
  status: number | null;
}

/** Minimal interface the launcher needs; tests substitute a fake. */
export interface TmuxDriver {
  version(): Promise<string>;
  spawn(spec: SpawnSpec): Promise<void>;
  /** All sessions on our server; [] if the server isn't running. */
  list(): Promise<PaneInfo[]>;
  /** Visible screen; with `history`, also up to that many lines of scrollback (a dead pane's output lives there). */
  capture(name: string, history?: number): Promise<string>;
  sendKeys(name: string, keys: string[]): Promise<void>;
  kill(name: string): Promise<void>;
  showEnv(name: string): Promise<Record<string, string>>;
}

/** Find an executable on PATH (no shell). Returns an absolute path or null. */
export function which(cmd: string, pathEnv = process.env.PATH ?? ""): string | null {
  if (isAbsolute(cmd)) {
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      return null;
    }
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

const NAME_RE = /^mr-[0-9a-f]{12}$/;
/** Session names are the only variable part of tmux targets; anything else is refused. */
export function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`bad tmux session name ${JSON.stringify(name)}`);
}

/** Base argv: our own socket and no user tmux.conf, so options are predictable. */
export function baseArgs(o: TmuxOptions): string[] {
  return ["-L", o.socket, "-f", "/dev/null"];
}

/**
 * argv for creating a detached session that runs `spec.argv` directly, then keeping the pane after the
 * program exits (remain-on-exit) so the daemon can read its exit status and last output.
 * The `;` element is tmux's own command separator (an argv element, not shell syntax); launch-config
 * rejects extra arguments ending in ';' so user arguments can never be read as one.
 */
export function spawnArgs(o: TmuxOptions, spec: SpawnSpec): string[] {
  assertName(spec.name);
  if (spec.argv.length < 2) throw new Error("command must have at least 2 arguments (tmux runs a single one through a shell)");
  for (const a of spec.argv) if (a.endsWith(";") || a.includes("\0")) throw new Error(`refusing argument ${JSON.stringify(a)}`);
  const env: string[] = [];
  for (const [k, v] of Object.entries(spec.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || v.includes("\0") || v.endsWith(";")) throw new Error(`bad env ${k}`);
    env.push("-e", `${k}=${v}`);
  }
  return [
    ...baseArgs(o),
    "new-session",
    "-d",
    "-s",
    spec.name,
    "-x",
    "200",
    "-y",
    "50",
    // No -c: the folder is the client's cwd (see top of file).
    ...env,
    "--",
    ...spec.argv,
    ";",
    "set-option",
    "-w",
    "-t",
    spec.name,
    "remain-on-exit",
    "on",
  ];
}

/** tmux prints control characters such as tab as "_", so fields are separated by "|" (the last three are numeric). */
export const LIST_FORMAT = "#{session_name}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}";

export function parseList(out: string): PaneInfo[] {
  const res: PaneInfo[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const status = parts.pop();
    const dead = parts.pop();
    const pid = parts.pop();
    const name = parts.join("|");
    if (!name) continue;
    const n = status && /^-?\d+$/.test(status) ? Number(status) : null;
    const pn = pid && /^\d+$/.test(pid) ? Number(pid) : null;
    res.push({ name, pid: pn, dead: dead === "1", status: n });
  }
  return res;
}

function run(
  bin: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        e.stderr = String(stderr);
        reject(e);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** tmux has no server / no such session: treat as "nothing there". */
function isNoServer(e: unknown): boolean {
  const s = String((e as { stderr?: string }).stderr ?? "");
  return /no server running|error connecting to|can't find session|no such file/i.test(s);
}

export class Tmux implements TmuxDriver {
  constructor(private readonly o: TmuxOptions) {}

  private run(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
    return run(this.o.bin, args, this.o.env, cwd);
  }

  async version(): Promise<string> {
    return (await this.run(["-V"])).stdout.trim();
  }

  async spawn(spec: SpawnSpec): Promise<void> {
    // The folder becomes the session's start directory without ever being parsed by tmux.
    await this.run(spawnArgs(this.o, spec), spec.cwd);
  }

  async list(): Promise<PaneInfo[]> {
    try {
      const r = await this.run([...baseArgs(this.o), "list-panes", "-a", "-F", LIST_FORMAT]);
      return parseList(r.stdout);
    } catch (e) {
      if (isNoServer(e)) return [];
      throw e;
    }
  }

  async capture(name: string, history?: number): Promise<string> {
    assertName(name);
    try {
      const h = history ? ["-S", `-${Math.floor(history)}`] : [];
      return (await this.run([...baseArgs(this.o), "capture-pane", "-p", ...h, "-t", `=${name}:`])).stdout;
    } catch (e) {
      if (isNoServer(e)) return "";
      throw e;
    }
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    assertName(name);
    await this.run([...baseArgs(this.o), "send-keys", "-t", `=${name}:`, ...keys]);
  }

  async kill(name: string): Promise<void> {
    assertName(name);
    try {
      await this.run([...baseArgs(this.o), "kill-session", "-t", `=${name}`]);
    } catch (e) {
      if (!isNoServer(e)) throw e;
    }
  }

  async showEnv(name: string): Promise<Record<string, string>> {
    assertName(name);
    const out: Record<string, string> = {};
    try {
      const r = await this.run([...baseArgs(this.o), "show-environment", "-t", `=${name}`]);
      for (const line of r.stdout.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0 && !line.startsWith("-")) out[line.slice(0, i)] = line.slice(i + 1);
      }
    } catch {
      /* gone */
    }
    return out;
  }
}

/** Parse "tmux 3.4" / "tmux 3.3a" / "tmux next-3.5"; true when >= 3.2 (new-session -e). */
export function tmuxVersionOk(v: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 2);
}
