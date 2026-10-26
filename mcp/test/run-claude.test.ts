// The real run-claude wrapper (dist/cli.js, built by `npm test`), started as a process-group leader like
// tmux does: SIGHUP/SIGTERM are passed on once, keyboard-style SIGINT/SIGQUIT are not forwarded.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "mcpr-rc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Child: logs each signal it gets; exits 5 on the 2nd SIGTERM... or after SIGTERM once.
const CHILD = `
const fs = require("fs"); const log = process.argv[1];
for (const s of ["SIGINT", "SIGQUIT", "SIGHUP", "SIGTERM"]) process.on(s, () => {
  fs.appendFileSync(log, s + "\\n");
  if (s === "SIGTERM") setTimeout(() => process.exit(5), 100);
});
fs.appendFileSync(log, "ready\\n");
setInterval(() => {}, 1000);`;

describe.skipIf(process.platform === "win32")("run-claude", () => {
  it("forwards SIGHUP/SIGTERM once and does not forward SIGINT/SIGQUIT (round-4 nit)", async () => {
    const log = join(dir, "sig.log");
    const status = join(dir, "st.exit");
    const w = spawn(process.execPath, [CLI, "run-claude", "--status-file", status, "--", process.execPath, "-e", CHILD, log], {
      detached: true, // own process group, led by the wrapper (as under tmux)
      stdio: "ignore",
      env: { ...process.env, MCP_REMOTE_LAUNCH_TOKEN: "tk" },
    });
    for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("ready")); i++) await sleep(30);
    process.kill(w.pid!, "SIGINT"); // only to the wrapper: must not reach the child
    process.kill(w.pid!, "SIGQUIT");
    await sleep(200);
    process.kill(w.pid!, "SIGHUP");
    await sleep(200);
    process.kill(w.pid!, "SIGTERM");
    const code = await new Promise<number | null>((r) => w.on("exit", (c) => r(c)));
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["ready", "SIGHUP", "SIGTERM"]);
    expect(code).toBe(5);
    expect(JSON.parse(readFileSync(status, "utf8"))).toEqual({ token: "tk", code: 5, signal: null });
  });
});
