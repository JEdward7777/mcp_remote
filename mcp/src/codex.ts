// OpenAI Codex as a second agent backend (Phase 5). Codex has no equivalent of Claude Code's channels (an
// MCP server cannot inject input into a running Codex session), so the daemon drives Codex itself: every
// phone message (or batch of messages that queued up during a turn) becomes one non-interactive turn,
//
//   first turn:  codex exec        --json [flags] -- -            (prompt on stdin; prints thread.started)
//   later turns: codex exec resume --json [flags] -- <thread> -   (same conversation)
//
// run in the launch's tmux session under `mcp-remote run-codex` (see runCodex below). The message text only
// ever travels through a 0600 file -> the wrapper's stdin -> Codex's stdin: never argv, never a shell, never
// tmux keys. Codex reaches the phone through the same mcp-remote shim, passed to every turn with `-c`
// overrides (so it does not depend on ~/.codex/config.toml), and Codex forwards only the env vars listed in
// env_vars to it (Codex starts MCP servers with a minimal environment).
//
// Facts used here, all checked against codex-cli 0.164.0 (`--help`, offline runs in an empty CODEX_HOME
// without network, and github.com/openai/codex codex-rs/exec/src/exec_events.rs + rmcp-client/src/utils.rs):
//   - `codex exec` / `codex exec resume` read the prompt from stdin when it is `-`; `--` ends options.
//   - `--json` prints JSONL events: thread.started {thread_id}, turn.started, turn.completed {usage},
//     turn.failed {error:{message}}, item.started/updated/completed {item:{id,type,...}}, error {message}.
//     item types: agent_message {text}, reasoning, command_execution {command, exit_code, status},
//     file_change, mcp_tool_call {server, tool, status, error}, web_search, todo_list, error {message}.
//   - `exec resume` emits thread.started with the resumed id; an unknown id fails at once on stderr with
//     "thread/resume failed: no rollout found for thread id <id>" (exit 1).
//   - exec defaults to approval policy "never" (headless); `exec resume` has no -s/-a flags, so the
//     sandbox is set with `-c sandbox_mode=...` (accepted by both); --dangerously-bypass-approvals-and-sandbox,
//     --json, --skip-git-repo-check, -m are global exec flags.
//   - exec refuses to run outside a git repository unless --skip-git-repo-check:
//     "Not inside a trusted directory and --skip-git-repo-check was not specified." (exit 1).
//   - `codex login status` prints "Not logged in" and exits 1 without credentials. Without credentials
//     `codex exec` does NOT fail fast: it starts the turn and the API refuses it (the exact 401 text is
//     UNVERIFIED here: no credentials or network were used; AUTH_RE is deliberately broad).
//   - `-c mcp_servers.<name>.command/args/env_vars/tool_timeout_sec/startup_timeout_sec=...` defines a
//     stdio MCP server for one run (`codex mcp list --json -c ...` shows it); values are TOML.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { openSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { MAX_TEXT_CHARS, type MessageRecord } from "@mcp-remote/shared";
import { type ExitRecord, exitCodeOf, forwardGroupSignals } from "./run-claude";

/**
 * How launched Codex turns may act (D18: the user's chosen mode). Codex's own sandbox modes, plus `bypass`
 * = --dangerously-bypass-approvals-and-sandbox. Approvals are always "never": nobody can answer a prompt.
 */
export const CODEX_MODES = ["read-only", "workspace-write", "danger-full-access", "bypass"] as const;
export const CodexMode = z.enum(CODEX_MODES);
export type CodexMode = z.infer<typeof CodexMode>;

export const CODEX_MODE_HELP: Record<CodexMode, string> = {
  "read-only": "Codex may read files and run read-only commands; no edits (sandbox_mode=read-only)",
  "workspace-write": "edits and commands inside the project folder, in Codex's sandbox (network off unless your Codex config allows it)",
  "danger-full-access": "no sandbox for commands Codex runs (sandbox_mode=danger-full-access); isolated machines only",
  bypass: "--dangerously-bypass-approvals-and-sandbox: no sandbox and no approvals at all; externally sandboxed machines only",
};

