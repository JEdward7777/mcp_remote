// One daemon per computer (D6): a single outbound WebSocket to the tenant's Hub, plus a local
// IPC server that per-session shims connect to. Routes Hub -> shim by session_id.
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import WebSocket from "ws";
import {
  DaemonToHub,
  HubToDaemon,
  PROTOCOL_VERSION,
  ShimToDaemon,
  type DaemonToShim,
  type SessionAnnounce,
  backoffDelay,
  parseFrame,
} from "@mcp-remote/shared";
import { type Config, ensureConfigDir, socketPath, wsUrl } from "./config";
import { LineConn } from "./ipc";
import { log } from "./log";

export const EXIT_REVOKED = 3;
/** Another daemon keeps taking over this machine's connection (same token on two computers). */
export const EXIT_DUPLICATE = 4;
/** After this many consecutive "replaced" closes, give up instead of fighting forever. */
const MAX_REPLACED_STREAK = 3;
const REPLACED_DELAY_MS = 30_000;
/** A connection that lived this long without being replaced resets the streak. */
const STABLE_AFTER_MS = 5 * 60_000;
const PING_EVERY_MS = 30_000;
const DEAD_AFTER_MS = 75_000;
const SEND_TIMEOUT_MS = 15_000;

interface ShimEntry {
  conn: LineConn<ShimToDaemon>;
  session: SessionAnnounce;
  /** Set when the Hub refused this session (e.g. id used by another computer). */
  refused: string | null;
}

interface PendingSend {
  shim: LineConn<ShimToDaemon>;
  shimReqId: string;
  timer: NodeJS.Timeout;
}

export interface DaemonOptions {
  config: Config;
  socket?: string;
  /** Called instead of process.exit when the daemon must stop (revoked, duplicate). */
  onFatal?: (exitCode: number) => void;
  /** Base delay after being replaced by another daemon (tests shorten it). */
  replacedDelayMs?: number;
  /** A connection that lived this long resets the replaced streak (tests shorten it). */
  stableAfterMs?: number;
}

export class Daemon {
  private readonly shims = new Map<string, ShimEntry>();
  private readonly pending = new Map<string, PendingSend>();
  private ws: WebSocket | null = null;
  private hubReady = false;
  private attempt = 0;
  private reqSeq = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private lastRx = 0;
  private replacedStreak = 0;
  private openedAt = 0;
  private server: Server | null = null;
  private stopped = false;
  readonly socket: string;

  constructor(private readonly opts: DaemonOptions) {
    this.socket = opts.socket ?? socketPath();
  }

