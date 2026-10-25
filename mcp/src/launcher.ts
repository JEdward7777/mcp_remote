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
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  LaunchRecord,
  MAX_DETAIL_CHARS,
  MAX_LAUNCHES_PER_MACHINE,
  type LaunchState,
  type ProjectInfo,
  backoffDelay,
} from "@mcp-remote/shared";
import { configDir, ensureConfigDir } from "./config";
import { DEV_CHANNELS_KEYS, NO_CONVERSATION, attentionText, autoAcceptable, detectDialog, lastLine } from "./dialogs";
import { type LaunchConfig, defaultLaunchConfig, findProject, resolveProjects } from "./launch-config";
import { log } from "./log";
import { Tmux, type TmuxDriver, tmuxVersionOk, which } from "./tmux";

/** Auto-restarts allowed within one crash window before giving up. */
export const MAX_AUTO_RESTARTS = 5;
/** A run that lasted this long resets the crash window. */
export const STABLE_RUN_MS = 10 * 60_000;
const ACTIVE: LaunchState[] = ["starting", "running", "needs_attention"];

const Entry = LaunchRecord.extend({
  token: z.string(),
  path: z.string(),
  spawned_at: z.number().int(),
  ever_running: z.boolean(),
});
type Entry = z.infer<typeof Entry> & {
  linked?: boolean;
  stopping?: boolean;
  busy?: boolean;
  dialogTries?: number;
  lastDialog?: string | null;
  noConversation?: boolean;
};
const StateFile = z.object({ v: z.literal(1), launches: z.array(Entry).max(MAX_LAUNCHES_PER_MACHINE) });

export type OpResult = { ok: true; launch_id?: string } | { ok: false; error: string };

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

