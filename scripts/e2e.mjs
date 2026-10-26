#!/usr/bin/env node
// End-to-end test: real `wrangler dev` (workerd + Durable Objects, fully local), dev auth,
// a paired daemon, two shims driven by the MCP SDK client (standing in for Claude Code),
// and phone WebSockets. Run with `npm run e2e` (builds first).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(root, "mcp", "dist", "cli.js");
const FAKE_CLAUDE = join(root, "scripts", "fake-claude.mjs");
const TMUX_SOCKET = `mr-e2e-${process.pid}`;
const HAVE_TMUX = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const tmp = mkdtempSync(join(tmpdir(), "mcpr-e2e-"));
const children = [];
const results = [];
let failed = false;
const VERBOSE = process.env.E2E_VERBOSE === "1";

function logStep(msg) {
  process.stdout.write(`  - ${msg}\n`);
}

function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  process.stdout.write(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}\n`);
  if (!cond) failed = true;
  return !!cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 10_000, interval = 50, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function spawnLogged(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  child.output = "";
  const onData = (d) => {
    const s = d.toString();
    child.output += s;
    if (VERBOSE) process.stderr.write(s.replace(/^/gm, `[${name}] `));
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  children.push(child);
  return child;
}

function cleanup() {
  if (HAVE_TMUX) {
    try {
      execFileSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      /* not running */
    }
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid()}`, TMUX_SOCKET), { force: true });
  }
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        if (c.detachedGroup) process.kill(-c.pid, "SIGTERM");
        else c.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

// ---------------------------------------------------------------------------

async function devLogin(base, user) {
  const r = await fetch(`${base}/auth/dev?user=${user}`, { redirect: "manual" });
  const sc = r.headers.get("set-cookie") ?? "";
  const m = /(__Host-mr_session=[^;]+)/.exec(sc);
  if (r.status !== 302 || !m) throw new Error(`dev login failed for ${user}: ${r.status}`);
  return m[1];
}

function api(base, cookie, path, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { cookie, origin: base, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
}

/** A fake phone: WebSocket with the session cookie, recording every frame. */
function phone(base, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { cookie, origin: base } });
    const p = { ws, frames: [], state: null };
    ws.on("message", (d) => {
      const s = d.toString();
      if (s === "pong") return;
      const f = JSON.parse(s);
      p.frames.push(f);
      if (f.t === "state") p.state = f;
      // Like the PWA: launch changes arrive as small per-machine frames between state frames.
      if (f.t === "launches") {
        const m = p.state?.machines.find((x) => x.machine_id === f.machine_id);
        if (m?.launch) m.launch.launches = f.launches;
      }
    });
    ws.once("open", () => resolve(p));
    ws.once("error", reject);
    p.send = (f) => ws.send(JSON.stringify(f));
  });
}

async function startShim(name, configDir, sessionId, cwd) {
  mkdirSync(cwd, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "shim"],
    cwd,
    // Drop CLAUDE_PROJECT_DIR (set when run from inside Claude Code) so the project name comes from cwd.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CLAUDE_PROJECT_DIR")), MCP_REMOTE_CONFIG_DIR: configDir, MCP_REMOTE_SESSION_ID: sessionId },
    stderr: "pipe",
  });
  const shim = { name, notifications: [], stderr: "" };
  transport.stderr?.on("data", (d) => {
    shim.stderr += d.toString();
    if (VERBOSE) process.stderr.write(d.toString().replace(/^/gm, `[${name}] `));
  });
  const client = new Client({ name: "fake-claude-code", version: "0.0.0" }, { capabilities: {} });
  client.fallbackNotificationHandler = async (n) => {
    shim.notifications.push(n);
  };
  await client.connect(transport);
  shim.client = client;
  shim.transport = transport;
  return shim;
}

