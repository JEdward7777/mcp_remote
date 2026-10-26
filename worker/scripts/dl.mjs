// Packs the mcp-remote CLI (npm pack of ../mcp) into public/dl/ as a static asset, for the app's
// one-line install (Phase 4b, D12): `npm i -g <origin>/dl/mcp-remote-<version>-<sha8>.tgz`.
// The file name pins the version and content (first 8 hex of its sha256); public/dl/mcp-remote.json
// tells the app which file is current and its full sha256 (shown next to the install line).
// npm pack output is deterministic for the same files (fixed mtimes), so rebuilding unchanged code
// gives the same file name.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function buildDl() {
  const here = fileURLToPath(new URL("..", import.meta.url));
  const root = join(here, "..");
  const out = join(here, "public", "dl");
  const tmp = mkdtempSync(join(tmpdir(), "mcpr-pack-"));
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const raw = execFileSync(npm, ["pack", "--json", "--silent", "--pack-destination", tmp, "-w", "mcp"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const info = JSON.parse(raw.slice(raw.indexOf("[")))[0];
    const bytes = readFileSync(join(tmp, info.filename));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = `${info.name}-${info.version}-${sha256.slice(0, 8)}.tgz`;
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, file), bytes);
    const meta = { name: info.name, version: info.version, file, path: `/dl/${file}`, sha256, bytes: bytes.length };
    writeFileSync(join(out, "mcp-remote.json"), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = buildDl();
  console.log(`${m.path} (${m.bytes} bytes, sha256 ${m.sha256})`);
}
