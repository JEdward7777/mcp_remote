// Bundles the PWA (web/app.ts + shared code) into public/app.js, and the service worker
// (sw/sw.ts) into public/sw.js with a version hash of every app-shell file it precaches.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDl } from "./scripts/dl.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
await build({
  entryPoints: [`${here}web/app.ts`],
  outfile: `${here}public/app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  logLevel: "warning",
});

/** The app shell: what the app needs to open offline ("/" is index.html). Never /api or /auth. */
export const SHELL = [
  "/",
  "/app.js",
  "/style.css",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/icons/icon-192.png",
  "/icons/badge-96.png",
];
const h = createHash("sha256");
for (const p of SHELL) {
  h.update(p);
  h.update(readFileSync(`${here}public${p === "/" ? "/index.html" : p}`));
}
h.update(readFileSync(`${here}sw/sw.ts`));
const version = h.digest("hex").slice(0, 16);

await build({
  entryPoints: [`${here}sw/sw.ts`],
  outfile: `${here}public/sw.js`,
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: false,
  logLevel: "warning",
  define: { __SW_VERSION__: JSON.stringify(version), __SHELL__: JSON.stringify(SHELL) },
});

// The CLI tarball for the app's one-line install (public/dl/, Phase 4b).
buildDl();
