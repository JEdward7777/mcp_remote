/**
 * Wire protocol shared by the Worker/Hub, the daemon, the shim and the PWA.
 *
 * Three links, each with its own frame set (all JSON text frames):
 *   phone  <-> Hub     (PhoneToHub / HubToPhone)
 *   daemon <-> Hub     (DaemonToHub / HubToDaemon)
 *   shim   <-> daemon  (ShimToDaemon / DaemonToShim), newline-delimited JSON over a local socket
 *
 * Message direction (D17): "in" = phone -> agent session, "out" = agent session -> phone.
 * The literal text frames "ping" / "pong" are keepalives answered by the Hub's
 * auto-response (D5) and never reach these schemas.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

/** Maximum size of any single WebSocket / IPC frame, in bytes (UTF-8). */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Maximum length of a message body, in characters. */
export const MAX_TEXT_CHARS = 8000;
/** Maximum number of sessions one daemon may report at once. */
export const MAX_SESSIONS_PER_MACHINE = 64;
/** Default page size for thread history. */
export const HISTORY_PAGE = 200;
/** Launchable projects one daemon may advertise (D6, Phase 2). */
export const MAX_PROJECTS_PER_MACHINE = 200;
/** Hard cap on phone-launched sessions one daemon tracks (running + recently ended). */
export const MAX_LAUNCHES_PER_MACHINE = 16;
/** Max length of a launch status detail line. */
export const MAX_DETAIL_CHARS = 400;

export const URGENCIES = ["silent", "normal", "urgent"] as const;
export const Urgency = z.enum(URGENCIES);
export type Urgency = z.infer<typeof Urgency>;

export const Direction = z.enum(["in", "out"]);
export type Direction = z.infer<typeof Direction>;

/** Session ids: generated UUIDs, or a user-chosen override (MCP_REMOTE_SESSION_ID). */
export const SessionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "session id may only contain letters, digits, '_' and '-'");
export const MachineId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Text that a human or agent sends. Must be non-blank. */
export const MessageText = z
  .string()
  .max(MAX_TEXT_CHARS)
  .refine((s) => s.trim().length > 0, "text must not be empty");

const Short = (max: number) => z.string().min(1).max(max);
const ReqId = z.string().min(1).max(64);

/** Opaque project id chosen by the daemon (a hash of the allowlisted path; the path itself never leaves the computer). */
export const ProjectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** Launch ids double as the launched session's id and tmux session name (`mr-<hex>`). */
export const LaunchId = z
  .string()
  .regex(/^mr-[0-9a-f]{12}$/, "launch id must look like mr-<12 hex>");

/**
 * Lifecycle of a phone-launched Claude Code session (D6):
 *   starting        tmux session created, waiting for Claude Code to start the shim
 *   running         the shim registered with the daemon and no startup dialog is showing
 *   needs_attention a startup dialog the daemon will not answer is showing (or startup timed out): see detail
 *   exited          the session ended (exit_code when known; stopped from the phone, crashed, or quit)
 *   failed          could not be started at all, or auto-restart gave up
 */
export const LAUNCH_STATES = ["starting", "running", "needs_attention", "exited", "failed"] as const;
export const LaunchState = z.enum(LAUNCH_STATES);
export type LaunchState = z.infer<typeof LaunchState>;

export const ProjectInfo = z.object({ id: ProjectId, name: Short(128) });
export type ProjectInfo = z.infer<typeof ProjectInfo>;

export const LaunchRecord = z.object({
  launch_id: LaunchId,
  /** Same value as launch_id: the shim registers with it, which links launch <-> session. */
  session_id: SessionId,
  project_id: ProjectId,
  project: Short(128),
  state: LaunchState,
  exit_code: z.number().int().nullable(),
  detail: z.string().max(MAX_DETAIL_CHARS).nullable(),
  /** Started (or last restarted) with --continue. */
  continued: z.boolean(),
  auto_restart: z.boolean(),
  /** Automatic restarts in the current crash window. */
  restarts: z.number().int().nonnegative(),
  started_at: z.number().int(),
  updated_at: z.number().int(),
});
export type LaunchRecord = z.infer<typeof LaunchRecord>;

