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

/**
 * Coding agent a phone-launched session runs (Phase 5): Claude Code (interactive, in tmux, phone messages
 * as channel events) or OpenAI Codex (one `codex exec` turn per phone message batch, driven by the daemon).
 */
export const AGENTS = ["claude", "codex"] as const;
export const Agent = z.enum(AGENTS);
export type Agent = z.infer<typeof Agent>;

/** `agent`: the agent this project starts with unless the phone picks another (absent = claude). */
export const ProjectInfo = z.object({ id: ProjectId, name: Short(128), agent: Agent.optional() });
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
  /** Which agent runs this session (absent in reports from older daemons = claude). */
  agent: Agent.default("claude"),
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
  /** Agents this computer can launch (absent from older daemons = claude only). */
  agents: z.array(Agent).max(AGENTS.length).optional(),
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

/**
 * Per-tenant usage for the current UTC day (Phase 3, D10). Counts only this tenant's own Hub
 * (D9: never cross-tenant). `message_cap` is the plan's daily message limit (in + out).
 */
export const UsageInfo = z.object({
  plan: z.string().max(32),
  /** UTC day, YYYY-MM-DD. */
  day: z.string().max(10),
  messages: z.number().int().nonnegative(),
  message_cap: z.number().int().nonnegative(),
  launches: z.number().int().nonnegative(),
  /** Connects and API calls the Hub handled. */
  requests: z.number().int().nonnegative(),
  /** Inbound WebSocket frames the Hub handled (billed ~20:1 as requests). */
  frames: z.number().int().nonnegative(),
  rows_read: z.number().int().nonnegative(),
  rows_written: z.number().int().nonnegative(),
  /** Daily budget (share of each free daily limit) the counters above are checked against. */
  budget: z.object({
    do_requests: z.number().int().nonnegative(),
    rows_read: z.number().int().nonnegative(),
    rows_written: z.number().int().nonnegative(),
    share_percent: z.number().nonnegative(),
  }),
  /** Set when a daily budget is used up: the reason, shown on the phone until 00:00 UTC. */
  blocked: z.string().nullable(),
  /** Web Push notifications sent today and the plan's daily cap (Phase 4). */
  pushes: z.number().int().nonnegative().optional(),
  push_cap: z.number().int().nonnegative().optional(),
});
export type UsageInfo = z.infer<typeof UsageInfo>;

// ---------------------------------------------------------------------------
// On-demand location (D14) and notification settings (D19, Phase 4)

/** Max length of the reason Claude gives when it asks for the user's location (shown on the phone). */
export const MAX_LOCATION_REASON_CHARS = 200;
/** Longest a get_location call waits for the phone (seconds). */
export const MAX_LOCATION_TIMEOUT_S = 120;

/** A position as the phone reported it. `at` = when the phone measured it (ms since epoch). */
export const Position = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Radius of 68% confidence in metres, as the browser reported it (null if unknown). */
  accuracy_m: z.number().nonnegative().max(1e7).nullable(),
  at: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof Position>;

/**
 * Outcome of a location request:
 *   ok           position is set (fresh = the user shared it for this request; otherwise it is the position
 *                the user shared with THIS session earlier, at most max_age_s old)
 *   denied       the user declined (or the browser permission is denied)
 *   unavailable  the phone could not get a fix
 *   disabled     location is turned off for this account (Settings on the phone)
 *   no_device    no open app and no push-enabled phone to ask
 *   rate_limited too many location requests that needed the phone
 *   timeout      nobody answered in time (set by the shim)
 * `position` is null for every status except ok (consent, D14: a declined or unanswered request
 * never hands out an older position, and a position shared with one session never reaches another).
 */
export const LOCATION_STATUSES = ["ok", "denied", "unavailable", "disabled", "no_device", "rate_limited", "timeout"] as const;
export const LocationStatus = z.enum(LOCATION_STATUSES);
export type LocationStatus = z.infer<typeof LocationStatus>;
export const LocationResult = z.object({
  status: LocationStatus,
  position: Position.nullable(),
  /** True when `position` was measured in answer to this request. */
  fresh: z.boolean(),
  message: z.string().max(MAX_DETAIL_CHARS).optional(),
});
export type LocationResult = z.infer<typeof LocationResult>;
/** How the Hub is asking the phone: the open app (visible), or a push notification. */
export const LocationVia = z.enum(["app", "push"]);
export type LocationVia = z.infer<typeof LocationVia>;

/** A registered push subscription, as listed on the phone (Settings -> devices). */
export const PushDevice = z.object({
  /** First 16 hex chars of sha256(endpoint). */
  id: z.string().max(32),
  /** "Chrome on Android", from the User-Agent at registration. */
  label: z.string().max(64),
  added_at: z.number().int(),
});
export type PushDevice = z.infer<typeof PushDevice>;

