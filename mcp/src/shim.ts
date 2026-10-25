// Per-Claude-Code-session stdio MCP server (D3). Declares the claude/channel capability so
// phone messages arrive in the session as <channel> events, and exposes send_message (D17, D19).
// stdout is reserved for MCP; everything else goes to stderr.
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  DaemonToShim,
  MAX_TEXT_CHARS,
  type MessageRecord,
  PROTOCOL_VERSION,
  SessionId,
  type ShimToDaemon,
  URGENCIES,
  Urgency,
  backoffDelay,
  MessageText,
} from "@mcp-remote/shared";
import { socketPath } from "./config";
import { LineConn } from "./ipc";
import { log, setLogPrefix } from "./log";

export const SERVER_NAME = "mcp-remote";

export const INSTRUCTIONS = `This Claude Code session is connected to the user's phone through mcp-remote.

Inbound: messages the user types on their phone arrive as <channel source="${SERVER_NAME}" message_id="..." session_id="..." sent_at="..."> events. Treat each one as a direct message from the user (an instruction or a question). The user is away from the terminal and cannot see your terminal output.

Outbound: the only way to reach the user is the send_message tool. Messaging is discrete and intentional: do NOT narrate progress, do NOT send a message for every step, and do not repeat yourself. Only send a message when it matters to the user: you finished what they asked, you have the answer to their question, or you are blocked.

Pick the urgency deliberately:
- silent: FYI only; the user does not need to look now (e.g. a minor note or an intermediate result they may want later).
- normal: you finished something the user asked for, or you are answering their message. This is the default.
- urgent: you are blocked or need a decision from the user right now to make progress. Use it sparingly.

When a phone message asks you something, reply with send_message (normal urgency unless you are blocked). Keep messages short and self-contained; they are read on a phone.`;

const SendArgs = z.object({
  text: MessageText,
  urgency: Urgency.default("normal"),
});

export interface ShimOptions {
  socket?: string;
  sessionId?: string;
  cwd?: string;
}

