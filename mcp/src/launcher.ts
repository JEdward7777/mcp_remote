// Phone-launched Claude Code sessions (D6, D18): one tmux session per launch on a dedicated tmux server,
// state persisted in <config dir>/launches.json so a restarted daemon re-adopts what is still running.
//
// Linking: each launch has an id `mr-<12 hex>` that is also the session id (MCP_REMOTE_SESSION_ID) and the
// tmux session name, plus a random MCP_REMOTE_LAUNCH_TOKEN per spawn. The shim Claude Code starts inherits
// both and presents the token when it registers, so only the current spawn's shim is linked to the launch.
//
// Lifecycle signals, all local to this computer (D5's no-polling rule is about Cloudflare):
//   - shim registered (event)           -> running
//   - shim disconnected (event)         -> immediate tmux check
//   - startup: capture-pane every second until the shim registers or startup_timeout_s passes, to spot
//     dialogs (see dialogs.ts)
//   - one `tmux list-panes` every LIVENESS_MS while any launch is active, to notice exits
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  type Agent,
  LaunchRecord,
  MAX_DETAIL_CHARS,
  MAX_LAUNCHES_PER_MACHINE,
  MAX_TEXT_CHARS,
  type LaunchState,
  type MessageRecord,
  type ProjectInfo,
  type SessionAnnounce,
  type Urgency,
  backoffDelay,
} from "@mcp-remote/shared";
import {
  AUTH_RE,
  type CodexExitRecord,
  MAX_TURN_CHARS,
  MAX_TURN_MESSAGES,
  NOT_GIT_RE,
  NO_ROLLOUT_RE,
  UUID_RE,
  codexArgv,
  codexPrompt,
} from "./codex";
import { configDir, ensureConfigDir } from "./config";
import { BACKGROUND_CONVERSATION, DEV_CHANNELS_KEYS, NO_CONVERSATION, attentionText, autoAcceptable, detectDialog, lastLine } from "./dialogs";
import { type LaunchConfig, defaultLaunchConfig, findProject, resolveProjects } from "./launch-config";
import { log } from "./log";
import { type ExitRecord, exitCodeOf } from "./run-claude";
import { type PaneInfo, Tmux, type TmuxDriver, tmuxVersionOk, which } from "./tmux";

/** Auto-restarts allowed within one crash window before giving up. */
export const MAX_AUTO_RESTARTS = 5;
/** A run that lasted this long resets the crash window. */
export const STABLE_RUN_MS = 10 * 60_000;
const ACTIVE: LaunchState[] = ["starting", "running", "needs_attention"];

/** Daemon status messages kept per session until the Hub confirmed them. */
export const MAX_OUTBOX = 3;
const OutboxItem = z.object({ id: z.string().regex(/^[0-9a-f]{12}$/), text: z.string().min(1).max(MAX_TEXT_CHARS), urgency: z.enum(["silent", "normal", "urgent"]) });
export type OutboxItem = z.infer<typeof OutboxItem>;

const Entry = LaunchRecord.extend({
  token: z.string(),
  path: z.string(),
  spawned_at: z.number().int(),
  ever_running: z.boolean(),
  /** When a pending auto-restart is due (persisted so a daemon restart doesn't lose it). */
  restart_at: z.number().int().nullable().default(null),
  /**
   * Claude Code conversation id of this launch (`--session-id` on a fresh start, `--resume` to resume), so
   * resuming never picks another session's conversation in the same folder. null: started with --continue
   * (id unknown) or from before this field existed; resuming then falls back to --continue.
   */
  claude_session: z.string().uuid().nullable().default(null),
  /** pid of the process that started the first shim linked for the current spawn (the session's Claude Code). */
  shim_parent: z.number().int().nullable().default(null),
  /**
   * claude_session is a fork (--continue --fork-session --session-id) that Claude Code may not have saved
   * yet: it only writes a transcript once something is said. Until its transcript is seen, a resume forks
   * the folder's conversation again instead of `--resume`-ing an id that may not exist.
   */
  fork_pending: z.boolean().default(false),
  /** claude_session came from forking the folder's conversation (not from a fresh start). */
  from_fork: z.boolean().default(false),
  // --- Codex launches (agent "codex"): no long-running process; one tmux session per turn ---
  /** Codex conversation (thread id from `thread.started`); the next turn resumes it. null: next turn starts one. */
  codex_thread: z.string().regex(UUID_RE).nullable().default(null),
  /** The next turn resumes the folder's most recent Codex conversation (`exec resume --last`). */
  codex_last: z.boolean().default(false),
  /** When the running turn started; null = no turn running (persisted so a restarted daemon re-adopts it). */
  turn_at: z.number().int().nullable().default(null),
  /**
   * Status messages from the daemon to the phone (fallback final answer, failed-turn notices) not yet confirmed
   * by the Hub: kept across daemon restarts and network blips, sent after the next hello. Bounded: the newest
   * MAX_OUTBOX per session.
   */
  outbox: z.array(OutboxItem).max(MAX_OUTBOX).default([]),
});
type Entry = z.infer<typeof Entry> & {
  linked?: boolean;
  /**
   * Spawned by this daemon and its shim has never linked: the only state in which startup dialogs are
   * looked for, and the only one in which keys are ever sent. Re-adopted sessions are never fresh.
   */
  fresh?: boolean;
  stopping?: boolean;
  busy?: boolean;
  dialogTries?: number;
  lastDialog?: string | null;
  noConversation?: boolean;
  /** First time the pane was seen dead without an exit status. */
  deadSince?: number;
  /** pid of the tmux pane's process for the current spawn (run-claude wrapper, or claude itself). */
  panePid?: number | null;
  /** Screen on which the dev-channels keys were last sent, and when. */
  keysScreen?: string;
  keysAt?: number;
  /** Why the daemon last refused a shim presenting this launch's token. */
  lastRefusal?: string;
  /** Current spawn resumes the folder's last conversation forked under a new id (--continue --fork-session). */
  forking?: boolean;
  /** A shim of the current spawn linked at some point (so it got past startup). Re-adopted: assumed. */
  spawnLinked?: boolean;
  // Codex (in memory only: unacknowledged messages are redelivered by the Hub after a daemon restart)
  /** Phone messages waiting for the next turn. */
  queue?: MessageRecord[];
  /** Message ids already handed to a turn (and acknowledged); a redelivery is just acknowledged again. */
  handed?: number[];
  /** send_message calls Codex made during the running turn (counted by the daemon). */
  turnSends?: number;
  /** The running turn exceeded codex_turn_timeout_s and was stopped. */
  timedOut?: boolean;
};
const StateFile = z.object({ v: z.literal(1), launches: z.array(Entry).max(MAX_LAUNCHES_PER_MACHINE) });

export type OpResult = { ok: true; launch_id?: string } | { ok: false; error: string };

/** `codex login status`: null = fine (or unknown), else why Codex can't run. Injected by tests. */
export type CodexLoginCheck = (bin: string, cwd: string) => Promise<string | null>;

/** Real check: offline, reads Codex's stored credentials ("Not logged in", exit 1, verified on 0.164.0). */
export const codexLoginStatus: CodexLoginCheck = (bin, cwd) =>
  new Promise((resolve) => {
    // An API key in the environment works without a stored login; don't second-guess it.
    if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) return resolve(null);
    execFile(bin, ["login", "status"], { cwd, timeout: 15_000, env: sanitizedEnv(), windowsHide: true }, (err, stdout, stderr) => {
      const out = `${String(stdout)}\n${String(stderr)}`;
      if (err && /not logged in/i.test(out)) resolve("Codex is not logged in on this computer: run `codex login` at the desk");
      else resolve(null);
    });
  });