/** A pending location request as the phone sees it. `tok` lets a notification tap share without a second prompt. */
export const LocationRequestInfo = z.object({
  rid: ReqId,
  session_id: SessionId,
  project: z.string().max(128),
  reason: z.string().max(MAX_LOCATION_REASON_CHARS).nullable(),
  tok: z.string().min(16).max(64),
  expires_at: z.number().int(),
});
export type LocationRequestInfo = z.infer<typeof LocationRequestInfo>;

/** Per-account settings the phone can change (stored in the account's Hub). */
export const Settings = z.object({
  /** Show the first ~100 characters of a message in the notification (lock screen). */
  push_preview: z.boolean(),
  /** Claude may ask for this phone's location (D14). Off: requests are refused, last-known is deleted. */
  location: z.boolean(),
  /** When the last-known position was measured (no coordinates are sent to the phone list). */
  location_at: z.number().int().nullable(),
  /** Project of the session that position was shared with (only that session may reuse it). */
  location_project: z.string().max(128).nullable(),
  /** Push subscriptions stored for this account (a phone finds its own by id). */
  push_devices: z.array(PushDevice).max(16),
  /** Web Push is configured on the server (VAPID keys set). */
  push_available: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

/** Seconds until a rate-limited request may succeed (set on rate-limit errors). */
const RetryAfterS = z.number().int().nonnegative().optional();

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
    /** Agent to run (default: the project's agent); the daemon refuses agents it has not enabled. */
    agent: Agent.optional(),
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
  /**
   * The page became visible / hidden. `dev` = this browser's push subscription id: while its page is
   * visible, that device gets no push (the others still do).
   */
  z.object({ t: z.literal("visibility"), visible: z.boolean(), dev: z.string().regex(/^[0-9a-f]{16}$/).optional() }),
  z.object({ t: z.literal("settings"), push_preview: z.boolean().optional(), location: z.boolean().optional() }),
  /**
   * The user's answer to a pending location request (rid + tok from location_request / location_pending).
   * Anything else is refused: no position is ever stored without a request. `position` required when ok.
   */
  z
    .object({
      t: z.literal("location"),
      rid: ReqId,
      tok: z.string().min(16).max(64),
      status: z.enum(["ok", "denied", "unavailable"]),
      position: Position.optional(),
    })
    .refine((f) => f.status !== "ok" || !!f.position, "position is required when status is ok"),
  /** Ask for the list of pending location requests (answered with location_pending). */
  z.object({ t: z.literal("location_list") }),
]);
export type PhoneToHub = z.infer<typeof PhoneToHub>;