function sessionOf(p, id) {
  return p.state?.sessions.find((s) => s.session_id === id);
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

  console.log(`e2e: temp dir ${tmp}`);
  logStep(`starting wrangler dev on ${base}`);
  const wrangler = spawnLogged(
    "wrangler",
    process.execPath,
    [
      join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      join(tmp, "state"),
      "--var",
      `SESSION_SECRET:${secret}`,
      "--var",
      "DEV_AUTH:1",
      "--show-interactive-dev-session=false",
      "--log-level",
      "info",
    ],
    {
      cwd: join(root, "worker"),
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1" },
    },
  );
  wrangler.detachedGroup = true;
  await waitFor(() => /Ready on/.test(wrangler.output) || wrangler.exitCode !== null, {
    timeout: 90_000,
    what: "wrangler dev to start",
  });
  if (wrangler.exitCode !== null) throw new Error(`wrangler dev exited:\n${wrangler.output}`);
  await waitFor(async () => (await fetch(`${base}/`).catch(() => null))?.ok, { timeout: 20_000, what: "worker" });
  const home = await fetch(`${base}/`);
  check("wrangler dev serves the PWA", (await home.text()).includes("mcp remote"));
  check(
    "PWA Referrer-Policy keeps Origin on same-origin posts (not no-referrer)",
    home.headers.get("referrer-policy") === "strict-origin-when-cross-origin",
    String(home.headers.get("referrer-policy")),
  );

  // --- auth ---------------------------------------------------------------------------
  const alice = await devLogin(base, "alice");
  const bob = await devLogin(base, "bob");
  const me = await (await api(base, alice, "/api/me")).json();
  check("dev auth issues a session cookie (/api/me)", me.tenant === "dev-alice", JSON.stringify(me));
  check("/api/me without cookie is 401", (await fetch(`${base}/api/me`)).status === 401);
  const carol = await devLogin(base, "carol");
  const lo = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: carol, origin: base, accept: "application/json" } });
  check("logout (fetch, same origin) clears the session cookie", lo.ok && /Max-Age=0/.test(lo.headers.get("set-cookie") ?? ""));
  const loNull = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie: carol, origin: "null" }, redirect: "manual" });
  check("logout with Origin: null is refused", loNull.status === 403);

  // --- pairing ------------------------------------------------------------------------
  const machineDir = join(tmp, "alice-laptop");
  logStep("pairing a daemon");
  const pairProc = spawnLogged("pair", process.execPath, [CLI, "pair", base, "--name", "laptop"], {
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: machineDir },
  });
  const code = await waitFor(() => /Pairing code:\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(pairProc.output)?.[1], {
    timeout: 15_000,
    what: "pairing code",
  });
  check("pair prints a short human-typeable code", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);
  const badApprove = await api(base, alice, "/api/pair/approve", {
    method: "POST",
    body: JSON.stringify({ code }),
    headers: { origin: "https://evil.example" },
  });
  check("pair approval from a foreign Origin is rejected", badApprove.status === 403, String(badApprove.status));
  const approve = await api(base, alice, "/api/pair/approve", { method: "POST", body: JSON.stringify({ code }) });
  const approveBody = await approve.json();
  check("signed-in user approves the code", approve.ok && approveBody.machine?.name === "laptop", JSON.stringify(approveBody));
  const machineId = approveBody.machine?.machine_id;
  const reuse = await api(base, bob, "/api/pair/approve", { method: "POST", body: JSON.stringify({ code }) });
  check("a pairing code cannot be approved twice", reuse.status === 404, String(reuse.status));
  await waitFor(() => pairProc.exitCode !== null, { timeout: 15_000, what: "pair to finish" });
  check("pair command exits 0 after approval", pairProc.exitCode === 0, pairProc.output);
  const cfgStat = statSync(join(machineDir, "config.json"));
  const dirStat = statSync(machineDir);
  check("config.json is mode 0600", (cfgStat.mode & 0o777) === 0o600, (cfgStat.mode & 0o777).toString(8));
  check("config dir is mode 0700", (dirStat.mode & 0o777) === 0o700, (dirStat.mode & 0o777).toString(8));

  // --- daemon + phone -----------------------------------------------------------------
  logStep("starting daemon and phone sockets");
  // Launch settings for the remote-launch part: a fake `claude`, our own tmux server socket.
  const launchRoot = join(tmp, "launch-root");
  mkdirSync(join(launchRoot, "gamma"), { recursive: true });
  writeFileSync(
    join(machineDir, "launch.json"),
    JSON.stringify({ claude_path: FAKE_CLAUDE, tmux_socket: TMUX_SOCKET, startup_timeout_s: 30, permission_mode: "acceptEdits" }),
    { mode: 0o600 },
  );
  const fakeLog = join(tmp, "fake-claude.log");
  const daemonEnv = { ...process.env, MCP_REMOTE_CONFIG_DIR: machineDir, FAKE_CLAUDE_LOG: fakeLog, FAKE_CLAUDE_SHIM_CLI: CLI };
  const daemon = spawnLogged("daemon", process.execPath, [CLI, "daemon"], { env: daemonEnv });
  await waitFor(() => /connected to/.test(daemon.output), { timeout: 15_000, what: "daemon to connect" });
  const sockStat = statSync(join(machineDir, "daemon.sock"));
  check("daemon IPC socket is mode 0600", (sockStat.mode & 0o777) === 0o600, (sockStat.mode & 0o777).toString(8));

  const pa = await phone(base, alice);
  await waitFor(() => pa.state, { what: "alice state" });
  check(
    "phone sees the paired machine online",
    pa.state.machines.some((m) => m.machine_id === machineId && m.online),
    JSON.stringify(pa.state.machines),
  );

  const cswsh = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws`, { headers: { cookie: alice, origin: "https://evil.example" } });
    ws.on("unexpected-response", (_q, res) => resolve(res.statusCode));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => resolve(-1));
  });
  check("phone WebSocket from a foreign Origin is rejected", cswsh === 403, String(cswsh));

  // --- two shims ----------------------------------------------------------------------
  logStep("starting two shims (MCP clients stand in for Claude Code)");
  const shimA = await startShim("shimA", machineDir, "sess-a", join(tmp, "projects", "alpha"));
  const shimB = await startShim("shimB", machineDir, "sess-b", join(tmp, "projects", "beta"));
  const caps = shimA.client.getServerCapabilities();
  check("shim declares experimental claude/channel capability", !!caps?.experimental?.["claude/channel"], JSON.stringify(caps));
  check("shim declares tools capability", !!caps?.tools);
  const instr = shimA.client.getInstructions() ?? "";
  check(
    "shim instructions explain discrete messaging + urgency levels",
    /discrete and intentional/.test(instr) && /silent/.test(instr) && /urgent/.test(instr) && /normal/.test(instr),
  );
  await waitFor(() => /dangerously-load-development-channels/.test(shimA.stderr), { what: "shim channel-flag notice" });
  check("shim prints the --dangerously-load-development-channels reminder on stderr", true);
  const tools = await shimA.client.listTools();
  const sendTool = tools.tools.find((t) => t.name === "send_message");
  check(
    "send_message tool has urgency enum silent|normal|urgent",
    JSON.stringify(sendTool?.inputSchema?.properties?.urgency?.enum) === JSON.stringify(["silent", "normal", "urgent"]),
  );

  await waitFor(() => sessionOf(pa, "sess-a")?.online && sessionOf(pa, "sess-b")?.online, {
    timeout: 10_000,
    what: "both sessions online on the phone",
  });
  const sa = sessionOf(pa, "sess-a");
  const sb = sessionOf(pa, "sess-b");
  check("phone sees both sessions online", sa?.online && sb?.online);
  check(
    "sessions carry project = basename(cwd) and the machine id",
    sa?.project === "alpha" && sb?.project === "beta" && sa?.machine_id === machineId,
    JSON.stringify([sa, sb]),
  );

  // --- phone -> session A only ----------------------------------------------------------
  logStep("phone -> session A");
  pa.send({ t: "send", session_id: "sess-a", text: "hello A, please run the tests", client_id: "c1" });
  const nA = await waitFor(() => shimA.notifications.find((n) => n.method === "notifications/claude/channel"), {
    what: "channel notification at shim A",
  });
  check("shim A receives notifications/claude/channel with the text", nA.params.content === "hello A, please run the tests");
  check(
    "notification meta has message_id + session_id (identifier keys only)",
    nA.params.meta?.session_id === "sess-a" &&
      /^\d+$/.test(nA.params.meta?.message_id ?? "") &&
      Object.keys(nA.params.meta).every((k) => /^[A-Za-z0-9_]+$/.test(k)),
    JSON.stringify(nA.params.meta),
  );
  await waitFor(() => pa.frames.some((f) => f.t === "delivered" && f.session_id === "sess-a"), {
    what: "delivered ack at phone",
  });
  check("phone gets a delivered ack for the message", true);
  await sleep(1000);
  check("shim B does NOT receive session A's message", shimB.notifications.length === 0, JSON.stringify(shimB.notifications));

  // --- session B -> phone, urgent --------------------------------------------------------
  logStep("session B -> phone (urgent)");
  const res = await shimB.client.callTool({
    name: "send_message",
    arguments: { text: "Blocked: migration would drop a column. Proceed?", urgency: "urgent" },
  });
  check("send_message succeeds", !res.isError, JSON.stringify(res));
  const outB = await waitFor(
    () => pa.frames.find((f) => f.t === "message" && f.message.direction === "out" && f.message.session_id === "sess-b"),
    { what: "urgent message at phone" },
  );
  check(
    "phone receives B's message in session B's thread with urgency urgent",
    outB.message.urgency === "urgent" && outB.message.text.startsWith("Blocked:"),
    JSON.stringify(outB),
  );
  const resDefault = await shimA.client.callTool({ name: "send_message", arguments: { text: "Tests pass." } });
  const outA = await waitFor(
    () => pa.frames.find((f) => f.t === "message" && f.message.direction === "out" && f.message.session_id === "sess-a"),
    { what: "default-urgency message" },
  );
  check("urgency defaults to normal", !resDefault.isError && outA.message.urgency === "normal");
  const badUrg = await shimA.client.callTool({ name: "send_message", arguments: { text: "x", urgency: "panic" } });
  check("invalid urgency is rejected by the tool", badUrg.isError === true);

  // history
  pa.send({ t: "history", session_id: "sess-b" });
  const hist = await waitFor(() => pa.frames.find((f) => f.t === "history" && f.session_id === "sess-b"), { what: "history" });
  check("history for session B has only B's messages", hist.messages.length === 1 && hist.messages[0].session_id === "sess-b");

  // --- offline store-and-forward ------------------------------------------------------
  logStep("offline delivery");
  await shimA.client.close();
  await waitFor(() => sessionOf(pa, "sess-a") && !sessionOf(pa, "sess-a").online, { what: "sess-a offline" });
  check("phone sees session A go offline when its shim exits", true);
  pa.send({ t: "send", session_id: "sess-a", text: "queued while offline" });
  await waitFor(() => sessionOf(pa, "sess-a")?.pending_in === 1 || pa.frames.some((f) => f.t === "message" && f.message.text === "queued while offline"), { what: "queued message stored" });
  const shimA2 = await startShim("shimA2", machineDir, "sess-a", join(tmp, "projects", "alpha"));
  const nQ = await waitFor(() => shimA2.notifications.find((n) => n.params?.content === "queued while offline"), {
    what: "queued message delivered on reconnect",
  });
  check("message sent to an offline session is delivered when it reconnects", !!nQ);
  check(
    "already-delivered messages are not re-delivered",
    !shimA2.notifications.some((n) => n.params?.content === "hello A, please run the tests"),
  );

  // --- tenant isolation -----------------------------------------------------------------
  logStep("tenant isolation");
  const pb = await phone(base, bob);
  await waitFor(() => pb.state, { what: "bob state" });
  check("second tenant sees no sessions or machines", pb.state.sessions.length === 0 && pb.state.machines.length === 0, JSON.stringify(pb.state));
  pb.send({ t: "send", session_id: "sess-a", text: "bob tries to inject" });
  const bobErr = await waitFor(() => pb.frames.find((f) => f.t === "error"), { what: "bob error" });
  check("second tenant cannot message the first tenant's session", bobErr.error === "unknown session");
  await sleep(500);
  check("first tenant's shim never sees the other tenant's text", !shimA2.notifications.some((n) => /bob/.test(n.params?.content ?? "")));
  check("first tenant's phone never sees the other tenant's text", !pa.frames.some((f) => f.t === "message" && /bob/.test(f.message.text)));
  const bobRevoke = await api(base, bob, `/api/machines/${machineId}`, { method: "DELETE" });
  check("second tenant cannot revoke the first tenant's machine", bobRevoke.status === 404, String(bobRevoke.status));
  const bobState = await (await api(base, bob, "/api/state")).json();
  check("second tenant /api/state is empty", bobState.sessions.length === 0 && bobState.machines.length === 0);
  const forged = await new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/daemon/ws`, { headers: { authorization: "Bearer mrm1.forged.x.y.z" } });
    ws.on("unexpected-response", (_q, r) => resolve(r.statusCode));
    ws.on("open", () => resolve(101));
    ws.on("error", () => resolve(-1));
  });
  check("forged machine token is rejected", forged === 401, String(forged));

  // --- daemon restart: shims keep running and reconnect -----------------------------------
  logStep("restarting the daemon");
  daemon.kill("SIGTERM");
  await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null, { what: "daemon to stop" });
  await waitFor(() => !sessionOf(pa, "sess-b")?.online, { what: "sess-b offline after daemon stop" });
  check("sessions show offline while the daemon is down", !sessionOf(pa, "sess-a")?.online);
  const down = await shimB.client.callTool({ name: "send_message", arguments: { text: "daemon down?" } });
  check("send_message errors clearly while the daemon is down", down.isError === true && /daemon/.test(down.content?.[0]?.text ?? ""), JSON.stringify(down));
  const daemonR = spawnLogged("daemonR", process.execPath, [CLI, "daemon"], { env: daemonEnv });
  await waitFor(() => sessionOf(pa, "sess-a")?.online && sessionOf(pa, "sess-b")?.online, {
    timeout: 40_000,
    what: "shims to re-register after daemon restart",
  });
  check("shims reconnect to a restarted daemon and sessions come back online", true);
  const again = await shimB.client.callTool({ name: "send_message", arguments: { text: "back online", urgency: "silent" } });
  const outSilent = await waitFor(
    () => pa.frames.find((f) => f.t === "message" && f.message.text === "back online"),
    { what: "silent message at phone" },
  );
  check("send_message works again after reconnect (urgency silent)", !again.isError && outSilent.message.urgency === "silent");


  // --- remote launch (Phase 2) ----------------------------------------------------------
  let liveDaemon = daemonR;
  if (!HAVE_TMUX) {
    check("tmux is available for the remote-launch e2e (install tmux 3.2+)", false);
  } else {
    logStep("remote launch: allowlist a root folder via the CLI (daemon reloads)");
    const add = spawnLogged("projects", process.execPath, [CLI, "projects", "add-root", launchRoot], { env: daemonEnv });
    await waitFor(() => add.exitCode !== null, { what: "projects add-root" });
    check("`mcp-remote projects add-root` notifies the running daemon", /daemon reloaded/.test(add.output), add.output);
    const mstate = () => pa.state.machines.find((m) => m.machine_id === machineId);
    const gamma = await waitFor(() => mstate()?.launch?.projects.find((p) => p.name === "gamma"), { what: "gamma advertised" });
    check("phone sees the allowlisted project with an opaque id", /^p[0-9a-f]{15}$/.test(gamma.id) && mstate().launch.available, JSON.stringify(mstate().launch));
    check("no filesystem path reaches the phone", !JSON.stringify(pa.state.machines).includes(tmp));

    let seq = 0;
    const op = async (frame, what) => {
      const client_id = `L${++seq}`;
      pa.send({ ...frame, machine_id: machineId, client_id });
      return waitFor(() => pa.frames.find((f) => f.t === "launch_result" && f.client_id === client_id), { what, timeout: 20_000 });
    };
    const launchOf = (id) => mstate()?.launch?.launches.find((l) => l.launch_id === id);
    const fakeEvents = () =>
      existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const tmuxHas = (name) => {
      try {
        execFileSync("tmux", ["-L", TMUX_SOCKET, "has-session", "-t", `=${name}`], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    };

    const refused = await op({ t: "launch", project_id: "p000000000000000", continue: false }, "refusal");
    check("launch of a non-allowlisted project id is refused", refused.ok === false && /allowlist/.test(refused.error ?? ""), JSON.stringify(refused));

    logStep("remote launch: start a session from the phone");
    const started = await op({ t: "launch", project_id: gamma.id, continue: false }, "launch result");
    check("phone launch request accepted", started.ok, JSON.stringify(started));
    const L = await waitFor(() => mstate().launch.launches.find((l) => l.project_id === gamma.id), { what: "launch record" });
    const lid = L.launch_id;
    check("launch record links launch id = session id = tmux name mr-<hex>", /^mr-[0-9a-f]{12}$/.test(lid) && L.session_id === lid && tmuxHas(lid), JSON.stringify(L));
    await waitFor(() => launchOf(lid)?.state === "running", { timeout: 30_000, what: "launch running" });
    const sess = await waitFor(() => sessionOf(pa, lid)?.online && sessionOf(pa, lid), { what: "launched session online" });
    check("launched session comes online on the phone, linked by session id, named after the folder", sess.project === "gamma", JSON.stringify(sess));
    const ev = fakeEvents();
    const st0 = ev.find((e) => e.event === "start" && e.session === lid);
    check(
      "fake claude ran in the project dir with the channel flag and permission mode (argv, no shell)",
      st0 && st0.cwd === join(launchRoot, "gamma") &&
        JSON.stringify(st0.argv.slice(0, 4)) === JSON.stringify(["--dangerously-load-development-channels", "server:mcp-remote", "--permission-mode", "acceptEdits"]) &&
        st0.argv[4] === "--session-id",
      JSON.stringify(st0),
    );
    check("daemon answered the development-channels warning with '1'", ev.some((e) => e.event === "dialog_accepted" && e.key === "1" && e.session === lid));
    check("launched session gets MCP_REMOTE_LAUNCH_TOKEN and no inherited CLAUDECODE", st0?.has_token === true && st0?.claudecode === null, JSON.stringify(st0));

    pa.send({ t: "send", session_id: lid, text: "hello launched" });
    const echo = await waitFor(
      () => pa.frames.find((f) => f.t === "message" && f.message.session_id === lid && f.message.text === "echo: hello launched"),
      { what: "echo from launched session", timeout: 15_000 },
    );
    check("phone <-> launched session messaging works end to end", !!echo);

    logStep("remote launch: restart with --continue");
    const rs = await op({ t: "launch_restart", launch_id: lid, continue: true }, "restart result");
    check("restart (resume) accepted", rs.ok, JSON.stringify(rs));
    await waitFor(() => fakeEvents().filter((e) => e.event === "mcp_connected" && e.session === lid).length === 2, { timeout: 30_000, what: "second spawn" });
    await waitFor(() => launchOf(lid)?.state === "running" && sessionOf(pa, lid)?.online, { timeout: 30_000, what: "running after restart" });
    const starts = fakeEvents().filter((e) => e.event === "start" && e.session === lid);
    const conv = starts[0]?.argv[starts[0].argv.indexOf("--session-id") + 1];
    check(
      "fresh start got its own conversation id; resume re-spawned with --resume <that id> under the same session id",
      starts.length === 2 && /^[0-9a-f-]{36}$/.test(conv ?? "") &&
        starts[1].argv.includes("--resume") && starts[1].argv[starts[1].argv.indexOf("--resume") + 1] === conv &&
        !starts[1].argv.includes("--continue") && launchOf(lid).continued,
      JSON.stringify(starts.map((x) => x.argv)),
    );
    check("the old process got SIGHUP from tmux", fakeEvents().some((e) => e.event === "signal" && e.sig === "SIGHUP" && e.pid === starts[0].pid));
    pa.send({ t: "history", session_id: lid });
    const h = await waitFor(() => pa.frames.find((f) => f.t === "history" && f.session_id === lid), { what: "history" });
    check("thread history survives the restart", h.messages.some((m) => m.text === "echo: hello launched"));

    logStep("remote launch: stop");
    const sp = await op({ t: "launch_stop", launch_id: lid }, "stop result");
    await waitFor(() => launchOf(lid)?.state === "exited" && !sessionOf(pa, lid)?.online, { timeout: 15_000, what: "stopped" });
    check("stop ends the tmux session and reports exited (stopped)", sp.ok && !tmuxHas(lid) && launchOf(lid).detail === "stopped from the phone", JSON.stringify(launchOf(lid)));

    logStep("remote launch: fresh restart, then a crash");
    const rf = await op({ t: "launch_restart", launch_id: lid, continue: false }, "fresh restart");
    await waitFor(() => launchOf(lid)?.state === "running" && sessionOf(pa, lid)?.online, { timeout: 30_000, what: "running again" });
    check("restart after stop works (fresh)", rf.ok && !fakeEvents().filter((e) => e.event === "start" && e.session === lid).at(-1).argv.includes("--continue"));
    pa.send({ t: "send", session_id: lid, text: "crash" });
    await waitFor(() => launchOf(lid)?.state === "exited", { timeout: 30_000, what: "exited after crash" });
    check("a crash is reported as exited with the exit code and last output", launchOf(lid).exit_code === 7 && /simulated crash/.test(launchOf(lid).detail ?? ""), JSON.stringify(launchOf(lid)));

    logStep("remote launch: daemon restart re-adopts a running session");
    const again = await op({ t: "launch_restart", launch_id: lid, continue: true }, "restart for re-adopt");
    await waitFor(() => launchOf(lid)?.state === "running", { timeout: 30_000, what: "running before daemon restart" });
    const pidBefore = fakeEvents().filter((e) => e.event === "start" && e.session === lid).at(-1).pid;
    liveDaemon.kill("SIGTERM");
    await waitFor(() => liveDaemon.exitCode !== null || liveDaemon.signalCode !== null, { what: "daemon stopped" });
    check("stopping the daemon leaves the launched tmux session running", again.ok && tmuxHas(lid));
    liveDaemon = spawnLogged("daemonL", process.execPath, [CLI, "daemon"], { env: daemonEnv });
    await waitFor(() => launchOf(lid)?.state === "running" && sessionOf(pa, lid)?.online, { timeout: 45_000, what: "re-adopted" });
    check(
      "new daemon re-adopts it (same process, shim reconnected with its token)",
      fakeEvents().filter((e) => e.event === "start" && e.session === lid).at(-1).pid === pidBefore,
    );
    await op({ t: "launch_stop", launch_id: lid }, "final stop");
    await waitFor(() => launchOf(lid)?.state === "exited", { timeout: 15_000, what: "final stop" });

    logStep("remote launch: claude behind a non-exec wrapper script (like Volta / npm's cli-wrapper)");
    const wrapper = join(tmp, "claude-wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\n# no exec: sh stays the parent of claude\n"${FAKE_CLAUDE}" "$@"\necho "wrapper: claude exited $?"\n`, { mode: 0o755 });
    const setPath = spawnLogged("config", process.execPath, [CLI, "config", "set", "claude-path", wrapper], { env: daemonEnv });
    await waitFor(() => setPath.exitCode !== null, { what: "config set claude-path" });
    const w = await op({ t: "launch", project_id: gamma.id, continue: false }, "wrapped launch");
    const wl = await waitFor(() => w.ok && mstate().launch.launches.find((l) => l.launch_id !== lid && l.project_id === gamma.id), { what: "wrapped launch record" });
    await waitFor(() => launchOf(wl.launch_id)?.state === "running" && sessionOf(pa, wl.launch_id)?.online, { timeout: 30_000, what: "wrapped running" });
    check("a shim behind a non-exec claude wrapper is accepted (launch running, session online)", true);
    pa.send({ t: "send", session_id: wl.launch_id, text: "via wrapper" });
    await waitFor(() => pa.frames.find((f) => f.t === "message" && f.message.text === "echo: via wrapper"), { what: "wrapped echo", timeout: 15_000 });
    check("messaging works through the wrapper", true);
    const ws = await op({ t: "launch_stop", launch_id: wl.launch_id }, "wrapped stop");
    await waitFor(() => launchOf(wl.launch_id)?.state === "exited" && !sessionOf(pa, wl.launch_id)?.online, { timeout: 15_000, what: "wrapped stopped" });
    const wPid = fakeEvents().filter((e) => e.event === "start" && e.session === wl.launch_id).at(-1)?.pid;
    check(
      "stop reaches claude behind the wrapper (SIGHUP via the process group) and ends its tmux session",
      ws.ok && !tmuxHas(wl.launch_id) && fakeEvents().some((e) => e.event === "signal" && e.sig === "SIGHUP" && e.pid === wPid),
    );
  }

  // --- revoke -----------------------------------------------------------------------------
  logStep("revoking the machine");
  const daemonLive = liveDaemon;
  const rv = await api(base, alice, `/api/machines/${machineId}`, { method: "DELETE" });
  check("owner revokes the machine", rv.ok, String(rv.status));
  await waitFor(() => daemonLive.exitCode !== null, { timeout: 10_000, what: "daemon to exit after revoke" });
  check("revoking disconnects the daemon (exit code 3)", daemonLive.exitCode === 3, `exit ${daemonLive.exitCode}`);
  await waitFor(() => pa.state.machines.find((m) => m.machine_id === machineId)?.revoked, { what: "revoked state" });
  check(
    "phone shows machine revoked and its sessions offline",
    pa.state.sessions.filter((s) => s.machine_id === machineId).every((s) => !s.online),
  );
  const after = await shimB.client.callTool({ name: "send_message", arguments: { text: "anyone there?" } });
  const afterText = after.content?.[0]?.text ?? "";
  check("send_message returns a clear error when the daemon is gone", after.isError === true && /NOT sent/.test(afterText), afterText);
  check("shim keeps running while the daemon is down", shimB.transport.pid !== null && (await shimB.client.ping().then(() => true, () => false)));

  const daemon2 = spawnLogged("daemon2", process.execPath, [CLI, "daemon"], {
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: machineDir },
  });
  await waitFor(() => daemon2.exitCode !== null, { timeout: 15_000, what: "revoked daemon to give up" });
  check("a revoked token cannot reconnect", daemon2.exitCode === 3 && /revoked/.test(daemon2.output), daemon2.output.slice(-300));

  await shimA2.client.close();
  await shimB.client.close();
  pa.ws.close();
  pb.ws.close();
}

const timer = setTimeout(() => {
  console.error("e2e: global timeout");
  cleanup();
  process.exit(1);
}, 240_000);

main()
  .catch((e) => {
    failed = true;
    console.error(`\nERROR: ${e.stack ?? e}`);
    for (const c of children) {
      if (c.output) console.error(`--- output of pid ${c.pid} (${c.spawnargs.slice(1, 3).join(" ")}) ---\n${c.output.slice(-3000)}`);
    }
  })
  .finally(() => {
    clearTimeout(timer);
    cleanup();
    const passed = results.filter((r) => r.ok).length;
    console.log(`\ne2e: ${passed}/${results.length} checks passed${failed ? " -- FAILED" : ""}`);
    if (!failed) rmSync(tmp, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
  });