/** What happens to Codex's final answer of a turn in which it never called send_message. */
export const CODEX_FINAL = ["fallback", "never"] as const;
export const CodexFinal = z.enum(CODEX_FINAL);

/**
 * Extra flags users may add to every Codex turn. An allowlist (not a denylist like Claude's extra-args):
 * only flags that both `codex exec` and `codex exec resume` accept (0.164.0 help) and that cannot change
 * what mcp-remote manages (conversation, prompt, output format, sandbox/approvals, the shim, the folder).
 * value: true = takes a value (separate argument or --flag=value).
 */
const CODEX_FLAGS: Record<string, boolean> = {
  "-m": true,
  "--model": true,
  "-c": true,
  "--config": true,
  "--enable": true,
  "--disable": true,
  "--strict-config": false,
  "--ignore-rules": false,
};
/** -c keys mcp-remote sets itself (prefix match on the dotted key). */
export const CODEX_MANAGED_KEYS = ["sandbox_mode", "approval_policy", "approvals_reviewer", "mcp_servers"];

/** Problems with codex extra args, as messages (empty = fine). */
export function codexExtraArgsIssues(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (!(flag in CODEX_FLAGS)) {
      out.push(
        `${JSON.stringify(a)} is not allowed in codex-extra-args (allowed: ${Object.keys(CODEX_FLAGS).join(", ")}); ` +
          "mcp-remote manages the conversation, prompt, sandbox/approvals and the shim itself",
      );
      continue;
    }
    if (!CODEX_FLAGS[flag]) {
      if (eq > 0) out.push(`${flag} takes no value`);
      continue;
    }
    let value: string | undefined;
    if (eq > 0) value = a.slice(eq + 1);
    else {
      value = args[i + 1];
      i++;
    }
    if (value === undefined || value === "") {
      out.push(`${flag} needs a value`);
      continue;
    }
    if (flag === "-c" || flag === "--config") {
      const key = value.split("=")[0]!.trim().replace(/^"|"$/g, "");
      const managed = CODEX_MANAGED_KEYS.find((k) => key === k || key.startsWith(`${k}.`));
      if (managed) out.push(`-c ${managed} is managed by mcp-remote (codex-mode, and the shim it passes to each turn)`);
    }
  }
  return out;
}

/** A TOML basic string (JSON string syntax is valid TOML for these characters). */
export function tomlString(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s) || /[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) {
    throw new Error(`cannot pass ${JSON.stringify(s)} to codex: control characters`);
  }
  return JSON.stringify(s);
}

/** Env vars Codex must forward to the shim (it starts MCP servers with HOME/PATH/USER/... only). */
export const SHIM_ENV_VARS = [
  "MCP_REMOTE_SESSION_ID",
  "MCP_REMOTE_LAUNCH_TOKEN",
  "MCP_REMOTE_SOCKET",
  "MCP_REMOTE_CONFIG_DIR",
  "MCP_REMOTE_AGENT",
];
/** get_location may wait up to 120 s for the phone; Codex's default MCP tool timeout is shorter. */
export const SHIM_TOOL_TIMEOUT_S = 180;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexArgvOptions {
  bin: string;
  mode: CodexMode | null;
  extraArgs: string[];
  /** Resume this thread; "last" = the folder's most recent conversation; null = new conversation. */
  resume: string | "last" | null;
  skipGitRepoCheck: boolean;
  /** Name the shim is registered under, and how to start it ([node, cli.js]). */
  serverName: string;
  shim: string[];
}