export async function runShim(opts: ShimOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const project = basename(cwd) || cwd;
  const sid = opts.sessionId ?? process.env.MCP_REMOTE_SESSION_ID ?? randomUUID();
  const parsedSid = SessionId.safeParse(sid);
  if (!parsedSid.success) {
    log(`invalid MCP_REMOTE_SESSION_ID "${sid}": use letters, digits, '_' or '-' (max 64)`);
    process.exit(2);
  }
  const sessionId = parsedSid.data;
  setLogPrefix(`mcp-remote shim ${project}/${sessionId.slice(0, 8)}`);
  const sockPath = opts.socket ?? socketPath();

  const server = new Server(
    { name: SERVER_NAME, version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // --- daemon link -----------------------------------------------------------------------
  let conn: LineConn<DaemonToShim> | null = null;
  let registered = false;
  let hubConnected = false;
  let attempt = 0;
  let reqSeq = 0;
  let stopping = false;
  const waiting = new Map<string, { resolve: (r: { ok: true; id: number } | { ok: false; error: string }) => void; timer: NodeJS.Timeout }>();
  let deliverChain: Promise<void> = Promise.resolve();
  const seen = new Set<number>();
  const seenOrder: number[] = [];

  function failAll(error: string): void {
    for (const [k, w] of waiting) {
      clearTimeout(w.timer);
      waiting.delete(k);
      w.resolve({ ok: false, error });
    }
  }

  async function deliver(messages: MessageRecord[]): Promise<void> {
    const ids: number[] = [];
    for (const m of messages) {
      if (m.direction !== "in" || m.session_id !== sessionId) continue;
      if (seen.has(m.id)) {
        ids.push(m.id); // already emitted; re-ack so the Hub stops resending
        continue;
      }
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: {
            content: m.text,
            meta: {
              message_id: String(m.id),
              session_id: sessionId,
              sent_at: new Date(m.created_at).toISOString(),
            },
          },
        });
      } catch (e) {
        log("failed to emit channel notification:", e);
        break; // leave the rest unacked; the Hub redelivers on reconnect
      }
      seen.add(m.id);
      seenOrder.push(m.id);
      if (seenOrder.length > 5000) seen.delete(seenOrder.shift()!);
      ids.push(m.id);
    }
    if (ids.length && conn) conn.send({ t: "ack", ids } satisfies ShimToDaemon);
  }

  function connectDaemon(): void {
    if (stopping) return;
    const sock = createConnection(sockPath);
    const c: LineConn<DaemonToShim> = new LineConn(
      sock,
      DaemonToShim,
      (f) => {
        switch (f.t) {
          case "registered":
            registered = true;
            hubConnected = f.hub_connected;
            attempt = 0;
            log(`registered with daemon (server ${hubConnected ? "connected" : "not connected"})`);
            return;
          case "hub_status":
            hubConnected = f.connected;
            return;
          case "deliver":
            // Serialize so channel events keep the Hub's order.
            deliverChain = deliverChain.then(() => deliver(f.messages)).catch((e) => log("deliver failed:", e));
            return;
          case "sent": {
            const w = waiting.get(f.req_id);
            if (w) {
              clearTimeout(w.timer);
              waiting.delete(f.req_id);
              w.resolve({ ok: true, id: f.message_id });
            }
            return;
          }
          case "send_error": {
            const w = waiting.get(f.req_id);
            if (w) {
              clearTimeout(w.timer);
              waiting.delete(f.req_id);
              w.resolve({ ok: false, error: f.error });
            }
            return;
          }
          case "error":
            log("daemon error:", f.error);
            return;
        }
      },
      (error) => log("bad frame from daemon:", error),
    );
    sock.once("connect", () => {
      conn = c;
      c.send({
        t: "register",
        v: PROTOCOL_VERSION,
        session: { session_id: sessionId, project: project.slice(0, 128), cwd: cwd.slice(0, 1024) },
      } satisfies ShimToDaemon);
    });
    sock.on("error", () => {
      /* handled on close */
    });
    sock.on("close", () => {
      const wasRegistered = registered;
      if (conn === c) conn = null;
      registered = false;
      hubConnected = false;
      failAll("lost connection to the local mcp-remote daemon");
      if (stopping) return;
      const delay = backoffDelay(attempt++, { baseMs: 500, capMs: 30_000 });
      if (wasRegistered || attempt === 1) {
        log(`daemon not reachable at ${sockPath}; retrying (next in ${Math.round(delay / 100) / 10}s)`);
      }
      setTimeout(connectDaemon, delay);
    });
  }

  function sendToPhone(text: string, urgency: Urgency): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
    if (!conn || !registered) {
      return Promise.resolve({
        ok: false,
        error: "the local mcp-remote daemon is not running or not reachable (start it with `mcp-remote daemon`)",
      });
    }
    if (!hubConnected) {
      return Promise.resolve({ ok: false, error: "the mcp-remote daemon is not connected to the server right now" });
    }
    const reqId = `s${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        resolve({ ok: false, error: "timed out waiting for the daemon" });
      }, 20_000);
      waiting.set(reqId, { resolve, timer });
      conn!.send({ t: "send", req_id: reqId, text, urgency } satisfies ShimToDaemon);
    });
  }

  // --- MCP surface -----------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "send_message",
        description:
          "Send a message to the user's phone. Use only when it matters (finished a task, answering the user, or blocked). " +
          "urgency: silent = FYI, normal = finished/answer (default), urgent = blocked or need a decision now.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Message text, short and self-contained.", maxLength: MAX_TEXT_CHARS },
            urgency: {
              type: "string",
              enum: [...URGENCIES],
              default: "normal",
              description: "silent = FYI; normal = finished something / answer; urgent = blocked or needs a decision now.",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "send_message") {
      return { isError: true, content: [{ type: "text", text: `unknown tool: ${req.params.name}` }] };
    }
    const args = SendArgs.safeParse(req.params.arguments ?? {});
    if (!args.success) {
      return {
        isError: true,
        content: [{ type: "text", text: `invalid arguments: ${args.error.issues.map((i) => i.message).join("; ")}` }],
      };
    }
    const r = await sendToPhone(args.data.text, args.data.urgency);
    if (!r.ok) return { isError: true, content: [{ type: "text", text: `Message NOT sent: ${r.error}` }] };
    return { content: [{ type: "text", text: `Sent to the user's phone (urgency ${args.data.urgency}, id ${r.id}).` }] };
  });

  // Register with the daemon only after Claude Code has initialized us, so no channel
  // notification is emitted before the client is ready to receive it.
  server.oninitialized = () => connectDaemon();

  const transport = new StdioServerTransport();
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    failAll("shutting down");
    conn?.close();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  transport.onclose = shutdown;
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await server.connect(transport);
  log(`ready (session ${sessionId}, project ${project})`);
  // There is no reliable way for the server to tell whether Claude Code registered it as a
  // channel; without the flag, phone messages are dropped silently by Claude Code. Say so loudly.
  log(
    `NOTE: phone messages only reach Claude if this session was started with ` +
      `\`claude --dangerously-load-development-channels server:<name of this server in .mcp.json>\` ` +
      `(e.g. server:${SERVER_NAME}). Without it, messages are handed to Claude Code and silently dropped.`,
  );
}