/** Environment variables we never hand to a launched Claude Code (would confuse it or the shim). */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PROJECT_DIR") continue;
    if (k === "MCP_REMOTE_SESSION_ID" || k === "MCP_REMOTE_LAUNCH_TOKEN" || k === "MCP_REMOTE_PROJECT_ID") continue;
    if (k === "TMUX" || k === "TMUX_PANE") continue;
    env[k] = v;
  }
  return env;
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
  private disposed = false;
  readonly statePath: string;

  constructor(private readonly o: LauncherOptions) {
    this.statePath = o.statePath ?? join(configDir(), "launches.json");
    this.cfg = defaultLaunchConfig();
  }

  // -------------------------------------------------------------------------
  // Public surface

  info(): { projects: ProjectInfo[]; available: boolean; launch_error: string | null; max_sessions: number } {
    return { projects: this.projects, available: this.available, launch_error: this.launchError, max_sessions: this.cfg.max_sessions };
  }

  records(): LaunchRecord[] {
    return this.entries.map((e) => LaunchRecord.parse(e));
  }

  async init(): Promise<void> {
    await this.reload();
    this.loadState();
    if (this.tmux && this.available) await this.readopt();
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
    this.projects = resolveProjects(this.cfg).map((p) => ({ id: p.id, name: p.name }));
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

  async launch(projectId: string, opts: { continue: boolean; auto_restart?: boolean }): Promise<OpResult> {
    if (!this.available || !this.tmux) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    await this.reload();
    if (!this.available) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    const project = findProject(this.cfg, projectId);
    if (!project) return { ok: false, error: "unknown project: it is not in this computer's allowlist (mcp-remote projects list)" };
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
      auto_restart: opts.auto_restart ?? this.cfg.auto_restart,
      restarts: 0,
      started_at: now,
      updated_at: now,
      token: newToken(),
      path: project.path,
      spawned_at: now,
      ever_running: false,
    };
    this.entries.push(e);
    await this.spawn(e);
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
    if (e.busy) return { ok: false, error: "this session is being restarted; try again in a moment" };
    e.busy = true;
    try {
      await this.killAndWait(e);
    } finally {
      e.busy = false;
    }
    this.set(e, { state: "exited", exit_code: null, detail: "stopped from the phone" });
    return { ok: true };
  }

  async restart(id: string, cont: boolean): Promise<OpResult> {
    const e = this.get(id);
    if (!e) return { ok: false, error: "unknown launch" };
    if (e.busy) return { ok: false, error: "this session is already being restarted" };
    if (!this.available || !this.tmux) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    await this.reload();
    if (!this.available) return { ok: false, error: this.launchError ?? "remote launch is not available" };
    const project = findProject(this.cfg, e.project_id);
    if (!project) return { ok: false, error: "this project is no longer in the computer's allowlist" };
    if (!ACTIVE.includes(e.state) && this.activeCount() >= this.cfg.max_sessions) {
      return { ok: false, error: `this computer already runs ${this.activeCount()} launched sessions (max ${this.cfg.max_sessions})` };
    }
    this.cancelRestart(e);
    e.busy = true;
    try {
      if (ACTIVE.includes(e.state)) await this.killAndWait(e);
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
    if (ACTIVE.includes(e.state)) return { ok: false, error: "stop the session before removing it" };
    this.cancelRestart(e);
    this.entries = this.entries.filter((x) => x !== e);
    this.changed();
    return { ok: true };
  }

  /**
   * A shim registered with the daemon. "linked": it is the current spawn of a launch; "reject": it claims a
   * launch's session id without the current token; "none": not a launched session.
   */
  shimRegister(sessionId: string, token: string | undefined): "linked" | "reject" | "none" {
    const e = this.get(sessionId);
    if (!e) return "none";
    if (!token || token !== e.token) return "reject";
    e.linked = true;
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

  private get(id: string): Entry | undefined {
    return this.entries.find((e) => e.launch_id === id);
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
    if (e.continued) argv.push("--continue");
    argv.push(...this.cfg.extra_args);
    return argv;
  }

  private async spawn(e: Entry): Promise<void> {
    const tmux = this.tmux!;
    const argv = this.claudeArgv(e);
    e.token = newToken();
    e.linked = false;
    e.stopping = false;
    e.dialogTries = 0;
    e.lastDialog = null;
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
    log(`launched ${e.project} as ${e.launch_id}${e.continued ? " (--continue)" : ""}`);
    this.set(e, { state: "starting", detail: null, exit_code: null });
    this.startStartup(e);
  }

  private startStartup(e: Entry): void {
    this.clearStartup(e);
    const tickMs = this.o.tickMs ?? 1000;
    const tick = async () => {
      this.startupTimers.delete(e.launch_id);
      if (this.disposed || e.linked || !ACTIVE.includes(e.state) || e.stopping) return;
      await this.startupTick(e);
      if (this.disposed || e.linked || !ACTIVE.includes(e.state) || e.stopping) return;
      if (Date.now() - e.spawned_at > this.cfg.startup_timeout_s * 1000) {
        if (e.state === "starting") {
          this.set(e, {
            state: "needs_attention",
            detail:
              `Claude Code did not start the mcp-remote shim within ${this.cfg.startup_timeout_s}s. Is it registered ` +
              `(mcp-remote setup-claude) and is Claude Code logged in? Look at it at the desk: ${this.attachHint(e)}`,
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
      e.dialogTries = (e.dialogTries ?? 0) + 1;
      e.lastDialog = key;
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
  }

  private ensureLiveness(): void {
    const need = !this.disposed && this.entries.some((e) => ACTIVE.includes(e.state));
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
      let panes;
      try {
        panes = await this.tmux.list();
      } catch (err) {
        log("tmux list failed:", err);
        return;
      }
      for (const e of this.entries) {
        if (!ACTIVE.includes(e.state) || e.busy) continue;
        const p = panes.find((x) => x.name === e.launch_id);
        if (p && !p.dead) continue;
        let screen = "";
        if (p) screen = await this.tmux.capture(e.launch_id, 60).catch(() => "");
        await this.tmux.kill(e.launch_id).catch(() => {});
        this.onExit(e, p ? p.status : null, screen, !p);
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
    if (NO_CONVERSATION.test(screen)) {
      e.noConversation = true;
      detail = "No earlier conversation in this folder to continue; restart without --continue";
    } else if (/cannot be used with root\/sudo/.test(screen)) {
      detail = "Claude Code refuses bypassPermissions when running as root (mcp-remote config set permission-mode ...)";
    } else if (vanished) {
      detail = "the tmux session disappeared (killed outside mcp-remote?)";
    } else {
      detail = lastLine(screen.split("\n").filter((l) => !/^Pane is dead/.test(l.trim())).join("\n"));
    }
    log(`${e.launch_id} (${e.project}) exited${status !== null ? ` with code ${status}` : ""}`);
    const crashed = !vanished && status !== 0;
    if (e.auto_restart && crashed) {
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
      this.set(e, {
        state: "exited",
        exit_code: status,
        detail: `crashed (${detail ?? "no output"}); restarting in ${Math.ceil(delay / 1000)}s (${e.restarts}/${MAX_AUTO_RESTARTS})`,
      });
      this.restartTimers.set(
        e.launch_id,
        setTimeout(() => {
          this.restartTimers.delete(e.launch_id);
          if (this.disposed) return;
          // Resume the conversation if there was one; if --continue found none, start fresh.
          e.continued = e.ever_running && !e.noConversation;
          void this.spawn(e);
        }, delay),
      );
      return;
    }
    this.set(e, { state: "exited", exit_code: status, detail });
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
      if (!p) {
        this.set(e, { state: "exited", exit_code: null, detail: "ended while the mcp-remote daemon was not running" });
        continue;
      }
      if (p.dead) {
        const screen = await tmux.capture(e.launch_id, 60).catch(() => "");
        await tmux.kill(e.launch_id).catch(() => {});
        this.onExit(e, p.status, screen, false);
        continue;
      }
      log(`re-adopting ${e.launch_id} (${e.project})`);
      e.spawned_at = Date.now();
      this.set(e, { state: "starting", detail: "re-adopted after a daemon restart; waiting for its shim to reconnect" });
      this.startStartup(e);
    }
    // Sessions on our tmux server that the state file doesn't know (state file lost): adopt the ones that
    // carry a launch identity for an allowlisted project; leave anything else alone.
    for (const p of panes) {
      if (!/^mr-[0-9a-f]{12}$/.test(p.name) || this.get(p.name) || p.dead) continue;
      const env = await tmux.showEnv(p.name);
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