/** What a machine can launch, as last reported by its daemon. */
export const LaunchInfo = z.object({
  projects: z.array(ProjectInfo).max(MAX_PROJECTS_PER_MACHINE),
  launches: z.array(LaunchRecord).max(MAX_LAUNCHES_PER_MACHINE),
  /** False when launching cannot work on that computer (no tmux, Windows, ...); see launch_error. */
  available: z.boolean(),
  launch_error: z.string().max(MAX_DETAIL_CHARS).nullable(),
  max_sessions: z.number().int().nonnegative(),
});
export type LaunchInfo = z.infer<typeof LaunchInfo>;

export const SessionAnnounce = z.object({
  session_id: SessionId,
  project: Short(128),
  cwd: z.string().max(1024).optional(),
});
export type SessionAnnounce = z.infer<typeof SessionAnnounce>;

// ---------------------------------------------------------------------------
// Records as the Hub reports them

export const MessageRecord = z.object({
  id: z.number().int().nonnegative(),
  session_id: SessionId,
  direction: Direction,
  text: z.string(),
  urgency: Urgency.nullable(),
  created_at: z.number().int(),
  delivered: z.boolean(),
});
export type MessageRecord = z.infer<typeof MessageRecord>;

export const SessionRecord = z.object({
  session_id: SessionId,
  machine_id: MachineId,
  project: z.string(),
  cwd: z.string().nullable(),
  online: z.boolean(),
  last_seen: z.number().int(),
  last_message_at: z.number().int().nullable(),
  last_urgency: Urgency.nullable(),
  pending_in: z.number().int().nonnegative(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export const MachineRecord = z.object({
  machine_id: MachineId,
  name: z.string(),
  created_at: z.number().int(),
  last_seen: z.number().int().nullable(),
  online: z.boolean(),
  revoked: z.boolean(),
  /** Remote launch (Phase 2); null until the daemon has reported it. */
  launch: LaunchInfo.nullable(),
});
export type MachineRecord = z.infer<typeof MachineRecord>;

// ---------------------------------------------------------------------------
// phone <-> Hub

export const PhoneToHub = z.discriminatedUnion("t", [
  z.object({ t: z.literal("send"), session_id: SessionId, text: MessageText, client_id: ReqId.optional() }),
  z.object({
    t: z.literal("history"),
    session_id: SessionId,
    before_id: z.number().int().positive().optional(),
  }),
  z.object({ t: z.literal("refresh") }),
  z.object({ t: z.literal("forget_session"), session_id: SessionId }),
  // Remote launch (D6). The daemon only accepts allowlisted project ids; no path or command is ever sent.
  z.object({
    t: z.literal("launch"),
    machine_id: MachineId,
    project_id: ProjectId,
    continue: z.boolean(),
    auto_restart: z.boolean().optional(),
    client_id: ReqId,
  }),
  z.object({ t: z.literal("launch_stop"), machine_id: MachineId, launch_id: LaunchId, client_id: ReqId }),
  z.object({
    t: z.literal("launch_restart"),
    machine_id: MachineId,
    launch_id: LaunchId,
    continue: z.boolean(),
    client_id: ReqId,
  }),
  /** Remove an ended launch from the list. */
  z.object({ t: z.literal("launch_dismiss"), machine_id: MachineId, launch_id: LaunchId, client_id: ReqId }),
]);
export type PhoneToHub = z.infer<typeof PhoneToHub>;

export const HubToPhone = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("state"),
    machines: z.array(MachineRecord),
    sessions: z.array(SessionRecord),
  }),
  z.object({ t: z.literal("message"), message: MessageRecord, client_id: ReqId.optional() }),
  z.object({
    t: z.literal("history"),
    session_id: SessionId,
    messages: z.array(MessageRecord),
    has_more: z.boolean(),
  }),
  z.object({ t: z.literal("delivered"), session_id: SessionId, ids: z.array(z.number().int()) }),
  z.object({ t: z.literal("error"), error: z.string(), client_id: ReqId.optional() }),
  /** Launch list changed on one machine (cheaper than a full state frame). */
  z.object({ t: z.literal("launches"), machine_id: MachineId, launches: z.array(LaunchRecord) }),
  /** Answer to a launch / launch_stop / launch_restart / launch_dismiss request. */
  z.object({ t: z.literal("launch_result"), client_id: ReqId, ok: z.boolean(), error: z.string().optional() }),
]);
export type HubToPhone = z.infer<typeof HubToPhone>;