export interface LauncherOptions {
  loadConfig: () => LaunchConfig;
  /** Called after every change with the full public list. */
  onChange: (launches: LaunchRecord[]) => void;
  statePath?: string;
  /** Inject a driver (tests); otherwise built from the config. */
  tmux?: TmuxDriver;
  /** Environment for spawned sessions besides the launch ids (e.g. MCP_REMOTE_CONFIG_DIR). */
  extraEnv?: Record<string, string>;
  tickMs?: number;
  livenessMs?: number;
  restartBaseMs?: number;
  stopWaitMs?: number;
  platform?: NodeJS.Platform;
  /**
   * [node, cli.js]: run Claude Code under `mcp-remote run-claude`, which records its exit status in
   * runDir (tmux sometimes loses it). Unset: run claude directly and rely on tmux's status only.
   */
  wrapper?: string[];
  runDir?: string;
  /** Wait before pressing the dev-channels key again on an unchanged screen (default 3s). */
  keyRetryMs?: number;
  /** Claude Code's config dir (default $CLAUDE_CONFIG_DIR or ~/.claude); tests point it elsewhere. */
  claudeConfigDir?: string;
  /** Codex launches: acknowledge phone messages handed to a turn (the Hub stops redelivering them). */
  onAck?: (sessionId: string, ids: number[]) => void;
  /**
   * Codex launches: send a status message from the daemon to the phone (turn failed, not logged in, the
   * fallback final answer). Return false when it can't be sent now (not connected); call outboxDone once the
   * Hub answered and outboxRetry when the answer was lost, so it is sent again after the next hello.
   */
  onNotify?: (sessionId: string, item: OutboxItem) => boolean;
  codexLoginCheck?: CodexLoginCheck;
}

function newId(): string {
  return "mr-" + randomBytes(6).toString("hex");
}

function newToken(): string {
  return randomBytes(18).toString("base64url");
}

function clip(s: string | null): string | null {
  if (s === null) return null;
  return s.length > MAX_DETAIL_CHARS ? s.slice(0, MAX_DETAIL_CHARS - 1) + "…" : s;
}

/**
 * Markers of the Claude Code process the daemon itself may have been started from (only those): with them a
 * launched `claude` would think it is nested (CLAUDECODE=1 makes it refuse to start), attach to that
 * session's IDE port, or reuse its session ids. Everything else, including CLAUDE_CODE_OAUTH_TOKEN, the
 * Bedrock/Vertex/Foundry provider switches and CLAUDE_CODE_SHELL, is passed through.
 */
export const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_REMOTE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_PROJECT_DIR",
  // Child-session markers (round 7; all present in the 2.1.310 binary).
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "AI_AGENT",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_HOST_WORKTREE",
  "CLAUDE_CODE_HOST_WORKTREE_FENCE",
  // Markers Codex sets for the commands it runs (codex-cli 0.164.0 binary strings), in case the daemon was
  // started from inside a Codex session. Auth (OPENAI_API_KEY, CODEX_API_KEY, CODEX_HOME) is passed through.
  "CODEX_THREAD_ID",
  "CODEX_TOOL_CALL_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_NON_INTERACTIVE",
  "CODEX_STARTING_DIFF",
];

/** Environment for the tmux server (and so for launched sessions). */
export function sanitizedEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (NESTED_SESSION_VARS.includes(k)) continue;
    if (k === "MCP_REMOTE_SESSION_ID" || k === "MCP_REMOTE_LAUNCH_TOKEN" || k === "MCP_REMOTE_PROJECT_ID" || k === "MCP_REMOTE_AGENT") continue;
    if (k === "TMUX" || k === "TMUX_PANE") continue;
    env[k] = v;
  }
  return env;
}