/** argv for one Codex turn; the prompt is read from stdin (`-`). Every element is constant or validated. */
export function codexArgv(o: CodexArgvOptions): string[] {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.serverName)) throw new Error("bad server name");
  if (o.resume !== null && o.resume !== "last" && !UUID_RE.test(o.resume)) throw new Error("bad codex thread id");
  const issues = codexExtraArgsIssues(o.extraArgs);
  if (issues.length) throw new Error(issues[0]);
  const [node, ...rest] = o.shim;
  if (!node) throw new Error("no shim command");
  const srv = `mcp_servers.${o.serverName}`;
  const argv = [o.bin, "exec"];
  if (o.resume !== null) argv.push("resume");
  argv.push("--json");
  if (o.resume === "last") argv.push("--last");
  if (o.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  if (o.mode === "bypass") argv.push("--dangerously-bypass-approvals-and-sandbox");
  else {
    argv.push("-c", `approval_policy=${tomlString("never")}`);
    if (o.mode) argv.push("-c", `sandbox_mode=${tomlString(o.mode)}`);
  }
  argv.push(
    "-c",
    `${srv}.command=${tomlString(node)}`,
    "-c",
    `${srv}.args=[${[...rest, "shim"].map(tomlString).join(", ")}]`,
    "-c",
    `${srv}.env_vars=[${SHIM_ENV_VARS.map(tomlString).join(", ")}]`,
    "-c",
    `${srv}.enabled=true`,
    "-c",
    `${srv}.startup_timeout_sec=30`,
    "-c",
    `${srv}.tool_timeout_sec=${SHIM_TOOL_TIMEOUT_S}`,
    // exec mode cancels MCP tool calls that would need interactive approval ("MCP tool call cancelled:
    // interactive approval is unavailable in exec mode", 0.164.0 binary); our three tools are pre-approved.
    // Values auto|prompt|writes|approve (0.164.0 rejects anything else when parsing -c).
    "-c",
    `${srv}.default_tools_approval_mode=${tomlString("approve")}`,
  );
  argv.push(...o.extraArgs);
  // `--` ends the options: nothing after it is read as a flag (the thread id is a validated UUID anyway).
  argv.push("--");
  if (o.resume !== null && o.resume !== "last") argv.push(o.resume);
  argv.push("-");
  return argv;
}

// ---------------------------------------------------------------------------
// Prompt

/** Messages one turn takes at most (the rest wait for the next turn). */
export const MAX_TURN_MESSAGES = 20;
export const MAX_TURN_CHARS = 40_000;

export const CODEX_INSTRUCTIONS = `You are connected to the user's phone through mcp-remote. The user is away from the computer: they cannot see this terminal, your commands or your final answer. The ONLY way to reach them is the mcp-remote send_message tool.

Each run of yours is one turn started by messages the user typed on their phone (quoted below). Do what they ask, then reply with send_message. Messaging is discrete and intentional: do not narrate progress or send a message per step; send one when you finished what they asked, have the answer to their question, or are blocked and need them.

send_message urgency decides how the phone notifies them:
- silent: FYI only, no notification.
- normal: you finished something they asked for, or you answer their message (the default).
- urgent: you are blocked and need a decision now (high-priority notification; use sparingly).
Keep messages short and self-contained; they are read on a phone.

get_location asks the phone where it is (the user must agree each time); only use it when the answer depends on where they are. map_link builds a Google Maps link; put it in send_message (the phone makes Google Maps links tappable).`;