// ---------------------------------------------------------------------------
// daemon <-> Hub

export const DaemonToHub = z.discriminatedUnion("t", [
  /** Sent first on every (re)connect: the complete set of live sessions on this machine. */
  z.object({
    t: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    sessions: z.array(SessionAnnounce).max(MAX_SESSIONS_PER_MACHINE),
  }),
  z.object({ t: z.literal("session_up"), session: SessionAnnounce }),
  z.object({ t: z.literal("session_down"), session_id: SessionId }),
  z.object({
    t: z.literal("send"),
    req_id: ReqId,
    session_id: SessionId,
    text: MessageText,
    urgency: Urgency,
  }),
  /** The shim has emitted these inbound messages to Claude Code. */
  z.object({ t: z.literal("ack"), session_id: SessionId, ids: z.array(z.number().int()).min(1).max(500) }),
  /** Launchable projects + capability; sent after hello and whenever the launch config changes. */
  z.object({
    t: z.literal("projects"),
    projects: z.array(ProjectInfo).max(MAX_PROJECTS_PER_MACHINE),
    available: z.boolean(),
    launch_error: z.string().max(MAX_DETAIL_CHARS).nullable(),
    max_sessions: z.number().int().nonnegative(),
  }),
  /** Full snapshot of launched sessions; sent after hello and on every change. */
  z.object({ t: z.literal("launches"), launches: z.array(LaunchRecord).max(MAX_LAUNCHES_PER_MACHINE) }),
  z.object({ t: z.literal("launch_result"), req_id: ReqId, ok: z.boolean(), error: z.string().max(MAX_DETAIL_CHARS).optional() }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

export const HubToDaemon = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), machine_id: MachineId, name: z.string() }),
  z.object({ t: z.literal("deliver"), session_id: SessionId, messages: z.array(MessageRecord) }),
  z.object({ t: z.literal("sent"), req_id: ReqId, message_id: z.number().int() }),
  /** Re-send hello (e.g. a session id this daemon was refused may be free now). */
  z.object({ t: z.literal("resync") }),
  z.object({
    t: z.literal("launch"),
    req_id: ReqId,
    project_id: ProjectId,
    continue: z.boolean(),
    auto_restart: z.boolean().optional(),
  }),
  z.object({ t: z.literal("launch_stop"), req_id: ReqId, launch_id: LaunchId }),
  z.object({ t: z.literal("launch_restart"), req_id: ReqId, launch_id: LaunchId, continue: z.boolean() }),
  z.object({ t: z.literal("launch_dismiss"), req_id: ReqId, launch_id: LaunchId }),
  /** session_id is set when the error concerns one session (e.g. a refused session_up). */
  z.object({ t: z.literal("error"), error: z.string(), req_id: ReqId.optional(), session_id: SessionId.optional() }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

// ---------------------------------------------------------------------------
// shim <-> daemon (local IPC)

export const ShimToDaemon = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("register"),
    v: z.literal(PROTOCOL_VERSION),
    session: SessionAnnounce,
    /** MCP_REMOTE_LAUNCH_TOKEN of a phone-launched session: proves the shim belongs to the current launch. */
    launch_token: z.string().min(1).max(64).optional(),
    /** Parent, grandparent, ... pids of the shim (launched sessions only): tells the session's own shim
     * (child of the Claude Code in the tmux pane) from one started by a nested `claude` deeper down. */
    ancestors: z.array(z.number().int().positive()).max(8).optional(),
  }),
  z.object({ t: z.literal("send"), req_id: ReqId, text: MessageText, urgency: Urgency }),
  z.object({ t: z.literal("ack"), ids: z.array(z.number().int()).min(1).max(500) }),
  /** From the local CLI (same user, 0600 socket): re-read launch.json after `mcp-remote projects/config ...`. */
  z.object({ t: z.literal("reload") }),
]);
export type ShimToDaemon = z.infer<typeof ShimToDaemon>;

