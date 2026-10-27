#!/usr/bin/env node
// Stand-in for the `codex` binary (OpenAI Codex CLI) in the e2e. It mimics what codex-cli 0.164.0 does for
// the commands mcp-remote uses (checked against `--help`, offline runs and codex-rs/exec/src/exec_events.rs):
//   codex --version | login status | mcp list --json | mcp add <name> [--env K=V] -- <cmd...>
//   codex exec [resume] --json [--last] [--skip-git-repo-check] [-c key=value]... -- [<thread id>] -
// exec reads the prompt from stdin, prints JSONL events (thread.started, turn.started, item.*, turn.completed /
// turn.failed, error), and starts the MCP servers defined with -c mcp_servers.<name>.{command,args,env_vars}
// the way Codex does: with only HOME/PATH/USER/... plus the listed env vars. It then acts like a tiny agent
// on the LAST phone message in the prompt:
//   "hang ..."        wait until killed (stop test)
//   "slow ..."        reply after 3 s (queueing test)
//   "final-only ..."  no send_message; only a final agent message (fallback test)
//   "fail ..."        turn.failed, exit 1
//   anything else     send_message "codex: <text of every message in this turn, joined with ' | '>", called once
//                     (no retry, like Codex); if it fails the final answer is "codex (final): <texts>"
// $FAKE_CODEX_HOME holds its state (threads, mcp servers); the file $FAKE_CODEX_HOME/logged-out makes it
// behave as not logged in (`login status` -> "Not logged in", exec -> a 401 like the API). Every start is
// logged as one JSON line to $FAKE_CODEX_LOG.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const home = process.env.FAKE_CODEX_HOME || join(process.env.HOME || "/tmp", ".fake-codex");
mkdirSync(home, { recursive: true });
const loggedOut = existsSync(join(home, "logged-out"));
const log = (event, extra = {}) => {
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ event, argv, cwd: process.cwd(), pid: process.pid, ...extra }) + "\n");
  }
};
const readJson = (f, d) => {
  try {
    return JSON.parse(readFileSync(join(home, f), "utf8"));
  } catch {
    return d;
  }
};
const writeJson = (f, v) => writeFileSync(join(home, f), JSON.stringify(v));
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");

