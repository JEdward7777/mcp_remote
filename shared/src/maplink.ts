/**
 * Google Maps links (D14, Phase 4): built locally from coordinates or a place/address text, with the
 * public "Maps URLs" format (https://www.google.com/maps/search/?api=1&query=... and
 * .../maps/dir/?api=1&destination=...). No API key, no network call: the link is just text the agent
 * puts into a message, and the phone opens it in Google Maps.
 * Kept free of zod and of DOM/node types so the PWA and the shim can both import it.
 */

export const TRAVEL_MODES = ["driving", "walking", "bicycling", "transit"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

export interface LatLon {
  lat: number;
  lon: number;
}

export interface MapLinkInput {
  /** A place name or address ("Rijksmuseum, Amsterdam"). Used when lat/lon are not given. */
  destination?: string | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  /** Directions instead of a pin: from `origin`, or (omitted) from wherever the phone is when it opens. */
  directions?: boolean | undefined;
  /** Start point for directions (e.g. the position get_location returned). */
  origin?: LatLon | string | undefined;
  mode?: TravelMode | undefined;
}

export const MAX_PLACE_CHARS = 200;

export class MapLinkError extends Error {}

function validLat(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
}
function validLon(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;
}

/** "52.373056,4.892222": at most 6 decimals (~0.1 m), no exponent, no trailing zeros. */
export function formatLatLon(p: LatLon): string {
  if (!validLat(p.lat) || !validLon(p.lon)) throw new MapLinkError("latitude must be -90..90 and longitude -180..180");
  const f = (n: number) => {
    const s = (Math.round(n * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  };
  return `${f(p.lat)},${f(p.lon)}`;
}

function place(text: string): string {
  // Control characters never belong in a place name; collapse whitespace (also newlines).
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) throw new MapLinkError("destination must not be empty");
  if (t.length > MAX_PLACE_CHARS) throw new MapLinkError(`destination is too long (max ${MAX_PLACE_CHARS} characters)`);
  return t;
}

function point(i: { lat?: number | undefined; lon?: number | undefined; text?: string | undefined }, what: string): string {
  const hasLat = i.lat !== undefined && i.lat !== null;
  const hasLon = i.lon !== undefined && i.lon !== null;
  if (hasLat || hasLon) {
    if (!hasLat || !hasLon) throw new MapLinkError(`${what}: give both lat and lon`);
    return formatLatLon({ lat: i.lat!, lon: i.lon! });
  }
  if (typeof i.text === "string") return place(i.text);
  throw new MapLinkError(`${what}: give lat and lon, or a place name / address`);
}

/** Builds the link; throws MapLinkError with a sentence a person (or Claude) can act on. */
export function mapLink(i: MapLinkInput): string {
  const dest = point({ lat: i.lat, lon: i.lon, text: i.destination }, "destination");
  if (i.mode !== undefined && !(TRAVEL_MODES as readonly string[]).includes(i.mode)) {
    throw new MapLinkError(`mode must be one of ${TRAVEL_MODES.join(", ")}`);
  }
  const wantsDirections = i.directions ?? (i.origin !== undefined || i.mode !== undefined);
  if (!wantsDirections) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(dest)}`;
  }
  let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  if (i.origin !== undefined) {
    const o = typeof i.origin === "string" ? point({ text: i.origin }, "origin") : point(i.origin, "origin");
    url += `&origin=${encodeURIComponent(o)}`;
  }
  if (i.mode) url += `&travelmode=${i.mode}`;
  return url;
}
