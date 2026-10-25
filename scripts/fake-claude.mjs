#!/usr/bin/env node
// Stand-in for the `claude` binary in the e2e test. It mimics what the real Claude Code 2.1.310 does at
// startup (as observed in tmux): it shows the development-channels warning and waits for the user to pick
// "1. I am using this for local development", then spawns the configured MCP server (our shim) as an MCP
// client and keeps running. Channel events are handled like a tiny agent:
//   "crash"        -> exit 7 (simulates Claude Code dying)
//   anything else  -> reply "echo: <text>" with send_message
// With --continue it refuses ("No conversation found to continue", exit 1) unless a previous run in this
// folder received a message, like the real CLI. Every start is logged as one JSON line to $FAKE_CLAUDE_LOG.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const cwd = process.cwd();
const historyFile = join(cwd, ".fake-claude-history");
const log = (event, extra = {}) => {
  if (process.env.FAKE_CLAUDE_LOG) {
    appendFileSync(
      process.env.FAKE_CLAUDE_LOG,
      JSON.stringify({ event, argv, cwd, session: process.env.MCP_REMOTE_SESSION_ID, pid: process.pid, ...extra }) + "\n",
    );
  }
};
log("start", { has_token: !!process.env.MCP_REMOTE_LAUNCH_TOKEN, claudecode: process.env.CLAUDECODE ?? null });

if (argv.includes("--continue") && !existsSync(historyFile)) {
  process.stdout.write("No conversation found to continue\n");
  process.exit(1);
}

const devIdx = argv.indexOf("--dangerously-load-development-channels");
const channel = devIdx >= 0 ? argv[devIdx + 1] : null;
const server = channel?.startsWith("server:") ? channel.slice("server:".length) : null;

const line = "─".repeat(80);
async function devChannelsDialog() {
  process.stdout.write(
    `${line}\n  WARNING: Loading development channels\n\n` +
      "  --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.\n" +
      "  Please use --channels to run a list of approved channels.\n\n" +
      `  Channels: ${channel}\n\n` +
      "  ❯ 1. I am using this for local development\n    2. Exit\n\n  Enter to confirm · Esc to cancel\n",
  );
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const key = await new Promise((resolve) => process.stdin.once("data", (d) => resolve(d.toString())));
  process.stdin.setRawMode?.(false);
  if (key !== "1" && key !== "\r") {
    log("dialog_exit", { key });
    process.exit(1);
  }
  log("dialog_accepted", { key });
  process.stdout.write("\x1b[2J\x1b[H");
}

if (server) await devChannelsDialog();
process.stdout.write(` fake Claude Code\n ${cwd}\n Channels (experimental) messages from server:${server} inject directly in this session\n`);

// Our shim, registered the way `mcp-remote setup-claude` would (path handed in by the e2e).
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.FAKE_CLAUDE_SHIM_CLI, "shim"],
  env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  stderr: "ignore",
});
const client = new Client({ name: "fake-claude-code", version: "0.0.0" }, { capabilities: {} });
client.fallbackNotificationHandler = async (n) => {
  if (n.method !== "notifications/claude/channel") return;
  const text = String(n.params?.content ?? "");
  log("channel", { text });
  writeFileSync(historyFile, "1");
  if (text === "crash") {
    process.stdout.write("fatal: simulated crash\n");
    process.exit(7);
  }
  await client.callTool({ name: "send_message", arguments: { text: `echo: ${text}`, urgency: "normal" } });
};
await client.connect(transport);
log("mcp_connected");

const bye = async (sig) => {
  log("signal", { sig });
  await client.close().catch(() => {});
  process.exit(0);
};
process.on("SIGHUP", () => void bye("SIGHUP"));
process.on("SIGTERM", () => void bye("SIGTERM"));
setInterval(() => {}, 1 << 30);