/** The prompt for one turn: guidance (in full on a new conversation, a reminder otherwise) + the messages. */
export function codexPrompt(messages: Pick<MessageRecord, "id" | "text" | "created_at">[], fresh: boolean): string {
  const head = fresh
    ? `[mcp-remote]\n${CODEX_INSTRUCTIONS}`
    : "[mcp-remote] New message(s) from the user's phone. Remember: they only see what you send with send_message.";
  const body = messages
    .map((m) => `--- message ${m.id} from the phone, sent ${new Date(m.created_at).toISOString()} ---\n${m.text}`)
    .join("\n\n");
  return `${head}\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// JSONL events -> what the daemon needs to know about a turn

/** Matches Codex / OpenAI API authentication failures (wording UNVERIFIED for real 401s; see top). */
export const AUTH_RE =
  /\b401\b|unauthori[sz]ed|not logged in|please (?:log|sign) ?in|codex login|invalid[_ ]api[_ ]key|incorrect api key|missing bearer|authentication (?:failed|required|error)|token (?:has )?expired|refresh token/i;
export const NO_ROLLOUT_RE = /no rollout found for thread id/i;
export const NOT_GIT_RE = /Not inside a trusted directory and --skip-git-repo-check was not specified/;

export interface TurnSummary {
  thread_id: string | null;
  /** turn.started was seen (the prompt reached the model side). */
  started: boolean;
  completed: boolean;
  /** turn.failed message, or the last error event. */
  error: string | null;
  /** Last agent_message text. */
  final: string | null;
  /** Some error looked like an authentication failure. */
  auth: boolean;
  /** mcp tool calls to send_message on our server that completed (as Codex reported them). */
  sends: number;
}

export function newSummary(): TurnSummary {
  return { thread_id: null, started: false, completed: false, error: null, final: null, auth: false, sends: 0 };
}

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Fold one stdout line into the summary; returns a short human line for the tmux pane (or null).
 * Unknown events / non-JSON lines are ignored (forward compatible).
 */
export function foldEvent(sum: TurnSummary, line: string, serverName = "mcp-remote"): string | null {
  let ev: Record<string, unknown>;
  try {
    const v = JSON.parse(line) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    ev = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  switch (ev.type) {
    case "thread.started": {
      const id = str(ev.thread_id);
      if (id && UUID_RE.test(id)) sum.thread_id = id.toLowerCase();
      return `thread ${id ?? "?"}`;
    }
    case "turn.started":
      sum.started = true;
      return "turn started";
    case "turn.completed":
      sum.completed = true;
      return "turn completed";
    case "turn.failed": {
      const msg = str((ev.error as Record<string, unknown> | undefined)?.message) ?? "turn failed";
      sum.error = clipText(msg, 1000);
      if (AUTH_RE.test(msg)) sum.auth = true;
      return `turn failed: ${clipText(msg, 300)}`;
    }
    case "error": {
      const msg = str(ev.message) ?? "error";
      // "Reconnecting... n/5" lines are retries, not the outcome; keep them out of the summary's error.
      if (!/^Reconnecting\.\.\./.test(msg)) sum.error = clipText(msg, 1000);
      if (AUTH_RE.test(msg)) sum.auth = true;
      return `error: ${clipText(msg, 300)}`;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = ev.item as Record<string, unknown> | undefined;
      if (!item || typeof item !== "object") return null;
      const done = ev.type === "item.completed";
      switch (item.type) {
        case "agent_message": {
          const t = str(item.text);
          if (done && t !== null) sum.final = clipText(t, MAX_TEXT_CHARS);
          return done && t ? `codex: ${clipText(t.replace(/\s+/g, " "), 300)}` : null;
        }
        case "command_execution":
          return ev.type === "item.started" ? `$ ${clipText(String(item.command ?? ""), 300)}` : null;
        case "mcp_tool_call": {
          if (done && item.server === serverName && item.tool === "send_message" && item.status === "completed") sum.sends++;
          return done ? `tool ${String(item.server)}.${String(item.tool)}: ${String(item.status)}` : null;
        }
        case "file_change":
          return done ? `files changed (${Array.isArray(item.changes) ? item.changes.length : "?"})` : null;
        case "error": {
          const msg = str(item.message);
          if (msg && AUTH_RE.test(msg)) sum.auth = true;
          return msg ? `note: ${clipText(msg, 300)}` : null;
        }
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// `mcp-remote run-codex --status-file F --prompt-file P -- codex exec ...` (internal; the daemon uses it)

export interface CodexExitRecord extends ExitRecord {
  codex: TurnSummary & { stderr_tail: string };
}

export function runCodex(args: string[]): void {
  const opt = (k: string) => {
    const i = args.indexOf(k);
    const dd = args.indexOf("--");
    return i >= 0 && (dd < 0 || i < dd) ? args[i + 1] : undefined;
  };
  const statusFile = opt("--status-file");
  const promptFile = opt("--prompt-file");
  const serverName = opt("--server-name") ?? "mcp-remote";
  const dd = args.indexOf("--");
  const cmd = dd >= 0 ? args.slice(dd + 1) : [];
  if (!statusFile || !promptFile || !cmd[0]) {
    throw new Error("usage: mcp-remote run-codex --status-file <file> --prompt-file <file> [--server-name <n>] -- <codex> exec ...");
  }
  const token = process.env.MCP_REMOTE_LAUNCH_TOKEN ?? null;
  const sum = newSummary();
  let stderrTail = "";
  const record = (r: { code: number | null; signal: string | null; error?: string }) => {
    const rec: CodexExitRecord = { token, ...r, codex: { ...sum, stderr_tail: stderrTail.slice(-2000) } };
    try {
      const tmp = `${statusFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
      renameSync(tmp, statusFile);
    } catch {
      /* the daemon falls back to tmux's status */
    }
  };
  /** Tell the daemon to look now (best effort; it also checks on its own). */
  const notify = (done: () => void) => {
    const sock = process.env.MCP_REMOTE_SOCKET;
    const sid = process.env.MCP_REMOTE_SESSION_ID;
    if (!sock || !sid || !token) return done();
    const c = createConnection(sock);
    const t = setTimeout(() => {
      c.destroy();
      done();
    }, 1000);
    c.once("error", () => {
      clearTimeout(t);
      done();
    });
    c.once("connect", () => {
      c.end(JSON.stringify({ t: "turn_end", session_id: sid, launch_token: token }) + "\n", () => {
        clearTimeout(t);
        done();
      });
    });
  };
  let finished = false;
  const finish = (r: { code: number | null; signal: string | null; error?: string }) => {
    if (finished) return;
    finished = true;
    record(r);
    const code = exitCodeOf({ token, ...r }) ?? 1;
    process.stdout.write(`\n[mcp-remote] codex exited${r.signal ? ` (${r.signal})` : ` with ${r.code}`}\n`);
    notify(() => process.exit(code));
  };
  // The prompt file is read once and removed right away: message text never stays on disk.
  let fd: number;
  try {
    fd = openSync(promptFile, "r");
  } catch (e) {
    process.stderr.write(`mcp-remote: cannot read the prompt: ${e instanceof Error ? e.message : String(e)}\n`);
    finish({ code: 126, signal: null, error: "prompt file missing" });
    return;
  }
  rmSync(promptFile, { force: true });
  process.stdout.write(`[mcp-remote] Codex turn (output summarised; full log: none kept)\n`);
  const child = spawn(cmd[0], cmd.slice(1), { stdio: [fd, "pipe", "pipe"] });
  closeSync(fd);
  forwardGroupSignals(child);
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const human = foldEvent(sum, line, serverName);
      if (human) process.stdout.write(human + "\n");
    }
    if (buf.length > 4 * 1024 * 1024) buf = ""; // a runaway line: drop it rather than grow without bound
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-8000);
    process.stderr.write(d);
  });
  child.on("error", (e) => {
    process.stderr.write(`mcp-remote: cannot run ${cmd[0]}: ${e.message}\n`);
    finish({ code: 127, signal: null, error: e.message });
  });
  child.on("close", (code, signal) => {
    if (buf) foldEvent(sum, buf, serverName);
    if (AUTH_RE.test(stderrTail) && !sum.completed) sum.auth = true;
    finish({ code, signal });
  });
}
