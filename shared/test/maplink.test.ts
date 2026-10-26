import { describe, expect, it } from "vitest";
import { MapLinkError, formatLatLon, mapLink } from "../src/maplink";
import { allowedMapHref, linkify } from "../src/links";

describe("mapLink (Google Maps URLs, no key, no network)", () => {
  it("pins coordinates or a place with a search link", () => {
    expect(mapLink({ lat: 52.3730556, lon: 4.8922222 })).toBe("https://www.google.com/maps/search/?api=1&query=52.373056%2C4.892222");
    expect(mapLink({ destination: "Rijksmuseum, Amsterdam" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Rijksmuseum%2C%20Amsterdam",
    );
    expect(formatLatLon({ lat: -0.0000001, lon: 10 })).toBe("0,10");
    expect(formatLatLon({ lat: 1.5, lon: -2 })).toBe("1.5,-2");
  });

  it("builds directions from the given origin (or from wherever the phone is) with a travel mode", () => {
    expect(mapLink({ destination: "Central Station", origin: { lat: 52.36, lon: 4.88 }, mode: "walking" })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=Central%20Station&origin=52.36%2C4.88&travelmode=walking",
    );
    expect(mapLink({ destination: "Zürich HB & more", directions: true })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=Z%C3%BCrich%20HB%20%26%20more",
    );
    expect(mapLink({ lat: 1, lon: 2, origin: "Home street 1" })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=1%2C2&origin=Home%20street%201",
    );
  });

  it("refuses bad input with a clear sentence", () => {
    expect(() => mapLink({ lat: 91, lon: 0 })).toThrow(MapLinkError);
    expect(() => mapLink({ lat: 1 })).toThrow(/both lat and lon/);
    expect(() => mapLink({})).toThrow(/lat and lon, or a place/);
    expect(() => mapLink({ destination: "  \n " })).toThrow(/empty/);
    expect(() => mapLink({ destination: "x".repeat(201) })).toThrow(/too long/);
    expect(() => mapLink({ destination: "x", mode: "teleport" as never })).toThrow(/mode must be/);
    expect(() => mapLink({ lat: Number.NaN, lon: 1 })).toThrow(MapLinkError);
    // Control characters / newlines can't sneak into the URL.
    expect(mapLink({ destination: "a\nb\u0000c" })).toBe("https://www.google.com/maps/search/?api=1&query=a%20b%20c");
  });
});

describe("linkify (which message parts the phone makes tappable)", () => {
  it("makes Google Maps links and geo: URIs tappable, keeping the rest as text", () => {
    const url = mapLink({ destination: "Central Station", mode: "transit" });
    const segs = linkify(`Go here: ${url}. Or geo:52.37,4.89 (pin).`);
    expect(segs).toEqual([
      { text: "Go here: " },
      { text: url, href: url, kind: "map" },
      { text: ". Or " },
      { text: "geo:52.37,4.89", href: "geo:52.37,4.89", kind: "geo" },
      { text: " (pin)." },
    ]);
    expect(linkify("(https://maps.app.goo.gl/AbC123)")).toEqual([
      { text: "(" },
      { text: "https://maps.app.goo.gl/AbC123", href: "https://maps.app.goo.gl/AbC123", kind: "map" },
      { text: ")" },
    ]);
  });

  it("leaves every other link as plain text (no phishing links, no javascript:, no lookalike hosts)", () => {
    for (const t of [
      "https://evil.example/maps",
      "http://www.google.com/maps/search/?api=1&query=x",
      "https://www.google.com.evil.example/maps",
      "https://www.google.com@evil.example/maps",
      "https://www.google.com:443/maps",
      "https://www.google.com/mapsx",
      "https://www.google.com/search?q=x",
      "https://www.google.com\\@evil/maps",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "geo:200,1",
      "geo:1,2;crs=x",
      // Phase 4 review round 1: dot segments must not escape the /maps prefix.
      "https://www.google.com/maps/../amp/s/evil.example/login",
      "https://www.google.com/maps/%2e%2e/url?q=https://evil.example",
      "https://www.google.com/maps/%2E./url?q=x",
      "https://goo.gl/maps/../abc",
      "https://google.com/maps/..\\x",
      "https://www.google.com/maps/./../x",
      "https://www.google.com/maps%2f..%2fx",
    ]) {
      expect(linkify(`see ${t} now`).every((s) => s.href === undefined), t).toBe(true);
      expect(allowedMapHref(t), t).toBeNull();
    }
    expect(linkify("plain text")).toEqual([{ text: "plain text" }]);
    expect(linkify("")).toEqual([]);
  });

  it("emits the parsed URL as the link (what the browser opens is what was checked)", () => {
    expect(allowedMapHref("https://WWW.Google.com/maps/search/?api=1&query=a b")).toBeNull(); // space ends a link anyway
    expect(allowedMapHref("https://WWW.Google.com/maps/place/X")).toEqual({ href: "https://www.google.com/maps/place/X", kind: "map" });
    expect(allowedMapHref("https://maps.app.goo.gl/AbC")).toEqual({ href: "https://maps.app.goo.gl/AbC", kind: "map" });
  });

  it("keeps a closing parenthesis that belongs to the URL", () => {
    const u = "https://www.google.com/maps/search/?api=1&query=Caf%C3%A9%20(old)";
    expect(linkify(`${u}.`)[0]).toEqual({ text: u, href: u, kind: "map" });
  });
});
