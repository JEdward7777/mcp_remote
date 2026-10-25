// Bundles the PWA (web/app.ts + shared code) into public/app.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

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