if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.164.0 (fake)\n");
  process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
  if (loggedOut) {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (argv[0] === "mcp" && argv[1] === "list") {
  process.stdout.write(JSON.stringify(readJson("mcp.json", []), null, 2) + "\n");
  process.exit(0);
}
if (argv[0] === "mcp" && argv[1] === "add") {
  const name = argv[2];
  const dd = argv.indexOf("--");
  const env = {};
  for (let i = 3; i < dd; i++) if (argv[i] === "--env") Object.assign(env, Object.fromEntries([argv[++i].split(/=(.*)/s).slice(0, 2)]));
  const [command, ...args] = argv.slice(dd + 1);
  const list = readJson("mcp.json", []).filter((s) => s.name !== name);
  list.push({ name, enabled: true, transport: { type: "stdio", command, args, env: Object.keys(env).length ? env : null } });
  writeJson("mcp.json", list);
  process.stdout.write(`Added global MCP server '${name}'.\n`);
  process.exit(0);
}
if (argv[0] !== "exec") {
  process.stderr.write(`fake codex: unsupported command ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

// --- codex exec ---------------------------------------------------------------------------
const resume = argv[1] === "resume";
const dd = argv.indexOf("--");
const opts = argv.slice(resume ? 2 : 1, dd < 0 ? argv.length : dd);
const positional = dd < 0 ? [] : argv.slice(dd + 1);
const overrides = {};
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === "-c") {
    const kv = opts[++i];
    const eq = kv.indexOf("=");
    const raw = kv.slice(eq + 1);
    let v;
    try {
      v = JSON.parse(raw); // TOML strings/arrays/numbers/booleans as mcp-remote writes them are JSON-compatible
    } catch {
      v = raw;
    }
    overrides[kv.slice(0, eq)] = v;
  }
}
const prompt = readFileSync(0, "utf8");
const threads = readJson("threads.json", {});
log("start", {
  resume,
  overrides,
  prompt_chars: prompt.length,
  has_token_env: !!process.env.MCP_REMOTE_LAUNCH_TOKEN,
  codex_markers: Object.keys(process.env).filter((k) => /^CODEX_(THREAD_ID|SANDBOX)/.test(k)),
});

if (!opts.includes("--skip-git-repo-check") && !opts.includes("--dangerously-bypass-approvals-and-sandbox") && !existsSync(join(process.cwd(), ".git"))) {
  process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\n");
  process.exit(1);
}
let threadId;
if (resume && opts.includes("--last")) {
  threadId = Object.entries(threads).filter(([, t]) => t.cwd === process.cwd()).sort((a, b) => b[1].at - a[1].at)[0]?.[0];
  if (!threadId) {
    process.stderr.write("Error: no recorded session found to resume (fake)\n");
    process.exit(1);
  }
} else if (resume) {
  threadId = positional[0];
  if (!threads[threadId]) {
    process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${threadId} (code -32600)\n`);
    process.exit(1);
  }
} else {
  threadId = randomUUID();
}
threads[threadId] = { cwd: process.cwd(), at: Date.now() };
writeJson("threads.json", threads);
emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (loggedOut) {
  const message = "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header";
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

// The phone messages of this turn, as mcp-remote formats them.
const texts = prompt.split(/^--- message \d+ from the phone, sent [^\n]* ---\n/m).slice(1).map((t) => t.replace(/\n+$/, ""));
const last = texts.at(-1) ?? "";
log("turn", { texts });

const bye = (sig) => {
  log("signal", { sig });
  process.exit(sig === "SIGHUP" ? 129 : 143);
};
process.on("SIGHUP", () => bye("SIGHUP"));
process.on("SIGTERM", () => bye("SIGTERM"));

if (last.startsWith("fail")) {
  emit({ type: "turn.failed", error: { message: "simulated failure" } });
  process.exit(1);
}

// Start our MCP server the way Codex does: minimal env + env_vars + env.
const servers = {};
for (const [k, v] of Object.entries(overrides)) {
  const m = /^mcp_servers\.([A-Za-z0-9_-]+)\.(\w+)$/.exec(k);
  if (m) (servers[m[1]] ??= {})[m[2]] = v;
}
const [name, srv] = Object.entries(servers)[0] ?? [];
let client = null;
if (srv?.command) {
  const env = {};
  for (const k of ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ", ...(srv.env_vars ?? [])]) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  Object.assign(env, srv.env ?? {});
  const transport = new StdioClientTransport({ command: srv.command, args: srv.args ?? [], env, stderr: "ignore" });
  client = new Client({ name: "codex-mcp-client", version: "0.164.0" }, { capabilities: {} });
  await client.connect(transport);
  log("mcp_connected", { server: name, instructions: (client.getInstructions() ?? "").slice(0, 60) });
}

if (last.startsWith("hang")) {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
if (last.startsWith("slow")) await new Promise((r) => setTimeout(r, 3000));

let sent = false;
if (!last.startsWith("final-only") && client) {
  const text = `codex: ${texts.join(" | ")}`;
  const args = { text, urgency: "normal" };
  emit({ type: "item.started", item: { id: "item_1", type: "mcp_tool_call", server: name, tool: "send_message", arguments: args, result: null, error: null, status: "in_progress" } });
  // One call, no retry (like Codex): a failure goes back to the "model" and the turn ends with a final answer.
  const r = await client.callTool({ name: "send_message", arguments: args });
  sent = !r.isError;
  log("send_result", { ok: !r.isError, text: r.content?.[0]?.text });
  emit({
    type: "item.completed",
    item: { id: "item_1", type: "mcp_tool_call", server: name, tool: "send_message", arguments: args, result: r.isError ? null : { content: r.content, structured_content: null }, error: r.isError ? { message: r.content?.[0]?.text } : null, status: r.isError ? "failed" : "completed" },
  });
}
const finalText = last.startsWith("final-only") ? `final answer for: ${last}` : sent ? "Done; I messaged you." : `codex (final): ${texts.join(" | ")}`;
emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: finalText } });
emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } });
await client?.close().catch(() => {});
process.exit(0);
