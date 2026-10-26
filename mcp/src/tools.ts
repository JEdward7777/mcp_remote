// MCP tool definitions of the shim (D17, D19, D14) and the pure helpers behind them (tested directly).
import { z } from "zod";
import {
  type LocationResult,
  type LocationVia,
  MAX_LOCATION_REASON_CHARS,
  MAX_LOCATION_TIMEOUT_S,
  MAX_TEXT_CHARS,
  MapLinkError,
  MessageText,
  type Position,
  TRAVEL_MODES,
  URGENCIES,
  Urgency,
  formatLatLon,
  mapLink,
} from "@mcp-remote/shared";

export const SERVER_NAME = "mcp-remote";

export const INSTRUCTIONS = `This Claude Code session is connected to the user's phone through mcp-remote.

Inbound: messages the user types on their phone arrive as <channel source="${SERVER_NAME}" message_id="..." session_id="..." sent_at="..."> events. Treat each one as a direct message from the user (an instruction or a question). The user is away from the terminal and cannot see your terminal output.

Outbound: the only way to reach the user is the send_message tool. Messaging is discrete and intentional: do NOT narrate progress, do NOT send a message for every step, and do not repeat yourself. Only send a message when it matters to the user: you finished what they asked, you have the answer to their question, or you are blocked.

Pick the urgency deliberately; it decides how the phone notifies the user:
- silent: FYI only; the user does not need to look now (e.g. a minor note or an intermediate result they may want later). Shown in the phone app only: no notification.
- normal: you finished something the user asked for, or you are answering their message. This is the default. The phone shows a notification (unless the app is open, then it appears there).
- urgent: you are blocked or need a decision from the user right now to make progress. A high-priority notification that buzzes and stays until the user dismisses it. Use it sparingly.

When a phone message asks you something, reply with send_message (normal urgency unless you are blocked). Keep messages short and self-contained; they are read on a phone.

Location: get_location asks the user's phone where it is (the user has to agree each time: they tap Share in the app, or open a notification). Only ask when the answer really depends on where the user is (directions, "where am I", something nearby), never routinely and never to track them. Prefer a recent last-known position (max_age_s) over asking again. If the user turned location off or declines, accept it.

Map links: map_link builds a Google Maps link (a pin, or directions; without an origin, Maps starts from wherever the phone is). Put the link in send_message: the phone makes Google Maps links tappable. Other links are shown as plain text, so don't rely on them being clickable.`;

// ---------------------------------------------------------------------------
// Tool list (only advertised when the shim is active)

export const TOOLS = [
  {
    name: "send_message",
    description:
      "Send a message to the user's phone. Use only when it matters (finished a task, answering the user, or blocked). " +
      "urgency: silent = FYI, in-app only (no notification); normal = finished/answer, phone notification (default); " +
      "urgent = blocked or need a decision now, high-priority notification that stays until dismissed.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text, short and self-contained.", maxLength: MAX_TEXT_CHARS },
        urgency: {
          type: "string",
          enum: [...URGENCIES],
          default: "normal",
          description: "silent = FYI, no notification; normal = finished something / answer (notification); urgent = blocked or needs a decision now.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "get_location",
    description:
      "Ask the user's phone for its current location (on demand; the user must agree each time). Only when the answer " +
      "depends on where the user is. Returns coordinates with accuracy and age, or why there is none (declined, " +
      "turned off, no answer in time). A last-known position at most max_age_s old is returned at once without asking.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          maxLength: MAX_LOCATION_REASON_CHARS,
          description: "Shown to the user with the request, e.g. \"to give you walking directions to the station\".",
        },
        max_age_s: {
          type: "integer",
          minimum: 0,
          maximum: 86400,
          default: 300,
          description: "Accept a last-known position up to this old (seconds) instead of asking. 0 = always ask.",
        },
        timeout_s: {
          type: "integer",
          minimum: 5,
          maximum: MAX_LOCATION_TIMEOUT_S,
          default: 60,
          description: "How long to wait for the user to answer.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "map_link",
    description:
      "Build a Google Maps link (no network call): a pin for coordinates or a place/address, or directions to it. " +
      "Directions without an origin start from wherever the phone is when the user opens the link. Include the link in " +
      "send_message; the phone shows Google Maps links as tappable.",
    inputSchema: {
      type: "object",
      properties: {
        destination: { type: "string", maxLength: 200, description: "Place name or address (used when lat/lon are not given)." },
        lat: { type: "number", minimum: -90, maximum: 90 },
        lon: { type: "number", minimum: -180, maximum: 180 },
        directions: { type: "boolean", description: "Directions instead of a pin (implied by origin or mode)." },
        origin: { type: "string", maxLength: 200, description: "Start address/place for directions." },
        origin_lat: { type: "number", minimum: -90, maximum: 90, description: "Start point (e.g. from get_location)." },
        origin_lon: { type: "number", minimum: -180, maximum: 180 },
        mode: { type: "string", enum: [...TRAVEL_MODES] },
      },
      additionalProperties: false,
    },
  },
];

