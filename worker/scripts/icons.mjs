#!/usr/bin/env node
// Renders the app icons (D11) from ONE source, worker/icons/icon.svg, with no network and no native
// dependency: a tiny SVG-subset parser, an analytic (signed-distance) anti-aliased rasterizer and a
// minimal PNG / ICO encoder on node:zlib. Same input -> same pixels on every machine.
//
//   node scripts/icons.mjs           write public/favicon.svg, favicon.ico, apple-touch-icon.png, icons/*.png
//   node scripts/icons.mjs --check   verify the committed files match the source (pixel-exact; run by `npm test`)
//
// Supported SVG subset (enough for a flat icon; anything else is an error, never silently wrong):
//   <rect x y width height rx>, <circle cx cy r>, <path d> with M/m L/l H/h V/v Z/z (stroked, round
//   caps and joins), <g> attribute inheritance, fill / stroke = none | #rgb | #rrggbb, stroke-width.
//   The element with id="bg" is the background, children of <g id="fg"> are the glyph.
import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SOURCE = join(root, "icons", "icon.svg");
const PUBLIC = join(root, "public");

// ---------------------------------------------------------------------------
// SVG subset

function attrs(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function color(v) {
  if (v === undefined || v === "none") return null;
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  throw new Error(`unsupported color ${v}`);
}

function num(v, name, dflt) {
  if (v === undefined) {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing ${name}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`bad number ${name}=${v}`);
  return n;
}

/** Path data (straight lines only) -> list of segments [x1, y1, x2, y2]. */
function pathSegments(d) {
  const toks = d.match(/[MmLlHhVvZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  if (toks.join("").replace(/\s/g, "").length !== d.replace(/[\s,]/g, "").length) throw new Error(`unsupported path data: ${d}`);
  const segs = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const n = () => {
    const t = toks[i++];
    if (t === undefined || /[A-Za-z]/.test(t)) throw new Error(`path: number expected in ${d}`);
    return Number(t);
  };
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) throw new Error(`path must start with a command: ${d}`);
    const line = (nx, ny) => {
      segs.push([x, y, nx, ny]);
      x = nx;
      y = ny;
    };
    switch (cmd) {
      case "M":
      case "m": {
        const a = n();
        const b = n();
        x = cmd === "m" ? x + a : a;
        y = cmd === "m" ? y + b : b;
        sx = x;
        sy = y;
        cmd = cmd === "m" ? "l" : "L"; // implicit lineto after moveto
        break;
      }
      case "L":
        line(n(), n());
        break;
      case "l": {
        const a = n();
        const b = n();
        line(x + a, y + b);
        break;
      }
      case "H":
        line(n(), y);
        break;
      case "h":
        line(x + n(), y);
        break;
      case "V":
        line(x, n());
        break;
      case "v":
        line(x, y + n());
        break;
      case "Z":
      case "z":
        line(sx, sy);
        cmd = "";
        break;
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return segs;
}

export function parseIcon(svg) {
  const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  if (!vb || vb[1] !== vb[2]) throw new Error("icon.svg needs a square viewBox=\"0 0 N N\"");
  const view = Number(vb[1]);
  const shapes = [];
  const stack = [{}];
  const body = svg.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of body.matchAll(/<(\/?)([a-z]+)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (tag === "svg") continue;
    if (tag === "g") {
      if (close) stack.pop();
      else stack.push({ ...stack[stack.length - 1], ...attrs(rawAttrs), _group: attrs(rawAttrs).id ?? stack[stack.length - 1]._group });
      continue;
    }
    if (close) continue;
    if (!selfClose) throw new Error(`<${tag}> must be self-closing`);
    const own = attrs(rawAttrs);
    const a = { ...stack[stack.length - 1], ...own };
    const role = own.id === "bg" ? "bg" : a._group === "fg" ? "fg" : null;
    if (!role) throw new Error(`<${tag}> is neither #bg nor inside <g id="fg">`);
    if (a["stroke-linecap"] && a["stroke-linecap"] !== "round") throw new Error("only round line caps are supported");
    if (a["stroke-linejoin"] && a["stroke-linejoin"] !== "round") throw new Error("only round line joins are supported");
    const paint = { fill: color(a.fill ?? "#000"), stroke: color(a.stroke), sw: num(a["stroke-width"], "stroke-width", 1) };
    if (tag === "rect") {
      shapes.push({ role, kind: "rect", x: num(a.x, "x", 0), y: num(a.y, "y", 0), w: num(a.width, "width"), h: num(a.height, "height"), rx: num(a.rx, "rx", 0), ...paint });
    } else if (tag === "circle") {
      shapes.push({ role, kind: "circle", cx: num(a.cx, "cx"), cy: num(a.cy, "cy"), r: num(a.r, "r"), ...paint });
    } else if (tag === "path") {
      if (paint.fill) throw new Error("filled paths are not supported (use fill=\"none\")");
      shapes.push({ role, kind: "path", segs: pathSegments(a.d ?? ""), ...paint });
    } else {
      throw new Error(`unsupported element <${tag}>`);
    }
  }
  if (!shapes.some((s) => s.role === "bg")) throw new Error("icon.svg needs a background element with id=\"bg\"");
  return { view, shapes };
}

// ---------------------------------------------------------------------------
// Signed distances (user units; negative inside)

function sdRoundRect(px, py, s) {
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  const r = Math.min(s.rx, s.w / 2, s.h / 2);
  const qx = Math.abs(px - cx) - s.w / 2 + r;
  const qy = Math.abs(py - cy) - s.h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function dSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function distance(s, px, py) {
  if (s.kind === "rect") return sdRoundRect(px, py, s);
  if (s.kind === "circle") return Math.hypot(px - s.cx, py - s.cy) - s.r;
  let d = Infinity;
  for (const seg of s.segs) d = Math.min(d, dSegment(px, py, seg));
  return d;
}

// ---------------------------------------------------------------------------
// Rasterizer: anti-aliased coverage from the distance at the pixel center (pixel units)

const cov = (dPx) => Math.max(0, Math.min(1, 0.5 - dPx));

/**
 * variant: { bg: "shape" | "full" | "none", fgScale, fgColor? }
 *   shape = the background as drawn (rounded), full = full-bleed square (maskable / apple-touch),
 *   none = transparent (monochrome / badge: the glyph only, in fgColor).
 */
export function render(icon, size, variant) {
  const px = new Float64Array(size * size * 4); // premultiplied RGBA
  const k = size / icon.view; // pixels per user unit
  const half = icon.view / 2;
  const over = (i, rgb, a) => {
    if (a <= 0) return;
    const inv = 1 - a;
    px[i] = rgb[0] * a + px[i] * inv;
    px[i + 1] = rgb[1] * a + px[i + 1] * inv;
    px[i + 2] = rgb[2] * a + px[i + 2] * inv;
    px[i + 3] = a + px[i + 3] * inv;
  };
  for (const s of icon.shapes) {
    if (s.role === "bg" && variant.bg === "none") continue;
    const scale = s.role === "fg" ? variant.fgScale : 1;
    const fill = s.role === "fg" && variant.fgColor ? (s.fill ? variant.fgColor : null) : s.fill;
    const stroke = s.role === "fg" && variant.fgColor ? (s.stroke ? variant.fgColor : null) : s.stroke;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (s.role === "bg" && variant.bg === "full") {
          if (fill) over(i, fill, 1);
          continue;
        }
        // Pixel center -> user units (the glyph is scaled about the icon's center).
        const ux = (x + 0.5) / k / scale - half / scale + half;
        const uy = (y + 0.5) / k / scale - half / scale + half;
        const d = distance(s, ux, uy);
        const toPx = k * scale;
        if (fill && s.kind !== "path") over(i, fill, cov(d * toPx));
        if (stroke) over(i, stroke, cov((Math.abs(d) - s.sw / 2) * toPx));
      }
    }
  }
  // Un-premultiply to 8-bit RGBA.
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    out[i + 3] = Math.round(a * 255);
    if (a > 0) for (let c = 0; c < 3; c++) out[i + c] = Math.round(Math.min(1, px[i + c] / a) * 255);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG / ICO

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Raw scanlines (filter byte 0 + RGBA) as PNG stores them before compression. */
function scanlines(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return raw;
}

export function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines(rgba, size), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The uncompressed scanlines of one of OUR PNGs (8-bit RGBA, filter 0), for --check. */
export function pngScanlines(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8;
  const idat = [];
  let size = 0;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") size = data.readUInt32BE(0);
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  return { size, raw: inflateSync(Buffer.concat(idat)) };
}

/** ICO with PNG-compressed entries (supported by every browser that shows favicons). */
export function encodeIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}

function icoEntries(ico) {
  const n = ico.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    out.push(ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outputs

const ANY = { bg: "shape", fgScale: 1 };
/** Android adaptive icons crop to a circle of 80% diameter (the "safe zone"): full-bleed bg, glyph at 80%. */
const MASKABLE = { bg: "full", fgScale: 0.8 };
/** iOS rounds the corners itself and dislikes transparency. */
const APPLE = { bg: "full", fgScale: 0.9 };
/** Status-bar badge / monochrome launcher icon: only the alpha channel counts. */
const MONO = { bg: "none", fgScale: 1.2, fgColor: [1, 1, 1] };

export const OUTPUTS = [
  { file: "icons/icon-192.png", size: 192, variant: ANY },
  { file: "icons/icon-512.png", size: 512, variant: ANY },
  { file: "icons/maskable-192.png", size: 192, variant: MASKABLE },
  { file: "icons/maskable-512.png", size: 512, variant: MASKABLE },
  { file: "icons/monochrome-512.png", size: 512, variant: MONO },
  { file: "icons/badge-96.png", size: 96, variant: MONO },
  { file: "apple-touch-icon.png", size: 180, variant: APPLE },
];
export const ICO_SIZES = [16, 32, 48];

function build() {
  const svg = readFileSync(SOURCE, "utf8");
  const icon = parseIcon(svg);
  const files = new Map();
  files.set("favicon.svg", { kind: "text", data: Buffer.from(svg) });
  for (const o of OUTPUTS) {
    const rgba = render(icon, o.size, o.variant);
    files.set(o.file, { kind: "png", size: o.size, rgba, data: encodePng(rgba, o.size) });
  }
  const ico = ICO_SIZES.map((size) => {
    const rgba = render(icon, size, ANY);
    return { size, rgba, png: encodePng(rgba, size) };
  });
  files.set("favicon.ico", { kind: "ico", entries: ico, data: encodeIco(ico) });
  return files;
}

function check(files) {
  const bad = [];
  for (const [file, f] of files) {
    let have;
    try {
      have = readFileSync(join(PUBLIC, file));
    } catch {
      bad.push(`${file}: missing`);
      continue;
    }
    // Compare pixels, not compressed bytes (zlib versions may compress differently).
    if (f.kind === "text") {
      if (!have.equals(f.data)) bad.push(`${file}: differs from icons/icon.svg`);
    } else if (f.kind === "png") {
      const { size, raw } = pngScanlines(have);
      if (size !== f.size || !raw.equals(scanlines(f.rgba, f.size))) bad.push(`${file}: pixels differ`);
    } else {
      const entries = icoEntries(have);
      if (entries.length !== f.entries.length) bad.push(`${file}: wrong number of sizes`);
      else
        f.entries.forEach((e, i) => {
          const { size, raw } = pngScanlines(Buffer.from(entries[i]));
          if (size !== e.size || !raw.equals(scanlines(e.rgba, e.size))) bad.push(`${file}: ${e.size}px pixels differ`);
        });
    }
  }
  return bad;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const files = build();
  if (process.argv.includes("--check")) {
    const bad = check(files);
    if (bad.length) {
      console.error(`icons are out of date (run \`npm run icons -w worker\`):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`icons: ${files.size} files match icons/icon.svg`);
  } else {
    for (const [file, f] of files) {
      mkdirSync(dirname(join(PUBLIC, file)), { recursive: true });
      writeFileSync(join(PUBLIC, file), f.data);
    }
    console.log(`icons: wrote ${[...files.keys()].join(", ")}`);
  }
}