export const DaemonToShim = z.discriminatedUnion("t", [
  z.object({ t: z.literal("registered"), hub_connected: z.boolean() }),
  /** Registration rejected by the daemon itself (duplicate id, too many sessions); the daemon closes. */
  z.object({ t: z.literal("register_refused"), error: z.string() }),
  z.object({ t: z.literal("hub_status"), connected: z.boolean() }),
  z.object({ t: z.literal("deliver"), messages: z.array(MessageRecord) }),
  z.object({ t: z.literal("sent"), req_id: ReqId, message_id: z.number().int() }),
  z.object({ t: z.literal("send_error"), req_id: ReqId, error: z.string() }),
  z.object({ t: z.literal("error"), error: z.string() }),
  z.object({ t: z.literal("reloaded"), ok: z.boolean(), error: z.string().optional() }),
]);
export type DaemonToShim = z.infer<typeof DaemonToShim>;

// ---------------------------------------------------------------------------
// HTTP: pairing

export const PairStartRequest = z.object({ hostname: z.string().max(128).optional() });
export const PairStartResponse = z.object({
  code: z.string(),
  pairing_id: z.string(),
  poll_secret: z.string(),
  expires_at: z.number().int(),
});
export type PairStartResponse = z.infer<typeof PairStartResponse>;

export const PairApproveRequest = z.object({
  code: z.string().min(4).max(32),
  machine_name: z.string().trim().min(1).max(64).optional(),
});

/** Sent to the waiting daemon over the pairing WebSocket. */
export const PairResult = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("approved"),
    token: z.string(),
    machine_id: MachineId,
    machine_name: z.string(),
    account: z.string(),
  }),
  z.object({ t: z.literal("pending"), expires_at: z.number().int() }),
  z.object({ t: z.literal("expired") }),
]);
export type PairResult = z.infer<typeof PairResult>;

// ---------------------------------------------------------------------------
// Helpers

/** UTF-8 byte length without depending on TextEncoder (works in every runtime). */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse one JSON frame with a schema, enforcing MAX_FRAME_BYTES. Never throws.
 */
export function parseFrame<T>(schema: z.ZodType<T>, raw: string | ArrayBuffer | ArrayBufferView): ParseResult<T> {
  if (typeof raw !== "string") return { ok: false, error: "binary frames are not accepted" };
  // Cheap upper bound first: UTF-8 is at most 3 bytes per UTF-16 code unit.
  if (raw.length > MAX_FRAME_BYTES || (raw.length * 3 > MAX_FRAME_BYTES && byteLength(raw) > MAX_FRAME_BYTES)) {
    return { ok: false, error: "frame too large" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue && issue.path.length ? ` at ${issue.path.join(".")}` : "";
    return { ok: false, error: `invalid frame${where}: ${issue?.message ?? "unknown"}` };
  }
  return { ok: true, value: r.data };
}

/** Serialize a frame; callers pass already-typed values. */
export function encodeFrame<T>(frame: T): string {
  return JSON.stringify(frame);
}