export const SendArgs = z.object({
  text: MessageText,
  urgency: Urgency.default("normal"),
});

export const GetLocationArgs = z.object({
  reason: z.string().trim().min(1, "reason must not be empty").max(MAX_LOCATION_REASON_CHARS),
  max_age_s: z.number().int().min(0).max(86_400).default(300),
  timeout_s: z.number().int().min(5).max(MAX_LOCATION_TIMEOUT_S).default(60),
});

export const MapLinkArgs = z
  .object({
    destination: z.string().max(200).optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    directions: z.boolean().optional(),
    origin: z.string().max(200).optional(),
    origin_lat: z.number().optional(),
    origin_lon: z.number().optional(),
    mode: z.enum(TRAVEL_MODES).optional(),
  })
  .strict();

/** map_link: the URL, or a sentence saying what is wrong. */
export function mapLinkTool(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const a = MapLinkArgs.safeParse(raw ?? {});
  if (!a.success) return { ok: false, error: `invalid arguments: ${a.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}` };
  const v = a.data;
  const hasOrigin = v.origin_lat !== undefined || v.origin_lon !== undefined;
  if (hasOrigin && (v.origin_lat === undefined || v.origin_lon === undefined)) return { ok: false, error: "give both origin_lat and origin_lon" };
  try {
    const url = mapLink({
      destination: v.destination,
      lat: v.lat,
      lon: v.lon,
      directions: v.directions,
      origin: hasOrigin ? { lat: v.origin_lat!, lon: v.origin_lon! } : v.origin,
      mode: v.mode,
    });
    return { ok: true, text: `${url}\n(Put this link in send_message; the phone shows Google Maps links as tappable links.)` };
  } catch (e) {
    return { ok: false, error: e instanceof MapLinkError ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// get_location result text

export function humanAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function describe(p: Position, now: number): string {
  const acc = p.accuracy_m !== null ? ` (accuracy about ${Math.round(p.accuracy_m)} m)` : "";
  const coords = formatLatLon(p);
  return (
    `${coords}${acc}, measured ${new Date(p.at).toISOString()} (${humanAge(now - p.at)} ago).\n` +
    `Google Maps: ${mapLink({ lat: p.lat, lon: p.lon })}`
  );
}

/** The tool result for get_location. `via` = how the phone was asked (if it was). */
export function formatLocation(r: LocationResult, now: number, ctx: { via?: LocationVia | null; timeoutS?: number } = {}): string {
  const lastLine = r.position && r.status !== "ok" ? `\nLast-known location (may be out of date): ${describe(r.position, now)}` : "";
  switch (r.status) {
    case "ok":
      return r.fresh
        ? `Location shared by the user just now: ${describe(r.position!, now)}`
        : `Last-known location (recent enough for max_age_s, the phone was not asked): ${describe(r.position!, now)}`;
    case "denied":
      return `The user declined to share their location.${lastLine}`;
    case "unavailable":
      return `No location: ${r.message ?? "the phone could not get a position"}.${lastLine}`;
    case "disabled":
      return "Location sharing is turned off for this account (phone app > Settings). Don't ask again unless the user brings it up.";
    case "no_device":
      return `Could not ask the phone: ${r.message ?? "no phone can be reached"}.${lastLine}`;
    case "rate_limited":
      return `Not asked: ${r.message ?? "too many location requests"}.${lastLine}`;
    case "timeout": {
      const how =
        ctx.via === "push"
          ? "the phone was sent a notification asking for the location, and it wasn't answered yet"
          : ctx.via === "app"
            ? "the request is showing in the phone app, and the user hasn't answered yet"
            : "the server did not answer";
      return (
        `No answer within ${ctx.timeoutS ?? "the"} s: ${how}. If the user shares it later, get_location with a large enough ` +
        `max_age_s returns it without asking again.${lastLine}`
      );
    }
  }
}
