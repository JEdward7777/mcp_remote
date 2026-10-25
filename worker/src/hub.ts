// Per-tenant Hub Durable Object (D4, D9). One instance per user, addressed by
// env.HUB.idFromName(tenantId). It owns that user's machines, sessions, messages and every
// phone / daemon WebSocket. Nothing in here can address another tenant's Hub.
import { DurableObject } from "cloudflare:workers";
import {
  DaemonToHub,
  HISTORY_PAGE,
  HubToDaemon,
  HubToPhone,
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_MACHINE,
  MachineRecord,
  MessageRecord,
  PhoneToHub,
  SessionAnnounce,
  SessionRecord,
  Urgency,
  parseFrame,
} from "@mcp-remote/shared";
import { timingSafeEqual } from "./crypto";
import { Env, H_KIND, H_MACHINE, H_TENANT, H_TOKEN_HASH } from "./env";

type Attachment = { kind: "phone" } | { kind: "daemon"; machine_id: string };

type MachineRow = {
  machine_id: string;
  name: string;
  token_hash: string | null;
  created_at: number;
  last_seen: number | null;
  revoked_at: number | null;
};

type SessionRow = {
  session_id: string;
  machine_id: string;
  project: string;
  cwd: string | null;
  online: number;
  last_seen: number;
  created_at: number;
};

type MessageRow = {
  id: number;
  session_id: string;
  direction: "in" | "out";
  text: string;
  urgency: string | null;
  created_at: number;
  delivered: number;
};