/** tmux's own "Pane is dead (status N, <date>)" line, as a fallback when list-panes had no status yet. */
export function deadStatus(screen: string): number | null {
  const m = /Pane is dead \(status (-?\d+),/.exec(screen);
  return m ? Number(m[1]) : null;
}

export class Launcher {
  private entries: Entry[] = [];
  private tmux: TmuxDriver | null = null;
  private available = false;
  private launchError: string | null = null;
  private cfg: LaunchConfig;
  private projects: ProjectInfo[] = [];
  private startupTimers = new Map<string, NodeJS.Timeout>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private livenessTimer: NodeJS.Timeout | undefined;
  private checking = false;
  /** Outbox items handed to the daemon and not answered yet. */
  private inflight = new Set<string>();
  private disposed = false;
  readonly statePath: string;

  constructor(private readonly o: LauncherOptions) {
    this.statePath = o.statePath ?? join(configDir(), "launches.json");
    this.cfg = defaultLaunchConfig();
  }

  // -------------------------------------------------------------------------
  // Public surface

  info(): { projects: ProjectInfo[]; available: boolean; launch_error: string | null; max_sessions: number; agents: Agent[] } {
    return {
      projects: this.projects,
      available: this.available,
      launch_error: this.launchError,
      max_sessions: this.cfg.max_sessions,
      agents: [...this.cfg.agents],
    };
  }

  records(): LaunchRecord[] {
    return this.entries.map((e) => LaunchRecord.parse(e));
  }

  async init(): Promise<void> {
    await this.reload();
    this.loadState();
    if (this.tmux && this.available) await this.readopt();
    // Re-arm auto-restarts that were pending when the previous daemon stopped.
    for (const e of this.entries) {
      if (e.restart_at !== null && e.state === "exited") this.scheduleRestart(e, Math.max(0, e.restart_at - Date.now()));
      else e.restart_at = null;
    }
    this.ensureLiveness();
    this.changed();
  }

  /** Re-read launch.json (CLI `projects` / `config` commands trigger this). An invalid file disables launching. */
  async reload(): Promise<void> {
    let configError: string | null = null;
    try {
      this.cfg = this.o.loadConfig();
    } catch (e) {
      configError = e instanceof Error ? e.message : String(e);
      log(`launch config: ${configError}`);
    }
    this.projects = resolveProjects(this.cfg).map((p) => ({ id: p.id, name: p.name, agent: this.agentFor(p.agent) }));
    const platform = this.o.platform ?? process.platform;
    if (this.o.tmux) this.tmux = this.o.tmux;
    else if (platform === "win32") this.tmux = null;
    else {
      const bin = this.cfg.tmux_path ?? which("tmux");
      this.tmux = bin ? new Tmux({ bin, socket: this.cfg.tmux_socket, env: sanitizedEnv() }) : null;
    }
    if (configError) {
      this.available = false;
      this.launchError = `launch settings are invalid: ${configError}`;
    } else if (platform === "win32" && !this.o.tmux) {
      this.available = false;
      this.launchError = "remote launch needs tmux, which is not available on Windows (run the daemon inside WSL)";
    } else if (!this.tmux) {
      this.available = false;
      this.launchError = "tmux is not installed on this computer (install tmux 3.2+ or set tmux_path)";
    } else {
      try {
        const v = await this.tmux.version();
        this.available = tmuxVersionOk(v);
        this.launchError = this.available ? null : `${v} is too old; remote launch needs tmux 3.2 or newer`;
      } catch (e) {
        this.available = false;
        this.launchError = `cannot run tmux: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.startupTimers.values()) clearTimeout(t);
    for (const t of this.restartTimers.values()) clearTimeout(t);
    clearInterval(this.livenessTimer);
  }

  async launch(projectId: string, opts: { continue: boolean; auto_restart?: boolean; agent?: Agent }): Promise<OpResult> {
    if (!this.available || !this.tmux) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    await this.reload();
    if (!this.available) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    const project = findProject(this.cfg, projectId);
    if (!project) return { ok: false, error: "unknown project: it is not in this computer's allowlist (mcp-remote projects list)" };
    const agent = opts.agent ?? this.agentFor(project.agent);
    if (!this.cfg.agents.includes(agent)) {
      return {
        ok: false,
        error:
          agent === "codex"
            ? "Codex is not enabled on this computer (at the desk: mcp-remote setup-codex)"
            : "Claude Code is not enabled on this computer (mcp-remote config set agents claude,codex)",
      };
    }
    if (agent === "codex") {
      const conflict = this.codexFolderConflict(project.id, null, opts.continue);
      if (conflict) return { ok: false, error: conflict };
    }
    if (this.activeCount() >= this.cfg.max_sessions) {
      return { ok: false, error: `this computer already runs ${this.activeCount()} launched sessions (max ${this.cfg.max_sessions})` };
    }
    if (this.entries.length >= MAX_LAUNCHES_PER_MACHINE) {
      // Make room by forgetting the oldest ended launch.
      const ended = this.entries.filter((e) => !ACTIVE.includes(e.state) && !this.restartTimers.has(e.launch_id));
      ended.sort((a, b) => a.updated_at - b.updated_at);
      if (!ended[0]) return { ok: false, error: "too many launched sessions" };
      this.entries = this.entries.filter((e) => e !== ended[0]);
    }
    const now = Date.now();
    const id = newId();
    const e: Entry = {
      launch_id: id,
      session_id: id,
      project_id: project.id,
      project: project.name,
      state: "starting",
      exit_code: null,
      detail: null,
      continued: opts.continue,
      // A Codex turn failing is not the session crashing: there is no process to restart between turns.
      auto_restart: agent === "codex" ? false : (opts.auto_restart ?? this.cfg.auto_restart),
      restarts: 0,
      started_at: now,
      updated_at: now,
      agent,
      token: newToken(),
      path: project.path,
      spawned_at: now,
      ever_running: false,
      restart_at: null,
      claude_session: null,
      shim_parent: null,
      fork_pending: false,
      from_fork: false,
      codex_thread: null,
      codex_last: false,
      turn_at: null,
      outbox: [],
    };
    this.entries.push(e);
    e.busy = true;
    try {
      await this.spawn(e);
    } finally {
      e.busy = false;
    }
    return e.state === "failed" ? { ok: false, error: e.detail ?? "failed to start" } : { ok: true, launch_id: id };
  }

  async stop(id: string): Promise<OpResult> {
    const e = this.get(id);
    if (!e) return { ok: false, error: "unknown launch" };
    this.cancelRestart(e);
    if (!ACTIVE.includes(e.state)) {
      if (e.state === "exited" && e.detail?.includes("restarting in")) this.set(e, { detail: "auto-restart cancelled" });
      return { ok: true };
    }
    // A launch / restart / auto-restart still spawning: let it finish, then stop what it started.
    if (!(await this.idle(e))) return { ok: false, error: "this session is busy starting; try again in a moment" };
    if (!ACTIVE.includes(e.state)) return { ok: true };
    e.busy = true;
    try {
      await this.killAndWait(e);
    } finally {
      e.busy = false;
    }
    this.removeExitFile(e);
    if (e.agent === "codex") this.resetCodexTurn(e, true);
    this.set(e, { state: "exited", exit_code: null, detail: "stopped from the phone" });
    return { ok: true };
  }

  async restart(id: string, cont: boolean): Promise<OpResult> {
    const e = this.get(id);
    if (!e) return { ok: false, error: "unknown launch" };
    if (!(await this.idle(e))) return { ok: false, error: "this session is busy starting; try again in a moment" };
    if (!this.available || !this.tmux) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    await this.reload();
    if (!this.available) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    const project = findProject(this.cfg, e.project_id);
    if (!project) return { ok: false, error: "this project is no longer in the computer's allowlist" };
    if (!this.cfg.agents.includes(e.agent)) {
      return { ok: false, error: `${e.agent === "codex" ? "Codex" : "Claude Code"} is no longer enabled on this computer` };
    }
    if (e.agent === "codex") {
      // Resuming without a known thread means `exec resume --last`, the folder's most recent conversation.
      const conflict = this.codexFolderConflict(e.project_id, e, cont && !e.codex_thread);
      if (conflict) return { ok: false, error: conflict };
    }
    if (!ACTIVE.includes(e.state) && this.activeCount() >= this.cfg.max_sessions) {
      return { ok: false, error: `this computer already runs ${this.activeCount()} launched sessions (max ${this.cfg.max_sessions})` };
    }
    // A stop may have claimed it while we reloaded: wait for it, then claim it ourselves (no await between).
    if (!(await this.idle(e))) return { ok: false, error: "this session is busy starting; try again in a moment" };
    if (!ACTIVE.includes(e.state) && this.activeCount() >= this.cfg.max_sessions) {
      return { ok: false, error: `this computer already runs ${this.activeCount()} launched sessions (max ${this.cfg.max_sessions})` };
    }
    this.cancelRestart(e);
    e.busy = true;
    try {
      if (ACTIVE.includes(e.state)) await this.killAndWait(e);
      if (e.agent === "codex") this.resetCodexTurn(e, false);
      e.path = project.path;
      e.project = project.name;
      e.continued = cont;
      e.restarts = 0;
      await this.spawn(e);
    } finally {
      e.busy = false;
    }
    return e.state === "failed" ? { ok: false, error: e.detail ?? "failed to start" } : { ok: true, launch_id: e.launch_id };
  }

  async dismiss(id: string): Promise<OpResult> {
    const e = this.get(id);
    if (!e) return { ok: true };
    if (ACTIVE.includes(e.state) || e.busy) return { ok: false, error: "stop the session before removing it" };
    this.cancelRestart(e);
    this.removeExitFile(e);
    this.entries = this.entries.filter((x) => x !== e);
    this.changed();
    return { ok: true };
  }

  /**
   * A shim registered with the daemon. "linked": it is the current spawn of a launch; "reject": it claims a
   * launch's session id without the current token; "none": not a launched session.
   */
  shimRegister(sessionId: string, token: string | undefined, ancestors?: number[]): "linked" | "turn" | "reject" | "none" {
    const e = this.get(sessionId);
    if (!e) return "none";
    if (!token || token !== e.token) return "reject";
    if (e.agent === "codex") {
      // The shim Codex started for the running turn: it may message the phone; the session itself is
      // announced by the daemon and its inbound messages go to turns, never to the shim.
      if (e.turn_at === null || !ACTIVE.includes(e.state)) return "reject";
      if (!e.shim_parent && ancestors?.[0]) e.shim_parent = ancestors[0];
      e.lastRefusal = undefined;
      e.linked = true;
      return "turn";
    }
    if (!e.shim_parent && ancestors?.[0]) e.shim_parent = ancestors[0];
    e.lastRefusal = undefined;
    e.linked = true;
    e.spawnLinked = true;
    e.fresh = false;
    this.clearStartup(e);
    this.set(e, { state: "running", detail: null, exit_code: null, ever_running: true });
    return "linked";
  }

  shimDown(sessionId: string): void {
    const e = this.get(sessionId);
    if (!e || !e.linked) return;
    e.linked = false;
    // Usually Claude Code exited; look now instead of waiting for the next liveness check.
    setTimeout(() => void this.checkAll(), 300).unref();
  }

  // -------------------------------------------------------------------------
  // Internals

  /** Wait (bounded) until no spawn/stop is in progress for this launch. */
  private async idle(e: Entry, timeoutMs = 20_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (e.busy && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return !e.busy;
  }

  private removeExitFile(e: Entry): void {
    if (!this.o.wrapper) return;
    try {
      rmSync(this.statusFile(e), { force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Is a shim with these ancestor pids the one started by the Claude Code in this launch's tmux pane?
   * - The pane process (run-claude wrapper, or claude itself) must be among its ancestors, at any depth:
   *   claude may sit behind non-exec wrappers (Volta, npm's cli-wrapper, a claude-path script).
   * - Once a shim linked, its parent (the session's Claude Code) is remembered (persisted); a later shim
   *   whose chain contains that pid further up is a `claude` started inside the session (Bash tool, hook)
   *   and is refused, also after a daemon restart when the real shim may reconnect second.
   * null: can't tell (no pid info); callers fall back to the token rules.
   */
  isOwnShim(sessionId: string, ancestors: number[] | undefined): boolean | null {
    const e = this.get(sessionId);
    if (!e || !ancestors?.length) return null;
    if (e.panePid && !ancestors.includes(e.panePid)) return false;
    if (e.shim_parent) {
      if (ancestors[0] === e.shim_parent) return true;
      if (ancestors.includes(e.shim_parent)) return false;
    }
    return e.panePid ? true : null;
  }

  /** The daemon refused a shim holding this launch's token; keep the reason for the phone. */
  noteRefusal(sessionId: string, reason: string): void {
    const e = this.get(sessionId);
    if (!e) return;
    e.lastRefusal = reason;
    if (!e.linked && e.state === "needs_attention") this.set(e, { detail: this.timeoutText(e) });
  }

  private timeoutText(e: Entry): string {
    if (e.lastRefusal) {
      return `Claude Code started a shim for this session but the daemon refused it: ${e.lastRefusal}. Look at it at the desk: ${this.attachHint(e)}`;
    }
    return (
      `Claude Code did not start the mcp-remote shim within ${this.cfg.startup_timeout_s}s. Is it registered ` +
      `(mcp-remote setup-claude) and is Claude Code logged in? Look at it at the desk: ${this.attachHint(e)}`
    );
  }

  private get(id: string): Entry | undefined {
    return this.entries.find((e) => e.launch_id === id);
  }

  private isActive(id: string): boolean {
    const e = this.get(id);
    return !!e && ACTIVE.includes(e.state);
  }

  private activeCount(): number {
    return this.entries.filter((e) => ACTIVE.includes(e.state) || this.restartTimers.has(e.launch_id)).length;
  }

  private set(e: Entry, patch: Partial<Entry>): void {
    Object.assign(e, patch);
    if (patch.detail !== undefined) e.detail = clip(patch.detail);
    e.updated_at = Date.now();
    this.changed();
  }

  /**
   * Like set(), but the Hub and the phones only hear about it when the public record changes: a Codex turn
   * starting or ending normally costs no launches frame (one Hub row write each), only local state.
   */
  private setQuiet(e: Entry, patch: Partial<Entry>): void {
    const before = JSON.stringify({ ...LaunchRecord.parse(e), updated_at: 0 });
    Object.assign(e, patch);
    if (patch.detail !== undefined) e.detail = clip(patch.detail);
    if (JSON.stringify({ ...LaunchRecord.parse(e), updated_at: 0 }) !== before) {
      this.set(e, {});
      return;
    }
    this.saveState();
    this.ensureLiveness();
  }

  private changed(): void {
    this.saveState();
    this.ensureLiveness();
    if (!this.disposed) this.o.onChange(this.records());
  }

  private attachHint(e: Entry): string {
    return `mcp-remote attach ${e.launch_id}`;
  }

  private claudeArgv(e: Entry): string[] | string {
    const bin = this.cfg.claude_path ?? which("claude");
    if (!bin) return "the claude command was not found on the daemon's PATH (set it: mcp-remote config set claude-path /path/to/claude)";
    const argv = [bin, "--dangerously-load-development-channels", `server:${this.cfg.server_name}`];
    if (this.cfg.permission_mode) argv.push("--permission-mode", this.cfg.permission_mode);
    // (claude_session is set by spawn() before this is called; see there.)
    if (e.continued && !e.forking) argv.push("--resume", e.claude_session!);
    else if (e.continued) argv.push("--continue", "--fork-session", "--session-id", e.claude_session!);
    else argv.push("--session-id", e.claude_session!);
    argv.push(...this.cfg.extra_args);
    return argv;
  }

  /**
   * Does Claude Code have a saved transcript for this launch's conversation? Claude Code 2.1.310 stores it
   * as <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<cwd, every non-alphanumeric character as "-">/<id>.jsonl
   * (observed on the installed CLI). Only used to decide whether a pending fork can be resumed; if this
   * guess is ever wrong the launcher forks again, which still reaches the folder's conversation.
   */
  private transcriptExists(e: Entry): boolean {
    if (!e.claude_session) return false;
    const projects = join(this.o.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    const file = `${e.claude_session}.jsonl`;
    if (existsSync(join(projects, e.path.replace(/[^A-Za-z0-9]/g, "-"), file))) return true;
    // Long paths get a shortened slug (truncated + hash); ids are unique, so look in every project folder.
    try {
      return readdirSync(projects).some((d) => existsSync(join(projects, d, file)));
    } catch {
      return false;
    }
  }

  private statusFile(e: Entry): string {
    return join(this.o.runDir ?? join(configDir(), "run"), `${e.launch_id}.exit`);
  }

  /** Exit status recorded by run-claude for the current spawn (and remove the file). */
  private takeExit(e: Entry): number | null {
    if (!this.o.wrapper) return null;
    const f = this.statusFile(e);
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as ExitRecord;
      rmSync(f, { force: true });
      return r.token === e.token ? exitCodeOf(r) : null;
    } catch {
      return null;
    }
  }

  private async spawn(e: Entry): Promise<void> {
    if (e.agent === "codex") return this.startCodex(e);
    const tmux = this.tmux!;
    // Count as active right away, so concurrent launch/restart requests see it against max_sessions.
    e.state = "starting";
    // A fresh start gets its own conversation id; resuming keeps the one it has.
    // Every spawn knows its conversation id, so a later resume reopens exactly this one:
    //  - fresh: a new id (--session-id);
    //  - resume with a known id: --resume <id>;
    //  - resume without one ("resume last conversation", or state from an older version): the folder's
    //    last conversation, forked under a new id we choose (2.1.310 requires --fork-session whenever
    //    --session-id is combined with --continue/--resume).
    if (e.continued && e.claude_session && e.fork_pending) {
      if (this.transcriptExists(e)) e.fork_pending = false; // the fork was saved: resume it exactly
      else e.claude_session = null; // never saved: fork the folder's conversation again
    }
    e.forking = e.continued && !e.claude_session;
    if (!e.continued || e.forking) e.claude_session = randomUUID();
    if (!e.continued) e.fork_pending = e.from_fork = false;
    if (e.forking) e.fork_pending = e.from_fork = true;
    e.shim_parent = null;
    e.lastRefusal = undefined;
    let argv = this.claudeArgv(e);
    if (this.o.wrapper && typeof argv !== "string") {
      const f = this.statusFile(e);
      try {
        mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
        rmSync(f, { force: true });
      } catch (err) {
        log(`cannot prepare ${f}:`, err);
      }
      argv = [...this.o.wrapper, "run-claude", "--status-file", f, "--", ...argv];
    }
    e.token = newToken();
    e.linked = false;
    e.spawnLinked = false;
    e.fresh = true;
    e.restart_at = null;
    e.stopping = false;
    e.dialogTries = 0;
    e.lastDialog = null;
    e.keysScreen = undefined;
    e.keysAt = undefined;
    e.noConversation = false;
    e.spawned_at = Date.now();
    if (typeof argv === "string") {
      this.set(e, { state: "failed", detail: argv, exit_code: null });
      return;
    }
    // A leftover pane with this name (e.g. dead, kept by remain-on-exit) would make new-session fail.
    await tmux.kill(e.launch_id).catch(() => {});
    const env: Record<string, string> = {
      ...(this.o.extraEnv ?? {}),
      MCP_REMOTE_SESSION_ID: e.session_id,
      MCP_REMOTE_LAUNCH_TOKEN: e.token,
      MCP_REMOTE_PROJECT_ID: e.project_id,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    try {
      await tmux.spawn({ name: e.launch_id, cwd: e.path, env, argv });
    } catch (err) {
      const msg = String((err as { stderr?: string }).stderr || (err instanceof Error ? err.message : err)).trim();
      this.set(e, { state: "failed", detail: `tmux could not start the session: ${msg}`, exit_code: null });
      return;
    }
    e.panePid = (await tmux.list().catch(() => [])).find((x) => x.name === e.launch_id)?.pid ?? null;
    log(`launched ${e.project} as ${e.launch_id}${e.continued ? (e.forking ? ` (--continue, forked as ${e.claude_session})` : ` (--resume ${e.claude_session})`) : ""}`);
    this.set(e, { state: "starting", detail: null, exit_code: null });
    this.startStartup(e);
  }

  private startStartup(e: Entry): void {
    this.clearStartup(e);
    if (e.agent === "codex") return; // no interactive startup: nothing is ever read from or typed into it
    const tickMs = this.o.tickMs ?? 1000;
    const tick = async () => {
      this.startupTimers.delete(e.launch_id);
      if (this.disposed || e.linked || !ACTIVE.includes(e.state) || e.stopping) return;
      // Only a fresh spawn is still in front of Claude Code's startup dialogs. A re-adopted session is
      // past them (its shim was running), so its screen is never read or typed into.
      if (e.fresh) await this.startupTick(e);
      if (this.disposed || e.linked || !ACTIVE.includes(e.state) || e.stopping) return;
      if (Date.now() - e.spawned_at > this.cfg.startup_timeout_s * 1000) {
        if (e.state === "starting") {
          this.set(e, {
            state: "needs_attention",
            detail: this.timeoutText(e),
          });
        }
        return; // the shim registering later still flips it to running
      }
      this.startupTimers.set(e.launch_id, setTimeout(() => void tick(), tickMs));
    };
    this.startupTimers.set(e.launch_id, setTimeout(() => void tick(), Math.min(tickMs, 500)));
  }

  private clearStartup(e: Entry): void {
    const t = this.startupTimers.get(e.launch_id);
    if (t) clearTimeout(t);
    this.startupTimers.delete(e.launch_id);
  }

  private async startupTick(e: Entry): Promise<void> {
    const tmux = this.tmux;
    if (!tmux) return;
    let screen: string;
    try {
      const panes = await tmux.list();
      const p = panes.find((x) => x.name === e.launch_id);
      if (!p || p.dead) {
        await this.checkAll();
        return;
      }
      screen = await tmux.capture(e.launch_id);
    } catch (err) {
      log(`tmux check failed for ${e.launch_id}:`, err);
      return;
    }
    const d = detectDialog(screen);
    if (!d) {
      if (e.state === "needs_attention" && e.lastDialog) this.set(e, { state: "starting", detail: null });
      e.lastDialog = null;
      return;
    }
    const key = JSON.stringify(d);
    if (autoAcceptable(d, this.cfg.server_name) && (e.dialogTries ?? 0) < 3) {
      // Claude Code may not have reacted to the last key yet (slow machine): only press again once the
      // screen changed from the one we pressed on, or after 3s, so no stray "1" lands in the REPL.
      if (e.keysScreen === screen && Date.now() - (e.keysAt ?? 0) < (this.o.keyRetryMs ?? 3000)) return;
      e.dialogTries = (e.dialogTries ?? 0) + 1;
      e.lastDialog = key;
      e.keysScreen = screen;
      e.keysAt = Date.now();
      log(`${e.launch_id}: accepting the development-channels warning for server:${this.cfg.server_name}`);
      await tmux.sendKeys(e.launch_id, DEV_CHANNELS_KEYS).catch((err) => log("send-keys failed:", err));
      return;
    }
    const text = attentionText(d, { project: e.project, serverName: this.cfg.server_name, attach: this.attachHint(e) });
    if (e.state !== "needs_attention" || e.detail !== clip(text)) {
      log(`${e.launch_id}: needs attention: ${d.kind}`);
      this.set(e, { state: "needs_attention", detail: text });
    }
    e.lastDialog = key;
  }

  private async killAndWait(e: Entry): Promise<void> {
    e.stopping = true;
    this.clearStartup(e);
    await this.tmux?.kill(e.launch_id).catch((err) => log("tmux kill failed:", err));
    // Let the old shim go away first so the next spawn's shim isn't refused as a duplicate id.
    const end = Date.now() + (this.o.stopWaitMs ?? 5000);
    while (e.linked && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    e.linked = false;
  }

  private cancelRestart(e: Entry): void {
    const t = this.restartTimers.get(e.launch_id);
    if (t) clearTimeout(t);
    this.restartTimers.delete(e.launch_id);
    e.restart_at = null;
  }

  private ensureLiveness(): void {
    // An idle Codex session has no process to watch; only its running turns do.
    const need = !this.disposed && this.entries.some((e) => ACTIVE.includes(e.state) && (e.agent !== "codex" || e.turn_at !== null));
    if (need && !this.livenessTimer) {
      this.livenessTimer = setInterval(() => void this.checkAll(), this.o.livenessMs ?? 15_000);
      this.livenessTimer.unref?.();
    } else if (!need && this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }

  /** One tmux list for all launches; handles any that ended. */
  async checkAll(): Promise<void> {
    if (this.checking || !this.tmux || this.disposed) return;
    this.checking = true;
    try {
      let panes: PaneInfo[];
      try {
        panes = await this.tmux.list();
        // tmux marks a pane dead when its pty closes, slightly before it has reaped the process and
        // recorded the exit status (seen with Claude Code exiting right away). Give it a moment.
        for (let i = 0; i < 5 && panes.some((p) => p.dead && p.status === null && this.isActive(p.name)); i++) {
          await new Promise((r) => setTimeout(r, 100));
          panes = await this.tmux.list();
        }
      } catch (err) {
        log("tmux list failed:", err);
        return;
      }
      for (const e of this.entries) {
        if (!ACTIVE.includes(e.state) || e.busy) continue;
        if (e.agent === "codex") {
          await this.checkTurn(e, panes);
          continue;
        }
        const p = panes.find((x) => x.name === e.launch_id);
        if (p && !p.dead) {
          if (e.state === "running" && !e.linked && !e.detail) {
            this.set(e, { detail: "Claude Code is running but its mcp-remote shim disconnected (check /mcp at the desk, or restart)" });
          }
          continue;
        }
        let screen = "";
        if (p) screen = await this.tmux.capture(e.launch_id, 60).catch(() => "");
        const status = this.takeExit(e) ?? (p ? (p.status ?? deadStatus(screen)) : null);
        if (p && status === null && !this.o.wrapper) {
          // Without the wrapper: give tmux a moment to record the status (it sometimes never does).
          e.deadSince ??= Date.now();
          if (Date.now() - e.deadSince < 3_000) {
            setTimeout(() => void this.checkAll(), 500).unref?.();
            continue;
          }
        }
        e.deadSince = undefined;
        await this.tmux.kill(e.launch_id).catch(() => {});
        this.onExit(e, status, screen, !p);
      }
    } finally {
      this.checking = false;
    }
  }

  private onExit(e: Entry, status: number | null, screen: string, vanished: boolean): void {
    this.clearStartup(e);
    e.linked = false;
    if (e.stopping) {
      this.set(e, { state: "exited", exit_code: null, detail: "stopped from the phone" });
      return;
    }
    let detail: string | null;
    let noRetry = false;
    // Startup failures can only come from a spawn that never got as far as its shim; a session that ran
    // could have printed these words itself (e.g. Claude quoting them).
    const startupExit = !e.spawnLinked;
    if (startupExit && e.continued && NO_CONVERSATION.test(screen)) {
      e.noConversation = true;
      // `--resume` of a forked id that Claude Code doesn't have: forget it, so the next resume forks the
      // folder's conversation again rather than failing the same way. (A fresh start's id is kept: there
      // was nothing to resume, and forking would pick up some other session's conversation.)
      if (!e.forking && e.from_fork) e.claude_session = null;
      detail = !e.forking
        ? "No conversation to resume for this session yet (nothing was said in it); restart without resume"
        : "No earlier conversation in this folder to continue; restart without resume";
    } else if (startupExit && e.continued && BACKGROUND_CONVERSATION.test(screen)) {
      noRetry = true;
      detail = /moved to a background session/.test(screen)
        ? "The folder's most recent conversation moved to a background session registered from another machine or " +
          "container, so it can't be resumed here. At the desk use `claude --resume` (or add --fork-session to branch " +
          "off a copy), or use Restart for a new conversation"
        : "The folder's most recent conversation is running in a Claude Code background session, so it can't be " +
          "resumed here. Attach to it at the desk (`claude agents`), or use Restart for a new conversation";
    } else if (startupExit && /cannot be used with root\/sudo/.test(screen)) {
      detail = "Claude Code refuses bypassPermissions when running as root (mcp-remote config set permission-mode ...)";
    } else if (vanished) {
      detail = "the tmux session disappeared (killed outside mcp-remote?)";
    } else {
      detail = lastLine(screen.split("\n").filter((l) => !/^Pane is dead/.test(l.trim())).join("\n"));
    }
    log(`${e.launch_id} (${e.project}) exited${status !== null ? ` with code ${status}` : ""}`);
    const crashed = !vanished && status !== 0;
    if (e.auto_restart && crashed && !noRetry) {
      if (Date.now() - e.spawned_at > STABLE_RUN_MS) e.restarts = 0;
      if (e.restarts >= MAX_AUTO_RESTARTS) {
        this.set(e, {
          state: "failed",
          exit_code: status,
          detail: `crashed ${MAX_AUTO_RESTARTS + 1} times in a row; auto-restart stopped. Last output: ${detail ?? "(none)"}`,
        });
        return;
      }
      const delay = backoffDelay(e.restarts, { baseMs: this.o.restartBaseMs ?? 10_000, capMs: 300_000, minMs: Math.min(5_000, this.o.restartBaseMs ?? 5_000) });
      e.restarts++;
      // Resume the conversation if there was one; if --continue found none, start fresh.
      e.continued = e.ever_running && !e.noConversation;
      e.state = "exited";
      e.exit_code = status;
      e.detail = clip(`crashed (${detail ?? "no output"}); restarting in ${Math.ceil(delay / 1000)}s (${e.restarts}/${MAX_AUTO_RESTARTS})`);
      this.scheduleRestart(e, delay); // persists restart_at via changed()
      return;
    }
    this.set(e, { state: "exited", exit_code: status, detail });
  }

  private scheduleRestart(e: Entry, delay: number): void {
    this.cancelRestart(e);
    e.restart_at = Date.now() + delay;
    this.restartTimers.set(
      e.launch_id,
      setTimeout(() => void this.autoRestart(e), delay),
    );
    this.set(e, {});
  }

  /** Same checks as a phone restart: current config, launching available, project still allowlisted. */
  private async autoRestart(e: Entry): Promise<void> {
    if (this.disposed || !this.restartTimers.has(e.launch_id)) return;
    await this.reload();
    if (this.disposed || !this.restartTimers.has(e.launch_id)) return; // stopped meanwhile
    this.restartTimers.delete(e.launch_id);
    e.restart_at = null;
    if (!this.available || !this.tmux) {
      this.set(e, { state: "failed", detail: `auto-restart skipped: ${this.launchError ?? "remote launch is not available"}` });
      return;
    }
    const project = findProject(this.cfg, e.project_id);
    if (!project) {
      this.set(e, { state: "failed", detail: "auto-restart skipped: this project is no longer in the computer's allowlist" });
      return;
    }
    if (e.busy) return; // a phone restart/stop took over
    e.path = project.path;
    e.project = project.name;
    e.busy = true;
    try {
      await this.spawn(e);
    } finally {
      e.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Codex launches (Phase 5). The session is the daemon's own (announced to the Hub while the launch is
  // active); each batch of phone messages runs as one `codex exec` turn in the launch's tmux session.

  /** Sessions the daemon announces itself: active Codex launches (they have no long-running shim). */
  agentSessions(): SessionAnnounce[] {
    return this.entries
      .filter((e) => e.agent === "codex" && ACTIVE.includes(e.state))
      .map((e) => ({ session_id: e.session_id, project: e.project.slice(0, 128), cwd: e.path.slice(0, 1024) }));
  }

  isAgentSession(sessionId: string): boolean {
    const e = this.get(sessionId);
    return !!e && e.agent === "codex" && ACTIVE.includes(e.state);
  }

  /** Phone messages for a Codex session: queued, then handed to the next turn (one turn at a time). */
  deliver(sessionId: string, messages: MessageRecord[]): void {
    const e = this.get(sessionId);
    if (!e || e.agent !== "codex" || !ACTIVE.includes(e.state)) return;
    e.queue ??= [];
    e.handed ??= [];
    const again: number[] = [];
    for (const m of messages) {
      if (m.direction !== "in" || m.session_id !== sessionId) continue;
      if (e.handed.includes(m.id)) again.push(m.id); // already in a turn; the ack was lost
      else if (!e.queue.some((q) => q.id === m.id)) e.queue.push(m);
    }
    if (again.length) this.o.onAck?.(sessionId, again);
    e.queue.sort((a, b) => a.id - b.id);
    void this.maybeStartTurn(e);
  }

  /** run-codex says the turn ended (a hint; the status file and its token are checked by checkTurn). */
  turnEnded(sessionId: string, token: string): void {
    const e = this.get(sessionId);
    if (!e || e.agent !== "codex" || token !== e.token) return;
    setTimeout(() => void this.checkAll(), 20).unref?.();
  }

  /** The running turn's shim sent a message to the phone. */
  noteSend(sessionId: string): void {
    const e = this.get(sessionId);
    if (e?.agent === "codex" && e.turn_at !== null) e.turnSends = (e.turnSends ?? 0) + 1;
  }

  private promptFile(e: Entry): string {
    return join(this.o.runDir ?? join(configDir(), "run"), `${e.launch_id}.prompt`);
  }

  /** A (re)started Codex session: no process yet; the first phone message starts the first turn. */
  private async startCodex(e: Entry): Promise<void> {
    e.state = "starting";
    e.fresh = false;
    e.linked = false;
    e.restart_at = null;
    e.stopping = false;
    e.spawned_at = Date.now();
    if (!e.continued) {
      e.codex_thread = null;
      e.codex_last = false;
    } else if (!e.codex_thread) {
      e.codex_last = true; // "resume": the folder's most recent Codex conversation
    }
    const bin = this.codexBin();
    if (!bin) {
      this.set(e, { state: "failed", exit_code: null, detail: "the codex command was not found on the daemon's PATH (mcp-remote config set codex-path /path/to/codex)" });
      return;
    }
    if (!this.o.wrapper) {
      this.set(e, { state: "failed", exit_code: null, detail: "Codex sessions need the daemon's run-codex wrapper" });
      return;
    }
    const login = await (this.o.codexLoginCheck ?? codexLoginStatus)(bin, e.path).catch(() => null);
    log(`started Codex session ${e.launch_id} for ${e.project}${e.codex_thread ? ` (resumes ${e.codex_thread})` : e.codex_last ? " (resumes the folder's last conversation)" : ""}`);
    this.set(e, {
      state: login ? "needs_attention" : "running",
      exit_code: null,
      ever_running: true,
      detail: login ?? (e.continued && !e.codex_thread ? "resumes this folder's most recent Codex conversation with your first message" : null),
    });
    void this.maybeStartTurn(e);
  }

  /** The project's agent, or the only agent enabled here when that one is not (a codex-only computer). */
  private agentFor(projectAgent: Agent): Agent {
    if (this.cfg.agents.includes(projectAgent)) return projectAgent;
    return this.cfg.agents.length === 1 ? this.cfg.agents[0]! : projectAgent;
  }

  /**
   * `exec resume --last` takes the folder's most recent Codex conversation, which is only safe while no other
   * Codex session in that folder can create or use one first: refuse a "resume last" start next to another
   * active Codex session, and any start next to a session still waiting to resume the folder's last one.
   */
  private codexFolderConflict(projectId: string, self: Entry | null, wantsLast: boolean): string | null {
    const others = this.entries.filter((x) => x !== self && x.agent === "codex" && x.project_id === projectId && ACTIVE.includes(x.state));
    if (wantsLast && others.length) {
      return (
        "another Codex session is active in this folder; resuming the folder's last conversation could pick its conversation. " +
        "Start a new conversation, or stop the other session first"
      );
    }
    if (others.some((x) => x.codex_last && !x.codex_thread)) {
      return (
        "another Codex session in this folder is waiting to resume the folder's last conversation (it does with its first " +
        "message); a new conversation here now could be picked instead. Send that session a message first, or stop it"
      );
    }
    return null;
  }

  private codexBin(): string | null {
    return this.cfg.codex_path ?? which("codex");
  }

  /** Forget the running turn (after it was killed) and, when the session ends, the queue. */
  private resetCodexTurn(e: Entry, dropQueue: boolean): void {
    e.turn_at = null;
    e.turnSends = 0;
    e.timedOut = false;
    e.linked = false;
    try {
      rmSync(this.promptFile(e), { force: true });
    } catch {
      /* ignore */
    }
    // Unacknowledged messages stay undelivered in the Hub, which resends them when the session is back.
    if (dropQueue) e.queue = [];
  }

  private async maybeStartTurn(e: Entry): Promise<void> {
    if (this.disposed || e.busy || e.stopping || e.turn_at !== null || !ACTIVE.includes(e.state) || !e.queue?.length) return;
    if (!this.tmux || !this.available) return;
    e.busy = true;
    try {
      await this.startTurn(e);
    } finally {
      e.busy = false;
    }
  }

  /**
   * Tell the phone about a problem with a turn. Every turn is the answer to messages the user sent, so each
   * failed one is reported (a normal message: the user is waiting for a reply), and kept in the detail.
   */
  private codexProblem(e: Entry, text: string, attention: boolean): void {
    this.notify(e, `[mcp-remote] ${text}`, "normal");
    this.set(e, { ...(attention ? { state: "needs_attention" as const } : {}), detail: text });
  }

  /** Queue a status message for the phone (persisted until the Hub confirms it) and try to send it now. */
  private notify(e: Entry, text: string, urgency: Urgency): void {
    const item: OutboxItem = { id: randomBytes(6).toString("hex"), text: text.slice(0, MAX_TEXT_CHARS), urgency };
    const dropped = [...e.outbox, item].slice(0, -MAX_OUTBOX);
    for (const d of dropped) this.inflight.delete(d.id);
    e.outbox = [...e.outbox, item].slice(-MAX_OUTBOX);
    this.saveState();
    this.flushOutbox(e.session_id);
  }

  /** After a settings reload: messages put back because a turn could not start (codex missing, ...) get another try. */
  retryQueued(): void {
    for (const e of this.entries) if (e.agent === "codex" && e.queue?.length) void this.maybeStartTurn(e);
  }

  /** Sessions with status messages waiting (the daemon flushes them after hello). */
  outboxSessions(): string[] {
    return this.entries.filter((e) => e.outbox.length).map((e) => e.session_id);
  }

  /** Hand waiting status messages of a session to the daemon (each once until outboxRetry). */
  flushOutbox(sessionId: string): void {
    const e = this.get(sessionId);
    if (!e || !this.o.onNotify) return;
    for (const item of e.outbox) {
      if (this.inflight.has(item.id)) continue;
      if (!this.o.onNotify(e.session_id, item)) return; // not connected: all of it waits for the next hello
      this.inflight.add(item.id);
    }
  }

  /** The Hub answered (stored it, or refused it for good): forget it. */
  outboxDone(sessionId: string, id: string): void {
    this.inflight.delete(id);
    const e = this.get(sessionId);
    if (!e || !e.outbox.some((x) => x.id === id)) return;
    e.outbox = e.outbox.filter((x) => x.id !== id);
    this.saveState();
  }

  /** The answer was lost (connection dropped, timeout): send it again after the next hello. */
  outboxRetry(id?: string): void {
    if (id) this.inflight.delete(id);
    else this.inflight.clear();
  }

  private async startTurn(e: Entry): Promise<void> {
    const tmux = this.tmux!;
    const queue = e.queue ?? [];
    const batch: MessageRecord[] = [];
    let chars = 0;
    while (queue.length && batch.length < MAX_TURN_MESSAGES) {
      const m = queue[0]!;
      if (batch.length && chars + m.text.length > MAX_TURN_CHARS) break;
      batch.push(queue.shift()!);
      chars += Math.min(m.text.length, MAX_TEXT_CHARS);
    }
    const putBack = () => {
      e.queue = [...batch, ...(e.queue ?? [])];
    };
    const bin = this.codexBin();
    if (!bin || !this.o.wrapper) {
      putBack();
      this.codexProblem(e, "the codex command was not found on the daemon's PATH (mcp-remote config set codex-path /path/to/codex); your message is kept for the next try", true);
      return;
    }
    const resume = e.codex_thread ?? (e.codex_last ? "last" : null);
    let codex: string[];
    try {
      codex = codexArgv({
        bin,
        mode: this.cfg.codex_mode,
        extraArgs: this.cfg.codex_extra_args,
        resume,
        skipGitRepoCheck: this.cfg.codex_skip_git_repo_check,
        serverName: this.cfg.server_name,
        shim: this.o.wrapper,
      });
    } catch (err) {
      putBack();
      this.codexProblem(e, `cannot start Codex: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    e.token = newToken();
    e.shim_parent = null;
    e.lastRefusal = undefined;
    e.turnSends = 0;
    e.timedOut = false;
    const status = this.statusFile(e);
    const prompt = this.promptFile(e);
    try {
      mkdirSync(join(status, ".."), { recursive: true, mode: 0o700 });
      rmSync(status, { force: true });
      rmSync(prompt, { force: true });
      // The only place message text goes: a 0600 file run-codex reads (and deletes) as Codex's stdin.
      writeFileSync(prompt, codexPrompt(batch, resume === null), { mode: 0o600, flag: "wx" });
    } catch (err) {
      putBack();
      this.codexProblem(e, `cannot write the turn's prompt file: ${err instanceof Error ? err.message : String(err)}`, true);
      return;
    }
    const argv = [...this.o.wrapper, "run-codex", "--status-file", status, "--prompt-file", prompt, "--server-name", this.cfg.server_name, "--", ...codex];
    const env: Record<string, string> = {
      ...(this.o.extraEnv ?? {}),
      MCP_REMOTE_SESSION_ID: e.session_id,
      MCP_REMOTE_LAUNCH_TOKEN: e.token,
      MCP_REMOTE_PROJECT_ID: e.project_id,
      MCP_REMOTE_AGENT: "codex",
      MCP_REMOTE_CONFIG_DIR: configDir(),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    await tmux.kill(e.launch_id).catch(() => {});
    // No stale pid from the previous turn: a shim registering before list() below must not be checked against it.
    e.panePid = null;
    try {
      await tmux.spawn({ name: e.launch_id, cwd: e.path, env, argv });
    } catch (err) {
      rmSync(prompt, { force: true });
      putBack();
      const msg = String((err as { stderr?: string }).stderr || (err instanceof Error ? err.message : err)).trim();
      this.codexProblem(e, `tmux could not start the Codex turn: ${msg}`, true);
      return;
    }
    e.panePid = (await tmux.list().catch(() => [])).find((x) => x.name === e.launch_id)?.pid ?? null;
    e.handed = [...(e.handed ?? []), ...batch.map((m) => m.id)].slice(-2000);
    this.o.onAck?.(e.session_id, batch.map((m) => m.id));
    log(`${e.launch_id}: Codex turn with ${batch.length} message(s)${resume ? ` (resume ${resume})` : " (new conversation)"}`);
    this.setQuiet(e, { turn_at: Date.now() });
  }

  /** One liveness look at a Codex launch: is its turn over (or over time)? */
  private async checkTurn(e: Entry, panes: PaneInfo[]): Promise<void> {
    if (e.turn_at === null) return;
    const p = panes.find((x) => x.name === e.launch_id);
    const rec = this.peekCodexRecord(e);
    if (!rec && p && !p.dead) {
      if (!e.timedOut && Date.now() - e.turn_at > this.cfg.codex_turn_timeout_s * 1000) {
        e.timedOut = true;
        log(`${e.launch_id}: Codex turn exceeded ${this.cfg.codex_turn_timeout_s}s; stopping it`);
        await this.tmux?.kill(e.launch_id).catch(() => {});
      }
      return;
    }
    const screen = p ? await this.tmux!.capture(e.launch_id, 60).catch(() => "") : "";
    this.removeExitFile(e);
    await this.tmux!.kill(e.launch_id).catch(() => {});
    this.onTurnExit(e, rec, p ? (p.status ?? deadStatus(screen)) : null, screen);
  }

  /** run-codex's record for the current turn (token checked), without removing it. */
  private peekCodexRecord(e: Entry): CodexExitRecord | null {
    try {
      const r = JSON.parse(readFileSync(this.statusFile(e), "utf8")) as CodexExitRecord;
      return r.token === e.token && r.codex ? r : null;
    } catch {
      return null;
    }
  }

  private onTurnExit(e: Entry, rec: CodexExitRecord | null, paneStatus: number | null, screen: string): void {
    const sum = rec?.codex;
    const code = rec ? exitCodeOf(rec) : paneStatus;
    // send_message calls: as the daemon counted them, or as Codex reported them (whichever saw more).
    const sends = Math.max(e.turnSends ?? 0, sum?.sends ?? 0);
    const timedOut = !!e.timedOut;
    e.turn_at = null;
    e.linked = false;
    e.timedOut = false;
    e.turnSends = 0;
    if (sum?.thread_id) {
      e.codex_thread = sum.thread_id;
      e.codex_last = false;
    }
    // Classify from what Codex itself reported (turn errors, its stderr); the pane (which also shows the
    // agent's own words and commands) only when run-codex left no record.
    const tail = rec ? `${sum?.error ?? ""}\n${sum?.stderr_tail ?? ""}` : screen;
    const lastErr = clip(lastLine((sum?.error ?? sum?.stderr_tail ?? screen).split("\n").filter((l) => !/^Pane is dead|^\[mcp-remote\]/.test(l.trim())).join("\n")) ?? null);
    log(`${e.launch_id}: Codex turn ended${code !== null ? ` with code ${code}` : ""}${sum?.completed ? " (completed)" : ""}`);
    if (code === 0 && sum?.completed && !timedOut) {
      if (sends === 0 && sum.final?.trim() && this.cfg.codex_final_message === "fallback") {
        // Codex answered in its final message instead of using send_message: the user would see nothing.
        this.notify(e, sum.final, "normal");
      }
      this.setQuiet(e, { state: "running", exit_code: null, detail: null });
    } else if (timedOut) {
      this.codexProblem(e, `the Codex turn ran longer than ${Math.round(this.cfg.codex_turn_timeout_s / 60)} min and was stopped`, false);
    } else if (sum?.auth || (!sum?.completed && AUTH_RE.test(tail))) {
      this.codexProblem(e, `Codex could not authenticate (${lastErr ?? "not logged in"}). Run \`codex login\` at the desk, then send your message again`, true);
    } else if (NO_ROLLOUT_RE.test(tail)) {
      const was = e.codex_thread;
      e.codex_thread = null;
      e.codex_last = false;
      this.codexProblem(e, `Codex could not find its earlier conversation${was ? ` (${was})` : ""}; send your message again to start a new one`, false);
    } else if (NOT_GIT_RE.test(tail)) {
      this.codexProblem(
        e,
        "Codex refuses to run in a folder that is not a git repository. At the desk: `git init` it, or allow it with `mcp-remote config set codex-skip-git-check on`",
        true,
      );
    } else if (e.codex_last && !sum?.thread_id && /no (?:recorded )?(?:session|thread|conversation)/i.test(tail)) {
      e.codex_last = false;
      this.codexProblem(e, "No earlier Codex conversation in this folder to resume; send your message again to start a new one", false);
    } else {
      e.exit_code = code;
      this.codexProblem(
        e,
        `the Codex turn failed${code !== null ? ` (exit ${code})` : ""}${lastErr ? `: ${lastErr}` : ""}. Your message may not have been handled`,
        false,
      );
    }
    void this.maybeStartTurn(e);
  }

  private async readopt(): Promise<void> {
    const tmux = this.tmux!;
    let panes;
    try {
      panes = await tmux.list();
    } catch (err) {
      log("cannot list tmux sessions to re-adopt:", err);
      return;
    }
    for (const e of this.entries) {
      if (!ACTIVE.includes(e.state)) continue;
      const p = panes.find((x) => x.name === e.launch_id);
      if (e.agent === "codex") {
        // The session itself survives a daemon restart (it is just state); a turn that was running is
        // re-adopted if its tmux session is still there, else its recorded result is processed.
        e.fresh = false;
        log(`re-adopting Codex session ${e.launch_id} (${e.project})${e.turn_at !== null ? " with a running turn" : ""}`);
        if (e.turn_at !== null && p && !p.dead) e.panePid = p.pid;
        else if (e.turn_at !== null) await this.checkTurn(e, panes);
        continue;
      }
      if (!p) {
        this.set(e, { state: "exited", exit_code: this.takeExit(e), detail: "ended while the mcp-remote daemon was not running" });
        continue;
      }
      if (p.dead) {
        e.spawnLinked = e.state === "running"; // as last recorded by the previous daemon
        const screen = await tmux.capture(e.launch_id, 60).catch(() => "");
        await tmux.kill(e.launch_id).catch(() => {});
        this.onExit(e, this.takeExit(e) ?? p.status ?? deadStatus(screen), screen, false);
        continue;
      }
      log(`re-adopting ${e.launch_id} (${e.project})`);
      e.spawned_at = Date.now();
      e.fresh = false;
      e.spawnLinked = true;
      e.panePid = p.pid;
      this.set(e, { state: "starting", detail: "re-adopted after a daemon restart; waiting for its shim to reconnect" });
      this.startStartup(e);
    }
    // Sessions on our tmux server that the state file doesn't know (state file lost): adopt the ones that
    // carry a launch identity for an allowlisted project; leave anything else alone.
    for (const p of panes) {
      if (!/^mr-[0-9a-f]{12}$/.test(p.name) || this.get(p.name) || p.dead) continue;
      const env = await tmux.showEnv(p.name);
      if (env.MCP_REMOTE_AGENT === "codex") {
        // A Codex turn whose session state is gone: its conversation id is unknown, so it can't be resumed.
        log(`leaving orphan Codex turn ${p.name} alone (its session state is lost)`);
        continue;
      }
      const project = env.MCP_REMOTE_PROJECT_ID ? findProject(this.cfg, env.MCP_REMOTE_PROJECT_ID) : undefined;
      if (env.MCP_REMOTE_SESSION_ID !== p.name || !env.MCP_REMOTE_LAUNCH_TOKEN || !project) {
        log(`leaving unknown tmux session ${p.name} alone`);
        continue;
      }
      if (this.entries.length >= MAX_LAUNCHES_PER_MACHINE) break;
      const now = Date.now();
      log(`adopting orphan tmux session ${p.name} (${project.name})`);
      const e: Entry = {
        launch_id: p.name,
        session_id: p.name,
        project_id: project.id,
        project: project.name,
        state: "starting",
        exit_code: null,
        detail: "re-adopted after a daemon restart; waiting for its shim to reconnect",
        continued: false,
        auto_restart: false,
        restarts: 0,
        started_at: now,
        updated_at: now,
        token: env.MCP_REMOTE_LAUNCH_TOKEN,
        path: project.path,
        spawned_at: now,
        ever_running: true,
        restart_at: null,
        claude_session: null,
        shim_parent: null,
        fork_pending: false,
        from_fork: false,
        agent: "claude",
        codex_thread: null,
        codex_last: false,
        turn_at: null,
        outbox: [],
        fresh: false,
        spawnLinked: true,
        panePid: p.pid,
      };
      this.entries.push(e);
      this.startStartup(e);
    }
  }

  private loadState(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const r = StateFile.safeParse(JSON.parse(readFileSync(this.statePath, "utf8")));
      if (r.success) this.entries = r.data.launches;
      else log(`ignoring invalid ${this.statePath}: ${r.error.issues[0]?.message}`);
    } catch (err) {
      log(`ignoring unreadable ${this.statePath}:`, err);
    }
  }

  private saveState(): void {
    try {
      ensureConfigDir();
      const data = {
        v: 1,
        launches: this.entries.map((e) => Entry.parse(e)),
      };
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(tmp, 0o600);
      renameSync(tmp, this.statePath);
    } catch (err) {
      log(`could not save ${this.statePath}:`, err);
    }
  }
}