  async start(): Promise<void> {
    await this.listen();
    this.connectHub();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "daemon stopping");
    for (const s of this.shims.values()) s.conn.close();
    this.server?.close();
    if (process.platform !== "win32" && existsSync(this.socket)) {
      try {
        unlinkSync(this.socket);
      } catch {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Local IPC

  private async listen(): Promise<void> {
    if (process.platform !== "win32") {
      ensureConfigDir();
      if (existsSync(this.socket)) {
        const alive = await new Promise<boolean>((resolve) => {
          const c = createConnection(this.socket);
          c.once("connect", () => {
            c.destroy();
            resolve(true);
          });
          c.once("error", () => resolve(false));
        });
        if (alive) throw new Error(`another daemon is already listening on ${this.socket}`);
        unlinkSync(this.socket);
      }
    }
    const server = createServer((sock) => this.onShim(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Restrictive umask so the socket is never briefly world-accessible.
      const old = process.platform !== "win32" ? process.umask(0o177) : 0;
      server.listen(this.socket, () => {
        if (process.platform !== "win32") {
          process.umask(old);
          chmodSync(this.socket, 0o600);
        }
        resolve();
      });
    });
    log(`listening for shims on ${this.socket}`);
  }

  private onShim(sock: Socket): void {
    let sessionId: string | null = null;
    const conn: LineConn<ShimToDaemon> = new LineConn(
      sock,
      ShimToDaemon,
      (f) => {
        if (f.t === "register") {
          if (sessionId) return conn.send({ t: "error", error: "already registered" } satisfies DaemonToShim);
          const existing = this.shims.get(f.session.session_id);
          if (existing) {
            conn.send({ t: "error", error: "session id already connected" } satisfies DaemonToShim);
            conn.close();
            return;
          }
          sessionId = f.session.session_id;
          this.shims.set(sessionId, { conn, session: f.session, refused: null });
          log(`shim up: ${f.session.project} (${sessionId})`);
          conn.send({ t: "registered", hub_connected: this.hubReady } satisfies DaemonToShim);
          this.toHub({ t: "session_up", session: f.session });
          return;
        }
        if (!sessionId) return conn.send({ t: "error", error: "register first" } satisfies DaemonToShim);
        if (f.t === "send") {
          if (!this.hubReady) {
            conn.send({ t: "send_error", req_id: f.req_id, error: "daemon is not connected to the server right now" } satisfies DaemonToShim);
            return;
          }
          const refused = this.shims.get(sessionId)?.refused;
          if (refused) {
            conn.send({ t: "send_error", req_id: f.req_id, error: `the server refused this session: ${refused}` } satisfies DaemonToShim);
            return;
          }
          const hubReq = `r${++this.reqSeq}`;
          const timer = setTimeout(() => {
            if (this.pending.delete(hubReq)) {
              conn.send({ t: "send_error", req_id: f.req_id, error: "timed out waiting for the server" } satisfies DaemonToShim);
            }
          }, SEND_TIMEOUT_MS);
          this.pending.set(hubReq, { shim: conn, shimReqId: f.req_id, timer });
          this.toHub({ t: "send", req_id: hubReq, session_id: sessionId, text: f.text, urgency: f.urgency });
          return;
        }
        if (f.t === "ack") {
          this.toHub({ t: "ack", session_id: sessionId, ids: f.ids });
        }
      },
      (error) => conn.send({ t: "error", error } satisfies DaemonToShim),
    );
    sock.on("error", () => {});
    sock.on("close", () => {
      for (const [k, p] of this.pending) {
        if (p.shim === conn) {
          clearTimeout(p.timer);
          this.pending.delete(k);
        }
      }
      if (sessionId && this.shims.get(sessionId)?.conn === conn) {
        this.shims.delete(sessionId);
        log(`shim down: ${sessionId}`);
        this.toHub({ t: "session_down", session_id: sessionId });
      }
    });
  }

  private broadcastShims(frame: DaemonToShim): void {
    for (const s of this.shims.values()) s.conn.send(frame);
  }

  /** Full session list; also clears refusals so they are retried (the Hub re-refuses if still taken). */
  private sendHello(): void {
    for (const s of this.shims.values()) s.refused = null;
    this.toHub({ t: "hello", v: PROTOCOL_VERSION, sessions: [...this.shims.values()].map((s) => s.session) });
  }

  private fatal(exitCode: number): void {
    this.stop();
    if (this.opts.onFatal) this.opts.onFatal(exitCode);
    else process.exit(exitCode);
  }

  // -------------------------------------------------------------------------
  // Hub link

  private toHub(frame: DaemonToHub): void {
    if (!this.hubReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  private connectHub(): void {
    if (this.stopped) return;
    const url = wsUrl(this.opts.config.url, "/api/daemon/ws");
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.opts.config.token}` },
      handshakeTimeout: 15_000,
      maxPayload: 1024 * 1024,
    });
    this.ws = ws;
    let revoked = false;

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        revoked = true;
        log(
          "server rejected this machine's token (revoked or unknown, e.g. after a SESSION_SECRET rotation). " +
            "Run `mcp-remote pair <url>` again, then revoke this computer's old entry on the phone (Machines) " +
            "so its session ids are freed.",
        );
      } else if (res.statusCode === 403) {
        revoked = true;
        log("server says this account is no longer allowed to sign in (removed from the sign-up list).");
      } else {
        log(`server refused websocket: HTTP ${res.statusCode}`);
      }
      res.resume();
      ws.terminate();
    });
    ws.on("open", () => {
      // Keep backing off while another daemon keeps replacing us.
      if (this.replacedStreak === 0) this.attempt = 0;
      this.openedAt = Date.now();
      this.hubReady = true;
      this.lastRx = Date.now();
      log(`connected to ${this.opts.config.url}`);
      this.sendHello();
      this.broadcastShims({ t: "hub_status", connected: true });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastRx > DEAD_AFTER_MS) {
          log("no traffic from server; reconnecting");
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, PING_EVERY_MS);
    });
    ws.on("message", (data, isBinary) => {
      this.lastRx = Date.now();
      if (isBinary) return;
      const text = data.toString();
      if (text === "pong") return;
      const r = parseFrame(HubToDaemon, text);
      if (!r.ok) {
        log("bad frame from server:", r.error);
        return;
      }
      const f = r.value;
      switch (f.t) {
        case "welcome":
          log(`server knows this machine as "${f.name}" (${f.machine_id})`);
          return;
        case "resync":
          this.sendHello();
          return;
        case "deliver": {
          const shim = this.shims.get(f.session_id);
          // If the shim is gone the Hub keeps the messages undelivered and resends on session_up.
          if (shim) shim.conn.send({ t: "deliver", messages: f.messages } satisfies DaemonToShim);
          return;
        }
        case "sent": {
          const p = this.pending.get(f.req_id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(f.req_id);
          p.shim.send({ t: "sent", req_id: p.shimReqId, message_id: f.message_id } satisfies DaemonToShim);
          return;
        }
        case "error": {
          if (f.req_id) {
            const p = this.pending.get(f.req_id);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(f.req_id);
              p.shim.send({ t: "send_error", req_id: p.shimReqId, error: f.error } satisfies DaemonToShim);
              return;
            }
          }
          if (f.session_id) {
            // e.g. a refused session_up: remember it (send_message reports it) and tell that shim,
            // so it shows up in Claude Code's MCP logs. A later hello (reconnect/resync) retries.
            const entry = this.shims.get(f.session_id);
            if (entry) entry.refused = f.error;
            entry?.conn.send({ t: "error", error: `server refused this session: ${f.error}` } satisfies DaemonToShim);
            log(`server refused session ${f.session_id}: ${f.error}`);
            return;
          }
          log("server error:", f.error);
          return;
        }
      }
    });
    ws.on("error", (e) => log("websocket error:", e.message));
    ws.on("close", (code, reason) => {
      if (this.ws === ws) this.ws = null;
      const wasReady = this.hubReady;
      this.hubReady = false;
      clearInterval(this.pingTimer);
      for (const [k, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(k);
        p.shim.send({
          t: "send_error",
          req_id: p.shimReqId,
          error: "connection to the server dropped; the message may not have been delivered",
        } satisfies DaemonToShim);
      }
      if (wasReady) this.broadcastShims({ t: "hub_status", connected: false });
      if (code === 4001) revoked = true;
      if (revoked) {
        log("this machine can no longer connect; daemon exiting. Pair again with `mcp-remote pair <url>`.");
        this.fatal(EXIT_REVOKED);
        return;
      }
      if (this.stopped) return;
      let delay: number;
      const wasStable = this.openedAt > 0 && Date.now() - this.openedAt > (this.opts.stableAfterMs ?? STABLE_AFTER_MS);
      this.openedAt = 0;
      if (wasStable) {
        this.replacedStreak = 0;
        this.attempt = 0;
      }
      if (code === 4002) {
        this.replacedStreak++;
        if (this.replacedStreak >= MAX_REPLACED_STREAK) {
          log(
            "another mcp-remote daemon is using this machine's token (config copied to another computer or VM?) " +
              "and keeps replacing this connection. Exiting. Run `mcp-remote pair <url>` on each computer so each has its own token.",
          );
          this.fatal(EXIT_DUPLICATE);
          return;
        }
        delay = (this.opts.replacedDelayMs ?? REPLACED_DELAY_MS) * this.replacedStreak + backoffDelay(this.attempt++, { baseMs: 1000, capMs: 60_000 });
      } else {
        delay = backoffDelay(this.attempt++, { baseMs: 1000, capMs: 60_000 });
      }
      log(`disconnected (${code}${reason.length ? " " + reason.toString() : ""}); retrying in ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this.connectHub(), delay);
    });
  }
}