export const HubToPhone = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("state"),
    machines: z.array(MachineRecord),
    sessions: z.array(SessionRecord),
    usage: UsageInfo.optional(),
    settings: Settings.optional(),
  }),
  /** Claude asks for the phone's location; answer with a PhoneToHub "location" frame (rid + tok). */
  z.object({ t: z.literal("location_request"), request: LocationRequestInfo }),
  /** Every pending location request (sent on connect and on location_list): the complete list. */
  z.object({ t: z.literal("location_pending"), requests: z.array(LocationRequestInfo).max(32) }),
  /** A location request was answered (by this or another phone) or expired: close its prompt. */
  z.object({ t: z.literal("location_done"), rid: ReqId, status: z.enum(["ok", "denied", "unavailable", "expired"]) }),
  /** Settings changed (cheaper than a full state frame). */
  z.object({ t: z.literal("settings"), settings: Settings }),
  z.object({ t: z.literal("message"), message: MessageRecord, client_id: ReqId.optional() }),
  z.object({
    t: z.literal("history"),
    session_id: SessionId,
    messages: z.array(MessageRecord),
    has_more: z.boolean(),
  }),
  z.object({ t: z.literal("delivered"), session_id: SessionId, ids: z.array(z.number().int()) }),
  z.object({ t: z.literal("error"), error: z.string(), client_id: ReqId.optional(), retry_after_s: RetryAfterS }),
  /** Launch list changed on one machine (cheaper than a full state frame). */
  z.object({ t: z.literal("launches"), machine_id: MachineId, launches: z.array(LaunchRecord) }),
  /** Answer to a launch / launch_stop / launch_restart / launch_dismiss request. */
  z.object({ t: z.literal("launch_result"), client_id: ReqId, ok: z.boolean(), error: z.string().optional(), retry_after_s: RetryAfterS }),
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
    agents: z.array(Agent).max(AGENTS.length).optional(),
  }),
  /** Full snapshot of launched sessions; sent after hello and on every change. */
  z.object({ t: z.literal("launches"), launches: z.array(LaunchRecord).max(MAX_LAUNCHES_PER_MACHINE) }),
  z.object({ t: z.literal("launch_result"), req_id: ReqId, ok: z.boolean(), error: z.string().max(MAX_DETAIL_CHARS).optional() }),
  /** Claude in session_id calls get_location (D14). Answered with location_wait and/or location. */
  z.object({
    t: z.literal("location_req"),
    req_id: ReqId,
    session_id: SessionId,
    /** A last-known position at most this old (seconds) answers at once without asking the phone. */
    max_age_s: z.number().int().min(0).max(86_400),
    reason: z.string().max(MAX_LOCATION_REASON_CHARS).optional(),
  }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

export const HubToDaemon = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), machine_id: MachineId, name: z.string() }),
  z.object({ t: z.literal("deliver"), session_id: SessionId, messages: z.array(MessageRecord) }),
  /** `notify`: how the user is told (app open / push to N devices / why not), for the tool result. */
  z.object({ t: z.literal("sent"), req_id: ReqId, message_id: z.number().int(), notify: z.string().max(MAX_DETAIL_CHARS).optional() }),
  /** The phone is being asked (open app or push); `last` = last-known position, if any (any age). */
  /** The phone is being asked (no position is handed out until the user answers). */
  z.object({ t: z.literal("location_wait"), req_id: ReqId, via: LocationVia }),
  z.object({ t: z.literal("location"), req_id: ReqId, result: LocationResult }),
  /** Re-send hello (e.g. a session id this daemon was refused may be free now). */
  z.object({ t: z.literal("resync") }),
  z.object({
    t: z.literal("launch"),
    req_id: ReqId,
    project_id: ProjectId,
    continue: z.boolean(),
    auto_restart: z.boolean().optional(),
    agent: Agent.optional(),
  }),
  z.object({ t: z.literal("launch_stop"), req_id: ReqId, launch_id: LaunchId }),
  z.object({ t: z.literal("launch_restart"), req_id: ReqId, launch_id: LaunchId, continue: z.boolean() }),
  z.object({ t: z.literal("launch_dismiss"), req_id: ReqId, launch_id: LaunchId }),
  /** session_id is set when the error concerns one session (e.g. a refused session_up). */
  z.object({
    t: z.literal("error"),
    error: z.string(),
    req_id: ReqId.optional(),
    session_id: SessionId.optional(),
    retry_after_s: RetryAfterS,
  }),
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
    /** Started by Codex for a phone-driven turn (Phase 5): only valid as that turn's shim, never a session of its own. */
    agent: z.literal("codex").optional(),
  }),
  z.object({ t: z.literal("send"), req_id: ReqId, text: MessageText, urgency: Urgency }),
  z.object({ t: z.literal("ack"), ids: z.array(z.number().int()).min(1).max(500) }),
  z.object({
    t: z.literal("location_req"),
    req_id: ReqId,
    max_age_s: z.number().int().min(0).max(86_400),
    reason: z.string().max(MAX_LOCATION_REASON_CHARS).optional(),
  }),
  /** From the local CLI (same user, 0600 socket): re-read launch.json after `mcp-remote projects/config ...`. */
  z.object({ t: z.literal("reload") }),
  /**
   * From `mcp-remote run-codex` (Phase 5): a Codex turn of this launch just ended and its status file is
   * written, so the daemon looks now instead of at its next liveness check. Only a hint: the daemon reads
   * the status file and checks its token itself.
   */
  z.object({ t: z.literal("turn_end"), session_id: SessionId, launch_token: z.string().min(1).max(64) }),
]);
export type ShimToDaemon = z.infer<typeof ShimToDaemon>;

export const DaemonToShim = z.discriminatedUnion("t", [
  /** `reason`: why the daemon is not connected to the server, when the server said (rate limit, daily budget). */
  z.object({ t: z.literal("registered"), hub_connected: z.boolean(), reason: z.string().max(MAX_DETAIL_CHARS).optional() }),
  /** Registration rejected by the daemon itself (duplicate id, too many sessions); the daemon closes. */
  z.object({ t: z.literal("register_refused"), error: z.string() }),
  z.object({ t: z.literal("hub_status"), connected: z.boolean(), reason: z.string().max(MAX_DETAIL_CHARS).optional() }),
  z.object({ t: z.literal("deliver"), messages: z.array(MessageRecord) }),
  z.object({ t: z.literal("sent"), req_id: ReqId, message_id: z.number().int(), notify: z.string().max(MAX_DETAIL_CHARS).optional() }),
  z.object({ t: z.literal("send_error"), req_id: ReqId, error: z.string() }),
  /** The phone is being asked (no position is handed out until the user answers). */
  z.object({ t: z.literal("location_wait"), req_id: ReqId, via: LocationVia }),
  z.object({ t: z.literal("location"), req_id: ReqId, result: LocationResult }),
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

/**
 * One-line install (Phase 4b): `mcp-remote pair --code <code> <url>` redeems a pairing the signed-in user
 * started in the app (pre-approved). The answer carries the machine token directly, plus the pairing id
 * and poll secret for the claim that follows once the token is saved.
 */
export const PairRedeemRequest = z.object({ code: z.string().min(16).max(40), hostname: z.string().max(128).optional() });
export const PairRedeemResponse = z.object({
  token: z.string(),
  machine_id: MachineId,
  machine_name: z.string(),
  account: z.string(),
  pairing_id: z.string(),
  poll_secret: z.string(),
});
export type PairRedeemResponse = z.infer<typeof PairRedeemResponse>;

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
