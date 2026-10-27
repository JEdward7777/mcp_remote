// Per-Claude-Code-session stdio MCP server (D3). Declares the claude/channel capability so
// phone messages arrive in the session as <channel> events, and exposes send_message (D17, D19).
// stdout is reserved for MCP; everything else goes to stderr.
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DaemonToShim,
  type LocationResult,
  type LocationVia,
  type MessageRecord,
  PROTOCOL_VERSION,
  SessionId,
  type ShimToDaemon,
  type Urgency,
  backoffDelay,
} from "@mcp-remote/shared";
import { socketPath } from "./config";
import { LineConn } from "./ipc";
import { log, setLogPrefix } from "./log";
import { activation, ancestors, cmdlineOf } from "./proc";
import { GetLocationArgs, INSTRUCTIONS, SERVER_NAME, SendArgs, TOOLS, formatLocation, mapLinkTool } from "./tools";
import { CODEX_INSTRUCTIONS } from "./codex";

export { INSTRUCTIONS, SERVER_NAME } from "./tools";

export interface ShimOptions {
  socket?: string;
  sessionId?: string;
  cwd?: string;
}

export async function runShim(opts: ShimOptions = {}): Promise<void> {
  // Claude Code sets CLAUDE_PROJECT_DIR for MCP servers; it is the project root even if the
  // server was started from a subdirectory.
  const cwd = opts.cwd ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const project = basename(cwd) || cwd;
  const sid = opts.sessionId ?? process.env.MCP_REMOTE_SESSION_ID ?? randomUUID();
  const parsedSid = SessionId.safeParse(sid);
  if (!parsedSid.success) {
    log(`invalid MCP_REMOTE_SESSION_ID "${sid}": use letters, digits, '_' or '-' (max 64)`);
    process.exit(2);
  }
  const sessionId = parsedSid.data;
  // Set by the daemon for phone-launched sessions (it links this shim to the launch).
  const launchToken = process.env.MCP_REMOTE_LAUNCH_TOKEN?.slice(0, 64) || undefined;
  const act = activation(process.env, cmdlineOf(process.ppid));
  // Started by Codex for one phone-driven turn (the daemon sets MCP_REMOTE_AGENT=codex and Codex forwards it):
  // no channel capability (Codex has none; the daemon hands phone messages to Codex as the turn's prompt).
  const codexTurn = process.env.MCP_REMOTE_AGENT === "codex" && !!launchToken;
  setLogPrefix(`mcp-remote shim ${project}/${sessionId.slice(0, 8)}`);
  const sockPath = opts.socket ?? socketPath();

  // Dormant (see proc.ts): advertise nothing, so desk and `claude -p` sessions get no "the user is away,
  // use send_message" instructions and no tool they can't use. An empty tool list is valid MCP.
  const server = new Server(
    { name: SERVER_NAME, version: "0.1.0" },
    act.active
      ? codexTurn
        ? { capabilities: { tools: {} }, instructions: CODEX_INSTRUCTIONS }
        : {
            capabilities: {
              experimental: { "claude/channel": {} },
              tools: {},
            },
            instructions: INSTRUCTIONS,
          }
      : { capabilities: { tools: {} } },
  );

  // --- daemon link -----------------------------------------------------------------------
  let conn: LineConn<DaemonToShim> | null = null;
  let registered = false;
  let hubConnected = false;
  /** Why the daemon is offline, when the server said so (rate limit / daily budget). */
  let hubReason: string | null = null;
  let attempt = 0;
  let refusedAttempt = 0;
  /** Last reason the daemon refused our registration; reported by send_message. */
  let registerRefused: string | null = null;
  let reqSeq = 0;
  let stopping = false;
  type SendResult = { ok: true; id: number; notify?: string } | { ok: false; error: string };
  const waiting = new Map<string, { resolve: (r: SendResult) => void; timer: NodeJS.Timeout }>();
  /** get_location calls waiting for the phone. */
  const locWaiting = new Map<
    string,
    { resolve: (r: LocationResult) => void; timer: NodeJS.Timeout; via: LocationVia | null }
  >();
  let deliverChain: Promise<void> = Promise.resolve();
  const seen = new Set<number>();
  const seenOrder: number[] = [];

  function failAll(error: string): void {
    for (const [k, w] of waiting) {
      clearTimeout(w.timer);
      waiting.delete(k);
      w.resolve({ ok: false, error });
    }
    for (const [k, w] of locWaiting) {
      clearTimeout(w.timer);
      locWaiting.delete(k);
      w.resolve({ status: "unavailable", position: null, fresh: false, message: error });
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
          case "register_refused":
            registerRefused = f.error;
            log(`daemon refused this session: ${f.error}`);
            return;
          case "registered":
            registered = true;
            registerRefused = null;
            refusedAttempt = 0;
            hubConnected = f.hub_connected;
            hubReason = f.reason ?? null;
            attempt = 0;
            log(`registered with daemon (server ${hubConnected ? "connected" : "not connected"})`);
            return;
          case "hub_status":
            hubConnected = f.connected;
            hubReason = f.connected ? null : (f.reason ?? null);
            return;
          case "deliver":
            if (codexTurn) return; // never sent to a turn shim; the daemon owns the session's inbound messages
            // Serialize so channel events keep the Hub's order.
            deliverChain = deliverChain.then(() => deliver(f.messages)).catch((e) => log("deliver failed:", e));
            return;
          case "sent": {
            const w = waiting.get(f.req_id);
            if (w) {
              clearTimeout(w.timer);
              waiting.delete(f.req_id);
              w.resolve({ ok: true, id: f.message_id, ...(f.notify ? { notify: f.notify } : {}) });
            }
            return;
          }
          case "location_wait": {
            const w = locWaiting.get(f.req_id);
            if (w) w.via = f.via;
            return;
          }
          case "location": {
            const w = locWaiting.get(f.req_id);
            if (w) {
              clearTimeout(w.timer);
              locWaiting.delete(f.req_id);
              w.resolve(f.result);
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
    let connected = false;
    sock.once("connect", () => {
      connected = true;
      conn = c;
      c.send({
        t: "register",
        v: PROTOCOL_VERSION,
        session: { session_id: sessionId, project: project.slice(0, 128), cwd: cwd.slice(0, 1024) },
        ...(launchToken ? { launch_token: launchToken, ancestors: ancestors(8) } : {}),
        ...(codexTurn ? { agent: "codex" as const } : {}),
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
      // Could not even connect (daemon gone/restarting): the old refusal no longer applies.
      if (!connected) registerRefused = null;
      if (registerRefused) {
        // A refusal won't fix itself quickly (e.g. the other session must end first): retry slowly.
        const slow = backoffDelay(refusedAttempt++, { baseMs: 30_000, capMs: 600_000, minMs: 15_000 });
        setTimeout(connectDaemon, slow);
        return;
      }
      const delay = backoffDelay(attempt++, { baseMs: 500, capMs: 30_000 });
      if (wasRegistered || attempt === 1) {
        log(`daemon not reachable at ${sockPath}; retrying (next in ${Math.round(delay / 100) / 10}s)`);
      }
      setTimeout(connectDaemon, delay);
    });
  }

  /** Why the phone can't be reached from this shim right now, or null. */
  function unreachable(): string | null {
    if (!act.active) {
      return (
        "mcp-remote is inactive in this Claude Code process: it was not started with " +
        "`--dangerously-load-development-channels server:mcp-remote` (or MCP_REMOTE_SESSION_ID / MCP_REMOTE_ACTIVATE=1), " +
        "so it is not connected to the phone"
      );
    }
    if (!registered && registerRefused) return `the mcp-remote daemon refused this session: ${registerRefused}`;
    if (!conn || !registered) return "the local mcp-remote daemon is not running or not reachable (start it with `mcp-remote daemon`)";
    if (!hubConnected) return `the mcp-remote daemon is not connected to the server right now${hubReason ? `: ${hubReason}` : ""}`;
    return null;
  }

  function sendToPhone(text: string, urgency: Urgency): Promise<SendResult> {
    const why = unreachable();
    if (why) return Promise.resolve({ ok: false, error: why });
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

  /** get_location: resolves with the phone's answer, or a "timeout" result after timeoutS. */
  function askLocation(reason: string, maxAgeS: number, timeoutS: number): Promise<{ result: LocationResult; via: LocationVia | null }> {
    const why = unreachable();
    if (why) return Promise.resolve({ result: { status: "unavailable", position: null, fresh: false, message: why }, via: null });
    const reqId = `g${++reqSeq}`;
    return new Promise((resolve) => {
      const entry = {
        via: null as LocationVia | null,
        timer: setTimeout(() => {
          locWaiting.delete(reqId);
          resolve({ result: { status: "timeout", position: null, fresh: false }, via: entry.via });
        }, timeoutS * 1000),
        resolve: (result: LocationResult) => resolve({ result, via: entry.via }),
      };
      locWaiting.set(reqId, entry);
      conn!.send({ t: "location_req", req_id: reqId, max_age_s: maxAgeS, reason } satisfies ShimToDaemon);
    });
  }

  // --- MCP surface -----------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: act.active ? TOOLS : [] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const err = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
    const name = req.params.name;
    if (name === "map_link") {
      // Pure URL building (no network); works even when the phone is unreachable.
      const r = mapLinkTool(req.params.arguments);
      return r.ok ? { content: [{ type: "text", text: r.text }] } : err(`No link: ${r.error}`);
    }
    if (name === "get_location") {
      const a = GetLocationArgs.safeParse(req.params.arguments ?? {});
      if (!a.success) return err(`invalid arguments: ${a.error.issues.map((i) => i.message).join("; ")}`);
      const { result, via } = await askLocation(a.data.reason, a.data.max_age_s, a.data.timeout_s);
      const text = formatLocation(result, Date.now(), { via, timeoutS: a.data.timeout_s });
      // Transport problems are errors; the user's choices (declined, turned off, no answer) are answers.
      return result.status === "unavailable" && !result.position && via === null ? err(text) : { content: [{ type: "text", text }] };
    }
    if (name !== "send_message") return err(`unknown tool: ${name}`);
    const args = SendArgs.safeParse(req.params.arguments ?? {});
    if (!args.success) return err(`invalid arguments: ${args.error.issues.map((i) => i.message).join("; ")}`);
    const r = await sendToPhone(args.data.text, args.data.urgency);
    if (!r.ok) return err(`Message NOT sent: ${r.error}`);
    return {
      content: [{ type: "text", text: `Sent to the user's phone (urgency ${args.data.urgency}, id ${r.id}${r.notify ? `; ${r.notify}` : ""}).` }],
    };
  });

  // Register with the daemon only after Claude Code has initialized us, so no channel
  // notification is emitted before the client is ready to receive it.
  // Only in a session that can actually receive channel events (see proc.ts); otherwise every `claude -p`,
  // `claude mcp list` or flagless session would show up on the phone as a new session.
  server.oninitialized = () => {
    if (act.active) connectDaemon();
  };

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
  log(
    act.active
      ? `ready (session ${sessionId}, project ${project}; ${act.reason})`
      : `dormant, not announcing a session: ${act.reason}. Set MCP_REMOTE_ACTIVATE=1 to override.`,
  );
  // There is no reliable way for the server to tell whether Claude Code registered it as a
  // channel; without the flag, phone messages are dropped silently by Claude Code. Say so loudly.
  if (act.active && !codexTurn) log(
    `NOTE: phone messages only reach Claude if this session was started with ` +
      `\`claude --dangerously-load-development-channels server:<name of this server in .mcp.json>\` ` +
      `(e.g. server:${SERVER_NAME}). Without it, messages are handed to Claude Code and silently dropped.`,
  );
}
