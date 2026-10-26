import { describe, expect, it } from "vitest";
import { GetLocationArgs, INSTRUCTIONS, TOOLS, formatLocation, humanAge, mapLinkTool } from "../src/tools";

const now = Date.UTC(2026, 9, 26, 12, 0, 0);
const pos = (agoMs: number) => ({ lat: 52.37, lon: 4.89, accuracy_m: 12.4, at: now - agoMs });

describe("shim tools", () => {
  it("instructions tie urgency to notifications and ask for location only when it matters (D17, D19, D14)", () => {
    expect(INSTRUCTIONS).toMatch(/silent:.*no notification/);
    expect(INSTRUCTIONS).toMatch(/urgent:.*high-priority notification/);
    expect(INSTRUCTIONS).toMatch(/Only ask when the answer really depends on where the user is/);
    expect(INSTRUCTIONS).toMatch(/map_link/);
    expect(TOOLS.map((t) => t.name)).toEqual(["send_message", "get_location", "map_link"]);
  });

  it("map_link builds Google Maps links locally and explains bad input", () => {
    const r = mapLinkTool({ destination: "Central Station", mode: "walking", origin_lat: 52.36, origin_lon: 4.88 });
    expect(r).toEqual({
      ok: true,
      text: expect.stringMatching(
        /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=Central%20Station&origin=52\.36%2C4\.88&travelmode=walking\n/,
      ),
    });
    expect(mapLinkTool({ lat: 1, lon: 2 })).toMatchObject({ ok: true, text: expect.stringContaining("/maps/search/?api=1&query=1%2C2") });
    expect(mapLinkTool({ origin_lat: 1, destination: "x" })).toEqual({ ok: false, error: "give both origin_lat and origin_lon" });
    expect(mapLinkTool({ destination: "x", evil: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/invalid arguments/) });
    expect(mapLinkTool({ lat: 100, lon: 0 })).toMatchObject({ ok: false });
    expect(mapLinkTool({})).toMatchObject({ ok: false, error: expect.stringMatching(/lat and lon, or a place/) });
  });

  it("get_location arguments: a reason is required, timeouts are bounded", () => {
    expect(GetLocationArgs.parse({ reason: "directions" })).toEqual({ reason: "directions", max_age_s: 300, timeout_s: 60 });
    expect(GetLocationArgs.safeParse({ reason: "  " }).success).toBe(false);
    expect(GetLocationArgs.safeParse({ reason: "x", timeout_s: 600 }).success).toBe(false);
    expect(GetLocationArgs.safeParse({}).success).toBe(false);
  });

  it("describes every outcome with the age and accuracy of the position", () => {
    expect(humanAge(5_000)).toBe("5 s");
    expect(humanAge(3 * 60_000)).toBe("3 min");
    expect(humanAge(5 * 3600_000)).toBe("5 h");
    const fresh = formatLocation({ status: "ok", position: pos(4000), fresh: true }, now);
    expect(fresh).toMatch(/^Location shared by the user just now: 52\.37,4\.89 \(accuracy about 12 m\), measured 2026-10-26T11:59:56\.000Z \(4 s ago\)\./);
    expect(fresh).toMatch(/Google Maps: https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=52\.37%2C4\.89/);
    expect(formatLocation({ status: "ok", position: pos(120_000), fresh: false }, now)).toMatch(/^Last-known location .*\(2 min ago\)/);
    const t = formatLocation({ status: "timeout", position: pos(2 * 3600_000), fresh: false }, now, { via: "push", timeoutS: 60 });
    expect(t).toMatch(/^No answer within 60 s: the phone was sent a notification/);
    expect(t).toMatch(/Last-known location \(may be out of date\): .*\(2 h ago\)/);
    expect(formatLocation({ status: "timeout", position: null, fresh: false }, now, { via: "app", timeoutS: 30 })).not.toMatch(/Last-known/);
    expect(formatLocation({ status: "denied", position: null, fresh: false }, now)).toBe("The user declined to share their location.");
    expect(formatLocation({ status: "disabled", position: null, fresh: false }, now)).toMatch(/turned off .*Don't ask again/);
    expect(formatLocation({ status: "no_device", position: null, fresh: false, message: "the phone app is not open" }, now)).toBe(
      "Could not ask the phone: the phone app is not open.",
    );
  });
});