/** Close codes the daemon understands. */
export const CLOSE_REVOKED = 4001;
export const CLOSE_REPLACED = 4002;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_POLICY = 1008;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS machines (
  machine_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_machine ON sessions(machine_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  text TEXT NOT NULL,
  urgency TEXT,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(session_id, direction, delivered);
`;

function toMessage(r: MessageRow): MessageRecord {
  const u = Urgency.safeParse(r.urgency);
  return {
    id: r.id,
    session_id: r.session_id,
    direction: r.direction,
    text: r.text,
    urgency: u.success ? u.data : null,
    created_at: r.created_at,
    delivered: r.delivered === 1,
  };
}

export class Hub extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // Keepalive pings are answered by the runtime without waking the object (D5).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // -------------------------------------------------------------------------
  // RPC used by the Worker (never reachable from outside it)

  async addMachine(machineId: string, name: string, tokenHash: string): Promise<MachineRecord> {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO machines (machine_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
      machineId,
      name,
      tokenHash,
      now,
    );
    this.broadcastState();
    return { machine_id: machineId, name, created_at: now, last_seen: null, online: false, revoked: false };
  }

  async listMachines(): Promise<MachineRecord[]> {
    return this.machineRecords();
  }

  async revokeMachine(machineId: string): Promise<boolean> {
    const row = this.sql
      .exec<MachineRow>("SELECT * FROM machines WHERE machine_id = ? AND revoked_at IS NULL", machineId)
      .toArray()[0];
    if (!row) return false;
    const now = Date.now();
    this.sql.exec("UPDATE machines SET token_hash = NULL, revoked_at = ? WHERE machine_id = ?", now, machineId);
    this.sql.exec("UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1", now, machineId);
    for (const ws of this.ctx.getWebSockets(`m:${machineId}`)) {
      try {
        ws.close(CLOSE_REVOKED, "machine revoked");
      } catch {
        /* already closing */
      }
    }
    this.broadcastState();
    return true;
  }

  async snapshot(): Promise<{ machines: MachineRecord[]; sessions: SessionRecord[] }> {
    return { machines: this.machineRecords(), sessions: this.sessionRecords() };
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade (forwarded by the Worker after it authenticated the caller)

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const kind = request.headers.get(H_KIND);
    const tenant = request.headers.get(H_TENANT);
    if (tenant) this.rememberTenant(tenant);

    if (kind === "phone") {
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["phone"]);
      server.serializeAttachment({ kind: "phone" } satisfies Attachment);
      this.sendPhone(server, this.stateFrame());
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (kind === "daemon") {
      const machineId = request.headers.get(H_MACHINE) ?? "";
      const tokenHash = request.headers.get(H_TOKEN_HASH) ?? "";
      const row = this.sql
        .exec<MachineRow>("SELECT * FROM machines WHERE machine_id = ?", machineId)
        .toArray()[0];
      if (!row || row.revoked_at !== null || !row.token_hash || !timingSafeEqual(row.token_hash, tokenHash)) {
        return new Response("machine token revoked or unknown", { status: 401 });
      }
      // One live socket per machine: a reconnecting daemon replaces a stale one.
      for (const old of this.ctx.getWebSockets(`m:${machineId}`)) {
        try {
          old.close(CLOSE_REPLACED, "replaced by a newer connection");
        } catch {
          /* ignore */
        }
      }
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ["daemon", `m:${machineId}`]);
      server.serializeAttachment({ kind: "daemon", machine_id: machineId } satisfies Attachment);
      this.sql.exec("UPDATE machines SET last_seen = ? WHERE machine_id = ?", Date.now(), machineId);
      this.sendDaemon(server, { t: "welcome", machine_id: machineId, name: row.name });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response("bad request", { status: 400 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) {
      ws.close(CLOSE_POLICY, "unknown socket");
      return;
    }
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      ws.close(CLOSE_TOO_BIG, "frame too large");
      return;
    }
    if (att.kind === "phone") {
      const r = parseFrame(PhoneToHub, message);
      if (!r.ok) {
        if (r.error === "frame too large") ws.close(CLOSE_TOO_BIG, r.error);
        else this.sendPhone(ws, { t: "error", error: r.error });
        return;
      }
      this.onPhone(ws, r.value);
    } else {
      if (!this.machineActive(att.machine_id)) {
        ws.close(CLOSE_REVOKED, "machine revoked");
        return;
      }
      const r = parseFrame(DaemonToHub, message);
      if (!r.ok) {
        if (r.error === "frame too large") ws.close(CLOSE_TOO_BIG, r.error);
        else this.sendDaemon(ws, { t: "error", error: r.error });
        return;
      }
      this.onDaemon(ws, att.machine_id, r.value);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.onSocketGone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.onSocketGone(ws);
  }

  // -------------------------------------------------------------------------
  // Phone frames

  private onPhone(ws: WebSocket, f: PhoneToHub): void {
    switch (f.t) {
      case "refresh":
        this.sendPhone(ws, this.stateFrame());
        return;
      case "history": {
        const rows = this.sql
          .exec<MessageRow>(
            "SELECT * FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
            f.session_id,
            f.before_id ?? Number.MAX_SAFE_INTEGER,
            HISTORY_PAGE + 1,
          )
          .toArray();
        const has_more = rows.length > HISTORY_PAGE;
        const messages = rows.slice(0, HISTORY_PAGE).reverse().map(toMessage);
        this.sendPhone(ws, { t: "history", session_id: f.session_id, messages, has_more });
        return;
      }
      case "send": {
        const s = this.getSession(f.session_id);
        if (!s) {
          this.sendPhone(ws, { t: "error", error: "unknown session", client_id: f.client_id });
          return;
        }
        const now = Date.now();
        const row = this.sql
          .exec<MessageRow>(
            "INSERT INTO messages (session_id, direction, text, urgency, created_at, delivered) VALUES (?, 'in', ?, NULL, ?, 0) RETURNING *",
            f.session_id,
            f.text,
            now,
          )
          .one();
        const msg = toMessage(row);
        this.broadcastPhones({ t: "message", message: msg, client_id: f.client_id });
        // Deliver now if the session is live; otherwise it waits for session_up/hello.
        if (s.online === 1) {
          const d = this.daemonSocket(s.machine_id);
          if (d) this.sendDaemon(d, { t: "deliver", session_id: s.session_id, messages: [msg] });
        }
        return;
      }
      case "forget_session": {
        const s = this.getSession(f.session_id);
        if (!s) return;
        if (s.online === 1 && this.daemonSocket(s.machine_id)) {
          this.sendPhone(ws, { t: "error", error: "cannot forget an online session" });
          return;
        }
        this.sql.exec("DELETE FROM messages WHERE session_id = ?", f.session_id);
        this.sql.exec("DELETE FROM sessions WHERE session_id = ?", f.session_id);
        this.broadcastState();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Daemon frames

  private onDaemon(ws: WebSocket, machineId: string, f: DaemonToHub): void {
    const now = Date.now();
    switch (f.t) {
      case "hello": {
        this.sql.exec("UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1", now, machineId);
        for (const s of f.sessions) {
          const err = this.upsertSession(machineId, s, now);
          if (err) this.sendDaemon(ws, { t: "error", error: `${s.session_id}: ${err}` });
        }
        for (const s of f.sessions) this.flushPending(ws, machineId, s.session_id);
        this.broadcastState();
        return;
      }
      case "session_up": {
        const err = this.upsertSession(machineId, f.session, now);
        if (err) {
          this.sendDaemon(ws, { t: "error", error: `${f.session.session_id}: ${err}` });
          return;
        }
        this.flushPending(ws, machineId, f.session.session_id);
        this.broadcastState();
        return;
      }
      case "session_down": {
        this.sql.exec(
          "UPDATE sessions SET online = 0, last_seen = ? WHERE session_id = ? AND machine_id = ?",
          now,
          f.session_id,
          machineId,
        );
        this.broadcastState();
        return;
      }
      case "send": {
        const s = this.getSession(f.session_id);
        if (!s || s.machine_id !== machineId) {
          this.sendDaemon(ws, { t: "error", error: "unknown session", req_id: f.req_id });
          return;
        }
        const delivered = this.ctx.getWebSockets("phone").length > 0 ? 1 : 0;
        const row = this.sql
          .exec<MessageRow>(
            "INSERT INTO messages (session_id, direction, text, urgency, created_at, delivered) VALUES (?, 'out', ?, ?, ?, ?) RETURNING *",
            f.session_id,
            f.text,
            f.urgency,
            now,
            delivered,
          )
          .one();
        this.sql.exec("UPDATE sessions SET last_seen = ? WHERE session_id = ?", now, f.session_id);
        const msg = toMessage(row);
        this.sendDaemon(ws, { t: "sent", req_id: f.req_id, message_id: msg.id });
        this.broadcastPhones({ t: "message", message: msg });
        return;
      }
      case "ack": {
        const s = this.getSession(f.session_id);
        if (!s || s.machine_id !== machineId) return;
        const ids = [...new Set(f.ids)];
        const placeholders = ids.map(() => "?").join(",");
        const updated = this.sql
          .exec<{ id: number }>(
            `UPDATE messages SET delivered = 1 WHERE session_id = ? AND direction = 'in' AND delivered = 0 AND id IN (${placeholders}) RETURNING id`,
            f.session_id,
            ...ids,
          )
          .toArray()
          .map((r) => r.id);
        if (updated.length) this.broadcastPhones({ t: "delivered", session_id: f.session_id, ids: updated });
        return;
      }
    }
  }

  private upsertSession(machineId: string, s: SessionAnnounce, now: number): string | null {
    const existing = this.getSession(s.session_id);
    if (existing && existing.machine_id !== machineId) return "session id already used by another machine";
    if (!existing) {
      const count = this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE machine_id = ? AND online = 1", machineId)
        .one().n;
      if (count >= MAX_SESSIONS_PER_MACHINE) return "too many live sessions on this machine";
      this.sql.exec(
        "INSERT INTO sessions (session_id, machine_id, project, cwd, online, last_seen, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        s.session_id,
        machineId,
        s.project,
        s.cwd ?? null,
        now,
        now,
      );
    } else {
      this.sql.exec(
        "UPDATE sessions SET project = ?, cwd = ?, online = 1, last_seen = ? WHERE session_id = ?",
        s.project,
        s.cwd ?? null,
        now,
        s.session_id,
      );
    }
    return null;
  }

  private flushPending(ws: WebSocket, machineId: string, sessionId: string): void {
    const s = this.getSession(sessionId);
    if (!s || s.machine_id !== machineId || s.online !== 1) return;
    const rows = this.sql
      .exec<MessageRow>(
        "SELECT * FROM messages WHERE session_id = ? AND direction = 'in' AND delivered = 0 ORDER BY id LIMIT 500",
        sessionId,
      )
      .toArray();
    if (rows.length) this.sendDaemon(ws, { t: "deliver", session_id: sessionId, messages: rows.map(toMessage) });
  }

  private onSocketGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.kind !== "daemon") return;
    // Only mark the machine offline if no other (newer) socket for it is still open.
    const others = this.ctx
      .getWebSockets(`m:${att.machine_id}`)
      .filter((o) => o !== ws && o.readyState === WebSocket.OPEN);
    if (others.length) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE sessions SET online = 0, last_seen = ? WHERE machine_id = ? AND online = 1",
      now,
      att.machine_id,
    );
    this.sql.exec("UPDATE machines SET last_seen = ? WHERE machine_id = ?", now, att.machine_id);
    this.broadcastState(ws);
  }

  // -------------------------------------------------------------------------
  // Queries / helpers

  private rememberTenant(tenant: string): void {
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('tenant', ?)", tenant);
  }

  private machineActive(machineId: string): boolean {
    return (
      this.sql
        .exec<{ n: number }>(
          "SELECT COUNT(*) AS n FROM machines WHERE machine_id = ? AND revoked_at IS NULL",
          machineId,
        )
        .one().n > 0
    );
  }

  private getSession(sessionId: string): SessionRow | undefined {
    return this.sql.exec<SessionRow>("SELECT * FROM sessions WHERE session_id = ?", sessionId).toArray()[0];
  }

  private daemonSocket(machineId: string, exclude?: WebSocket): WebSocket | undefined {
    return this.ctx
      .getWebSockets(`m:${machineId}`)
      .find((w) => w !== exclude && w.readyState === WebSocket.OPEN);
  }

  private liveMachines(exclude?: WebSocket): Set<string> {
    const live = new Set<string>();
    for (const w of this.ctx.getWebSockets("daemon")) {
      if (w === exclude || w.readyState !== WebSocket.OPEN) continue;
      const a = w.deserializeAttachment() as Attachment | null;
      if (a?.kind === "daemon") live.add(a.machine_id);
    }
    return live;
  }

  private machineRecords(exclude?: WebSocket): MachineRecord[] {
    const live = this.liveMachines(exclude);
    return this.sql
      .exec<MachineRow>("SELECT * FROM machines ORDER BY created_at")
      .toArray()
      .map((m) => ({
        machine_id: m.machine_id,
        name: m.name,
        created_at: m.created_at,
        last_seen: m.last_seen,
        online: m.revoked_at === null && live.has(m.machine_id),
        revoked: m.revoked_at !== null,
      }));
  }

  private sessionRecords(exclude?: WebSocket): SessionRecord[] {
    const live = this.liveMachines(exclude);
    type Row = SessionRow & { last_message_at: number | null; last_urgency: string | null; pending_in: number };
    return this.sql
      .exec<Row>(
        `SELECT s.*,
           (SELECT MAX(created_at) FROM messages m WHERE m.session_id = s.session_id) AS last_message_at,
           (SELECT urgency FROM messages m WHERE m.session_id = s.session_id AND m.direction = 'out' ORDER BY id DESC LIMIT 1) AS last_urgency,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id AND m.direction = 'in' AND m.delivered = 0) AS pending_in
         FROM sessions s ORDER BY s.machine_id, s.project, s.created_at`,
      )
      .toArray()
      .map((s) => {
        const u = Urgency.safeParse(s.last_urgency);
        return {
          session_id: s.session_id,
          machine_id: s.machine_id,
          project: s.project,
          cwd: s.cwd,
          online: s.online === 1 && live.has(s.machine_id),
          last_seen: s.last_seen,
          last_message_at: s.last_message_at,
          last_urgency: u.success ? u.data : null,
          pending_in: s.pending_in,
        };
      });
  }

  private stateFrame(exclude?: WebSocket): HubToPhone {
    return { t: "state", machines: this.machineRecords(exclude), sessions: this.sessionRecords(exclude) };
  }

  private broadcastState(exclude?: WebSocket): void {
    if (this.ctx.getWebSockets("phone").length === 0) return;
    this.broadcastPhones(this.stateFrame(exclude));
  }

  private broadcastPhones(frame: HubToPhone): void {
    const data = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets("phone")) {
      try {
        ws.send(data);
      } catch {
        /* socket closing */
      }
    }
  }

  private sendPhone(ws: WebSocket, frame: HubToPhone): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closing */
    }
  }

  private sendDaemon(ws: WebSocket, frame: HubToDaemon): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* closing */
    }
  }
}
