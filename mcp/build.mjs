// Bundles the CLI (and the shared protocol package) into dist/cli.js.
// Runtime npm dependencies stay external and are installed with the package.
import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const outfile = `${here}dist/cli.js`;
await build({
  entryPoints: [`${here}src/cli.ts`],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["ws", "zod", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: "inline",
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
