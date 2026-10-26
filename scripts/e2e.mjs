#!/usr/bin/env node
// End-to-end test: real `wrangler dev` (workerd + Durable Objects, fully local), dev auth,
// a paired daemon, two shims driven by the MCP SDK client (standing in for Claude Code),
// and phone WebSockets. Run with `npm run e2e` (builds first).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateVapidKeys } from "../worker/scripts/vapid.mjs";

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


/** Minimal raw WebSocket client that can ignore the server's close frame (abuse tests). */
function rawFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const hdr = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([hdr, mask, masked]);
}

function rawWs(base, path, headers) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const s = netConnect(Number(port), hostname);
    const st = { s, buf: Buffer.alloc(0), upgraded: false, frames: [], closed: null, ended: false };
    s.on("data", (d) => {
      st.buf = Buffer.concat([st.buf, d]);
      if (!st.upgraded) {
        const i = st.buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        st.status = Number(st.buf.subarray(0, i).toString().split(" ")[1]);
        st.buf = st.buf.subarray(i + 4);
        st.upgraded = true;
        resolve(st);
      }
      while (st.buf.length >= 2) {
        const op = st.buf[0] & 0x0f;
        let len = st.buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          len = st.buf.readUInt16BE(2);
          off = 4;
        }
        if (st.buf.length < off + len) break;
        const p = st.buf.subarray(off, off + len);
        st.buf = st.buf.subarray(off + len);
        if (op === 8) st.closed = { code: p.length >= 2 ? p.readUInt16BE(0) : 0, reason: p.subarray(2).toString() };
        else st.frames.push(p.toString());
      }
    });
    const end = () => (st.ended = true);
    s.on("end", end);
    s.on("close", end);
    s.on("error", end);
    const h = Object.entries({ Host: `${hostname}:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13", ...headers })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
    s.write(`GET ${path} HTTP/1.1\r\n${h}\r\n\r\n`);
    setTimeout(() => reject(new Error("upgrade timeout")), 5000);
  });
}

async function floodAfterClose(st, ms) {
  let sent = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !st.ended) {
    st.s.write(rawFrame(`x${sent}`));
    if (++sent % 50 === 0) await sleep(5);
  }
  return sent;
}
// ---------------------------------------------------------------------------
// Web Push (Phase 4): a local fake push service and the browser side of RFC 8291.

const subtle = globalThis.crypto.subtle;
const b64u = (b) => Buffer.from(b).toString("base64url");

/** A browser-like push subscription for `endpoint` (real P-256 keys, so payloads can be decrypted). */
async function makePushSub(endpoint) {
  const ua = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPublic = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return { ua, uaPublic, auth, json: { endpoint, expirationTime: null, keys: { p256dh: b64u(uaPublic), auth: b64u(auth) } } };
}

async function decryptPush(sub, body) {
  const hmac = async (k, d) => new Uint8Array(await subtle.sign("HMAC", await subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, sub.ua.privateKey, 256));
  const one = Buffer.from([1]);
  const ikm = await hmac(await hmac(sub.auth, secret), cat(Buffer.from("WebPush: info\0"), sub.uaPublic, asPublic, one));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(Buffer.from("Content-Encoding: aes128gcm\0"), one))).slice(0, 16);
  const iv = (await hmac(prk, cat(Buffer.from("Content-Encoding: nonce\0"), one))).slice(0, 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv }, key, body.subarray(21 + body[20])));
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

async function verifyJwt(jwt, k) {
  const [h, p, sig] = jwt.split(".");
  const key = await subtle.importKey("raw", Buffer.from(k, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(sig, "base64url"), Buffer.from(`${h}.${p}`));
  return ok ? JSON.parse(Buffer.from(p, "base64url").toString()) : null;
}

const toolText = (r) => r?.content?.[0]?.text ?? "";

/** /auth/dev with gating (?gate=1) and an optional invite token: returns the cookies it set. */
async function gatedLogin(base, user, invite) {
  const q = new URLSearchParams({ user, gate: "1", ...(invite ? { invite } : {}) });
  const r = await fetch(`${base}/auth/dev?${q}`, { redirect: "manual" });
  const sc = r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""];
  const pick = (name) => sc.map((c) => new RegExp(`(${name}=[^;]+)`).exec(c)?.[1]).find((v) => v && !v.endsWith("="));
  return { status: r.status, session: pick("__Host-mr_session"), wait: pick("__Host-mr_wait"), body: r.status === 302 ? "" : await r.text() };
}

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
    // ?vis=1: like the PWA, whose page is visible when it connects (Phase 4 push decisions).
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/ws?vis=1`, { headers: { cookie, origin: base } });
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
  // Fake push service (Phase 4): records every push; the answer per request is switchable.
  const pushes = [];
  let pushAnswer = () => 201;
  const pushSrv = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const p = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      pushes.push(p);
      res.writeHead(pushAnswer(p));
      res.end();
    });
  });
  await new Promise((r) => pushSrv.listen(0, "127.0.0.1", r));
  const pushBase = `http://127.0.0.1:${pushSrv.address().port}`;
  children.push({ exitCode: null, signalCode: null, kill: () => pushSrv.close(), pid: 0, output: "" });
  const vapid = await generateVapidKeys();
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
      "--var",
      `VAPID_PUBLIC_KEY:${vapid.publicKey}`,
      "--var",
      `VAPID_PRIVATE_KEY:${vapid.privateKey}`,
      "--var",
      "VAPID_SUBJECT:mailto:e2e@example.com",
      // Only honored with DEV_AUTH=1: lets the Hub push to the local fake push service.
      "--var",
      `PUSH_EXTRA_ORIGINS:${pushBase}`,
      // Phase 4b: open sign-up with a tiny user cap (plain dev sign-ins bypass gating; ?gate=1 ones don't),
      // an owner for the Admin API, and a usage report on every event (default: every 15 min).
      "--var",
      "OPEN_SIGNUP:true",
      "--var",
      "USER_CAP:1",
      "--var",
      "OWNER_EMAILS:owner@dev.local",
      "--var",
      "USAGE_REPORT_MINUTES:0",
      "--show-interactive-dev-session=false",
      "--log-level",
      "info",
    ],
    {
      cwd: join(root, "worker"),
      detached: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
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
  const daemonEnv = {
    ...process.env,
    MCP_REMOTE_CONFIG_DIR: machineDir,
    FAKE_CLAUDE_LOG: fakeLog,
    FAKE_CLAUDE_SHIM_CLI: CLI,
    CLAUDE_CONFIG_DIR: join(tmp, "claude-config"), // where the fake (and the daemon's check) keep transcripts
  };
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

  // --- Phase 4: installable PWA, Web Push, on-demand location, map links ---------------------
  logStep("PWA install assets");
  const man = await (await fetch(`${base}/manifest.webmanifest`)).json();
  const purposes = new Set(man.icons.map((i) => i.purpose));
  check(
    "manifest: standalone, start_url/scope '/', theme colors, icons any + maskable + monochrome",
    man.display === "standalone" && man.start_url === "/" && man.scope === "/" && man.theme_color && man.background_color &&
      ["any", "maskable", "monochrome"].every((x) => purposes.has(x)),
    JSON.stringify(man),
  );
  let badIcon = null;
  for (const i of [...man.icons, { src: "/favicon.ico", type: "image/" }, { src: "/apple-touch-icon.png", type: "image/png" }, { src: "/icons/badge-96.png", type: "image/png" }]) {
    const r = await fetch(`${base}${i.src}`);
    const ct = r.headers.get("content-type") ?? "";
    await r.arrayBuffer();
    if (!r.ok || !ct.startsWith(i.type.split("+")[0])) badIcon = `${i.src}: ${r.status} ${ct}`;
  }
  check("every icon (manifest, favicon.ico, apple-touch-icon, badge) is served with an image type", !badIcon, String(badIcon));
  const swr = await fetch(`${base}/sw.js`);
  const swText = await swr.text();
  check(
    "service worker is served uncached and the CSP allows it (worker-src) and the manifest",
    swr.ok && /no-cache/.test(swr.headers.get("cache-control") ?? "") && /mr-shell-/.test(swText) &&
      /worker-src 'self'/.test(home.headers.get("content-security-policy") ?? "") && /manifest-src 'self'/.test(home.headers.get("content-security-policy") ?? ""),
    `${swr.status} ${swr.headers.get("cache-control")} ${home.headers.get("content-security-policy")}`,
  );

  logStep("Web Push to a local fake push service");
  const me2 = await (await api(base, alice, "/api/me")).json();
  check("/api/me hands the phone the VAPID public key", me2.push_key === vapid.publicKey, JSON.stringify(me2));
  const phoneSub = await makePushSub(`${pushBase}/push/alice-phone`);
  const subR = await api(base, alice, "/api/push/subscribe", { method: "POST", body: JSON.stringify(phoneSub.json) });
  check("the phone registers its push subscription", subR.ok, String(subR.status));
  const ssrf = await api(base, alice, "/api/push/subscribe", { method: "POST", body: JSON.stringify({ ...phoneSub.json, endpoint: "https://evil.example/x" }) });
  check("a subscription for an unknown push service is refused (no SSRF)", ssrf.status === 400, String(ssrf.status));
  // The app tells the Hub which push subscription is its own (no push to it while it is visible).
  const devId = (await subtle.digest("SHA-256", Buffer.from(phoneSub.json.endpoint))).slice(0, 8);
  pa.send({ t: "visibility", visible: true, dev: Buffer.from(devId).toString("hex") });
  await sleep(200);
  const visibleSend = await shimB.client.callTool({ name: "send_message", arguments: { text: "seen in the app", urgency: "normal" } });
  await sleep(300);
  check("while the app is open and visible: no push, and the tool result says why", /app is open/.test(toolText(visibleSend)) && pushes.length === 0, toolText(visibleSend));
  pa.send({ t: "visibility", visible: false });
  await sleep(200);
  const urgentSend = await shimB.client.callTool({
    name: "send_message",
    arguments: { text: "Blocked on the deploy: approve? Directions: https://www.google.com/maps/search/?api=1&query=1%2C2", urgency: "urgent" },
  });
  check("app hidden: send_message reports a push notification to 1 phone", /notification sent to 1 phone/.test(toolText(urgentSend)), toolText(urgentSend));
  const p1 = await waitFor(() => pushes[0], { what: "push at the fake push service" });
  const auth1 = /^vapid t=([^,]+), k=(.+)$/.exec(p1.headers.authorization ?? "");
  const claims = auth1 ? await verifyJwt(auth1[1], auth1[2]) : null;
  check(
    "push request: aes128gcm, Urgency high + TTL for urgent, VAPID JWT for the push service origin signed by our key",
    p1.headers["content-encoding"] === "aes128gcm" && p1.headers.urgency === "high" && p1.headers.ttl === "86400" &&
      auth1?.[2] === vapid.publicKey && claims?.aud === pushBase && claims?.sub === "mailto:e2e@example.com" && claims.exp > Date.now() / 1000,
    JSON.stringify({ h: p1.headers, claims }),
  );
  const pay1 = await decryptPush(phoneSub, p1.body);
  check(
    "the phone can decrypt the payload (RFC 8291): session, urgency, project and a <=100-char preview",
    pay1.k === "m" && pay1.s === "sess-b" && pay1.u === "urgent" && pay1.p === "beta" && pay1.b.startsWith("Blocked on the deploy") && [...pay1.b].length <= 100,
    JSON.stringify(pay1),
  );
  const goneSub = await makePushSub(`${pushBase}/push/gone-phone`);
  await api(base, alice, "/api/push/subscribe", { method: "POST", body: JSON.stringify(goneSub.json) });
  pushAnswer = (p) => (p.url.endsWith("/gone-phone") ? 410 : 201);
  await shimB.client.callTool({ name: "send_message", arguments: { text: "second", urgency: "normal" } });
  const settings1 = await waitFor(() => [...pa.frames].reverse().find((f) => f.t === "settings" && f.settings.push_devices.length === 1), {
    what: "410 subscription removed",
  });
  check("a 410 from the push service deletes that subscription (the phone's list shows 1 device)", pushes.length === 3 && !!settings1, String(pushes.length));
  pushAnswer = () => 201;

  logStep("on-demand location");
  const pushesBefore = pushes.length;
  const locViaPush = shimB.client.callTool({ name: "get_location", arguments: { reason: "e2e: walking directions", max_age_s: 0, timeout_s: 5 } });
  const lp = await waitFor(() => pushes[pushesBefore], { what: "location push" });
  const locPay = await decryptPush(phoneSub, lp.body);
  check(
    "no app open: get_location sends a high-priority 'Claude wants your location' push carrying the request's token",
    lp.headers.urgency === "high" && lp.headers.ttl === "120" && locPay.k === "l" && locPay.s === "sess-b" && /^[\w-]{22}$/.test(locPay.t) && locPay.b === "e2e: walking directions",
    JSON.stringify({ h: lp.headers, locPay }),
  );
  const lt = toolText(await locViaPush);
  check("unanswered within timeout_s: a clear result, no position", /^No answer within 5 s: the phone was sent a notification/.test(lt) && !/\d+\.\d+,\d+\.\d+/.test(lt), lt);
  // The user taps the notification later: the app opens, the Hub lists the request (same token), the app shares once.
  pa.send({ t: "visibility", visible: true });
  pa.send({ t: "location_list" });
  const listed = await waitFor(() => [...pa.frames].reverse().find((f) => f.t === "location_pending" && f.requests.some((r) => r.rid === locPay.r)), { what: "pending list" });
  check("the app's pending list has the tapped request with the notification's token", listed.requests.find((r) => r.rid === locPay.r).tok === locPay.t);
  pa.send({ t: "location", rid: locPay.r, tok: locPay.t, status: "ok", position: { lat: 48.8584, lon: 2.2945, accuracy_m: 9, at: Date.now() } });
  await waitFor(() => pa.frames.find((f) => f.t === "location_done" && f.rid === locPay.r && f.status === "ok"), { what: "location_done" });
  const cached = toolText(await shimB.client.callTool({ name: "get_location", arguments: { reason: "e2e again", max_age_s: 600 } }));
  check("the session that was answered may reuse that position within max_age_s, with its age", /^Location the user shared with this session earlier .*48\.8584,2\.2945 \(accuracy about 9 m\)/.test(cached), cached);
  // Another session never gets it: the user is asked, and "Not now" gives that session nothing.
  const otherSess = shimA2.client.callTool({ name: "get_location", arguments: { reason: "e2e: other session", max_age_s: 86400, timeout_s: 30 } });
  const otherPrompt = await waitFor(() => pa.frames.find((f) => f.t === "location_request" && f.request.reason === "e2e: other session")?.request, { what: "prompt for the other session" });
  pa.send({ t: "location", rid: otherPrompt.rid, tok: otherPrompt.tok, status: "denied" });
  const otherText = toolText(await otherSess);
  check("another session must ask; declined -> no position at all (not the one shared with sess-b)", otherText === "The user declined to share their location.", otherText);
  const nFrames = pa.frames.length;
  pa.send({ t: "location", rid: "made-up", tok: "x".repeat(22), status: "ok", position: { lat: 1, lon: 1, accuracy_m: 1, at: Date.now() } });
  await waitFor(() => pa.frames.slice(nFrames).some((f) => f.t === "error" && /expired or was already answered/.test(f.error)), { what: "unmatched answer refused" });
  check("an answer for an unknown request is refused (nothing stored)", true);
  const locInApp = shimB.client.callTool({ name: "get_location", arguments: { reason: "e2e: where am I", max_age_s: 0, timeout_s: 30 } });
  const prompt = await waitFor(() => pa.frames.find((f) => f.t === "location_request" && f.request.reason === "e2e: where am I")?.request, { what: "in-app location prompt" });
  check("app open: the phone gets an in-app prompt naming the project and reason", prompt.project === "beta" && prompt.session_id === "sess-b", JSON.stringify(prompt));
  pa.send({ t: "location", rid: prompt.rid, tok: prompt.tok, status: "ok", position: { lat: 52.3731, lon: 4.8922, accuracy_m: 15, at: Date.now() } });
  const fresh = toolText(await locInApp);
  check("the user's Share reaches Claude: fresh position, accuracy, age, map link", /^Location shared by the user just now: 52\.3731,4\.8922 \(accuracy about 15 m\).*\nGoogle Maps: https:\/\/www\.google\.com\/maps\/search\//s.test(fresh), fresh);
  check("the prompt is closed on every phone once answered", pa.frames.some((f) => f.t === "location_done" && f.rid === prompt.rid));
  const ml = toolText(await shimB.client.callTool({ name: "map_link", arguments: { destination: "Amsterdam Centraal", mode: "walking", origin_lat: 52.3731, origin_lon: 4.8922 } }));
  check(
    "map_link builds a Google Maps directions link locally",
    ml.startsWith("https://www.google.com/maps/dir/?api=1&destination=Amsterdam%20Centraal&origin=52.3731%2C4.8922&travelmode=walking"),
    ml,
  );
  pa.send({ t: "settings", location: false });
  await waitFor(() => [...pa.frames].reverse().find((f) => f.t === "settings" && f.settings.location === false), { what: "location off" });
  const off = toolText(await shimB.client.callTool({ name: "get_location", arguments: { reason: "e2e off", max_age_s: 86400 } }));
  check("location turned off in Settings: get_location is refused, last-known forgotten", /turned off/.test(off) && !/52\.37/.test(off), off);
  pa.send({ t: "settings", location: true });
  check(
    "positions are never logged (worker and daemon output)",
    !/48\.858|52\.373/.test(wrangler.output + daemon.output + daemonR.output),
  );


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

    logStep("remote launch: 'resume last conversation' fork, stopped before anything was said, then Restart + resume");
    const fk = await op({ t: "launch", project_id: gamma.id, continue: true }, "fork launch");
    const fl = await waitFor(() => fk.ok && mstate().launch.launches.find((l) => l.continued && l.state !== "exited"), { what: "fork launch record" });
    const fid = fl.launch_id;
    await waitFor(() => launchOf(fid)?.state === "running", { timeout: 30_000, what: "fork running" });
    const argvs = () => fakeEvents().filter((e) => e.event === "start" && e.session === fid).map((e) => e.argv);
    const idOf = (a, flag) => a[a.indexOf(flag) + 1];
    const f1 = argvs()[0];
    check("'resume last conversation' forks the folder's conversation under a new id", f1.includes("--continue") && f1.includes("--fork-session") && /^[0-9a-f-]{36}$/.test(idOf(f1, "--session-id")), JSON.stringify(f1));
    await op({ t: "launch_stop", launch_id: fid }, "stop fork");
    await waitFor(() => launchOf(fid)?.state === "exited", { timeout: 15_000, what: "fork stopped" });
    const r1 = await op({ t: "launch_restart", launch_id: fid, continue: true }, "resume unsaved fork");
    await waitFor(() => launchOf(fid)?.state === "running", { timeout: 30_000, what: "re-forked running" });
    const f2 = argvs()[1];
    check(
      "Restart + resume of an unsaved fork forks again (no --resume of a conversation that doesn't exist)",
      r1.ok && f2.includes("--fork-session") && !f2.includes("--resume") && idOf(f2, "--session-id") !== idOf(f1, "--session-id"),
      JSON.stringify(f2),
    );
    pa.send({ t: "send", session_id: fid, text: "now it exists" });
    await waitFor(() => pa.frames.find((f) => f.t === "message" && f.message.text === "echo: now it exists"), { what: "fork echo", timeout: 15_000 });
    await op({ t: "launch_stop", launch_id: fid }, "stop fork 2");
    await waitFor(() => launchOf(fid)?.state === "exited", { timeout: 15_000, what: "fork stopped 2" });
    await op({ t: "launch_restart", launch_id: fid, continue: true }, "resume saved fork");
    await waitFor(() => launchOf(fid)?.state === "running", { timeout: 30_000, what: "resumed fork running" });
    const f3 = argvs()[2];
    check("once the fork was saved, Restart + resume reopens exactly it (--resume <fork id>)", idOf(f3, "--resume") === idOf(f2, "--session-id"), JSON.stringify(f3));
    await op({ t: "launch_stop", launch_id: fid }, "stop fork 3");
    await waitFor(() => launchOf(fid)?.state === "exited", { timeout: 15_000, what: "fork stopped 3" });
  }

  // --- Phase 4b: waitlist, invites, admin, one-line install, disabling an account ------------
  logStep("Phase 4b: sign-up gating, admin, one-line install");
  {
    const owner = await devLogin(base, "owner");
    const meOwner = await (await api(base, owner, "/api/me")).json();
    check("the owner's /api/me says owner (shows the Admin tab)", meOwner.owner === true, JSON.stringify(meOwner));
    const meAlice = await (await api(base, alice, "/api/me")).json();
    check("a non-owner's /api/me says owner: false", meAlice.owner === false, JSON.stringify(meAlice));
    const nonOwner = await api(base, alice, "/api/admin/overview");
    check("a non-owner gets 403 from the admin API", nonOwner.status === 403, String(nonOwner.status));
    const adminPage = await fetch(`${base}/admin`, { redirect: "manual" });
    check("/admin opens the app's Admin view (#/admin)", adminPage.status === 302 && adminPage.headers.get("location") === "/#/admin", String(adminPage.status));

    // Waitlist -> approve -> use. USER_CAP is 1 and several accounts exist already.
    const wl = await gatedLogin(base, "wanda");
    check("over the user cap a new sign-up gets only a waitlist cookie", wl.status === 302 && !!wl.wait && !wl.session, JSON.stringify(wl));
    const wlMe = await fetch(`${base}/api/me`, { headers: { cookie: wl.wait } });
    const wlBody = await wlMe.json();
    check("a waitlisted account sees the waiting status (/api/me 403 waitlisted)", wlMe.status === 403 && wlBody.waitlisted === true && wlBody.email === "wanda@dev.local", JSON.stringify(wlBody));
    const wlState = await fetch(`${base}/api/state`, { headers: { cookie: wl.wait } });
    check("a waitlisted account can't use the API", wlState.status === 401, String(wlState.status));
    const waiting = await (await api(base, owner, "/api/admin/tenants?status=waitlisted")).json();
    check("the owner sees the waitlisted account in Admin", waiting.tenants?.some((t) => t.tid === "dev-wanda" && t.email === "wanda@dev.local"), JSON.stringify(waiting).slice(0, 300));
    const ap = await api(base, owner, "/api/admin/tenants/dev-wanda/approve", { method: "POST", body: "{}" });
    check("the owner approves with one call", ap.ok, String(ap.status));
    const wlMe2 = await fetch(`${base}/api/me`, { headers: { cookie: wl.wait } });
    const wanda = /(__Host-mr_session=[^;]+)/.exec(wlMe2.headers.getSetCookie().join("\n"))?.[1];
    check("after approval the waiting page's /api/me signs the account in", wlMe2.status === 200 && !!wanda && (await wlMe2.json()).approved === true, String(wlMe2.status));

    // One-line install: the signed-in user starts the pairing (charged to the account), the computer redeems it.
    const dl = await (await fetch(`${base}/dl/mcp-remote.json`)).json();
    const tgz = Buffer.from(await (await fetch(`${base}${dl.path}`)).arrayBuffer());
    const tgzPath = join(tmp, dl.file);
    writeFileSync(tgzPath, tgz);
    const listing = execFileSync("tar", ["tzf", tgzPath], { encoding: "utf8" });
    check(
      "the CLI tarball is served as a static asset, version-pinned, sha256 as published, with dist/cli.js",
      dl.file === `mcp-remote-${dl.version}-${dl.sha256.slice(0, 8)}.tgz` && createHash("sha256").update(tgz).digest("hex") === dl.sha256 && /package\/dist\/cli\.js/.test(listing),
      JSON.stringify(dl),
    );
    const ss = await api(base, wanda, "/api/pair/start-signed", { method: "POST", body: "{}" });
    const ssBody = await ss.json();
    check("a signed-in user gets a pre-approved install code", ss.ok && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(ssBody.code) && ssBody.url === base, JSON.stringify(ssBody));
    const wandaDir = join(tmp, "wanda-box");
    const pw = spawnLogged("pair-code", process.execPath, [CLI, "pair", "--code", ssBody.code, base, "--name", "wanda-box"], {
      env: { ...process.env, MCP_REMOTE_CONFIG_DIR: wandaDir },
    });
    await waitFor(() => pw.exitCode !== null, { timeout: 15_000, what: "pair --code" });
    check("`mcp-remote pair --code` pairs without any approval step", pw.exitCode === 0 && /Paired "wanda-box" to wanda@dev\.local/.test(pw.output), pw.output.slice(-300));
    const again = spawnLogged("pair-code2", process.execPath, [CLI, "pair", "--code", ssBody.code, base], { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: join(tmp, "wanda-2") } });
    await waitFor(() => again.exitCode !== null, { timeout: 15_000, what: "second pair --code" });
    check("an install code works once", again.exitCode !== 0 && /unknown or expired code|already used/.test(again.output), again.output.slice(-300));
    const pWanda = await phone(base, wanda);
    const dWanda = spawnLogged("daemon-wanda", process.execPath, [CLI, "daemon"], { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: wandaDir } });
    await waitFor(() => pWanda.state?.machines.find((m) => m.name === "wanda-box")?.online, { timeout: 15_000, what: "wanda's daemon online" });
    check("the approved account uses the service: its computer is online on its phone", true);

    // Invite link sign-up (skips the waitlist; max uses enforced).
    const inv = await (await api(base, owner, "/api/admin/invites", { method: "POST", body: JSON.stringify({ days: 1, max_uses: 1, note: "e2e" }) })).json();
    const token = new URL(inv.invite.link).searchParams.get("invite");
    const invCheck = await (await fetch(`${base}/api/invite?token=${encodeURIComponent(token)}`)).json();
    check("an invite link checks out on the sign-in page", invCheck.valid === true, JSON.stringify(invCheck));
    const iv = await gatedLogin(base, "ivan", token);
    const ivMe = iv.session ? await (await api(base, iv.session, "/api/me")).json() : null;
    check("signing up through an invite link skips the waitlist", !!iv.session && !iv.wait && ivMe?.tenant === "dev-ivan", JSON.stringify(iv));
    const iv2 = await gatedLogin(base, "ines", token);
    check("a used-up invite (max uses 1) falls back to the waitlist", !!iv2.wait && !iv2.session, JSON.stringify(iv2));

    // Admin view numbers (usage reports on every event in this run).
    pa.send({ t: "refresh" });
    await sleep(300);
    pa.send({ t: "refresh" });
    const ov = await waitFor(
      async () => {
        const o = await (await api(base, owner, "/api/admin/overview")).json();
        return o.top?.some((t) => t.tid === "dev-alice" && t.messages > 0) ? o : null;
      },
      { timeout: 10_000, what: "alice in the admin overview" },
    );
    const aliceRow = ov.top.find((t) => t.tid === "dev-alice");
    check(
      "admin overview: today's totals, sign-ups, DAU and top accounts with their emails",
      ov.totals.do_requests > 0 && ov.totals.rows_written > 0 && ov.days[0].signups >= 5 && ov.days[0].dau >= 2 && aliceRow.email === "alice@dev.local" && aliceRow.machines >= 1 && ov.counts.waitlisted >= 1,
      JSON.stringify({ totals: ov.totals, day: ov.days[0], alice: aliceRow, counts: ov.counts }),
    );
    check("admin overview compares against the free plan's daily limits", ov.limits.do_requests === 100000 && ov.level.percent > 0 && ov.level.percent < 50, JSON.stringify(ov.level));

    // Disabling an account: its daemon exits with code 3, its phone is told, its API calls are refused.
    const dis = await api(base, owner, "/api/admin/tenants/dev-wanda/disable", { method: "POST", body: "{}" });
    check("the owner disables an account", dis.ok, String(dis.status));
    await waitFor(() => dWanda.exitCode !== null, { timeout: 15_000, what: "wanda's daemon to exit" });
    check("a disabled account's daemon exits with code 3", dWanda.exitCode === 3, `exit ${dWanda.exitCode}: ${dWanda.output.slice(-300)}`);
    // The Hub closed the phone socket (4403): the client is closing (wrangler dev's proxy may keep TCP open a while).
    await waitFor(() => pWanda.ws.readyState >= WebSocket.CLOSING, { timeout: 5_000, what: "wanda's phone closed" });
    const ph2 = await rawWs(base, "/api/ws", { Cookie: wanda, Origin: base });
    await waitFor(() => ph2.closed || ph2.status !== 101, { what: "disabled phone refused" });
    check("a disabled account's phone is refused with close code 4403 (the app shows 'disabled', no reconnect loop)", ph2.status === 403 || ph2.closed?.code === 4403, JSON.stringify({ status: ph2.status, closed: ph2.closed }));
    ph2.s.destroy();
    const disState = await api(base, wanda, "/api/state");
    check("a disabled account's API calls are refused (403 disabled)", disState.status === 403 && (await disState.json()).disabled === true, String(disState.status));
    const dWanda2 = spawnLogged("daemon-wanda2", process.execPath, [CLI, "daemon"], { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: wandaDir } });
    await waitFor(() => dWanda2.exitCode !== null, { timeout: 15_000, what: "disabled daemon to give up" });
    check("a disabled account's daemon is refused on reconnect (exit 3)", dWanda2.exitCode === 3 && /disabled/.test(dWanda2.output), dWanda2.output.slice(-300));
    const reSign = await gatedLogin(base, "wanda");
    check("a disabled account can't sign in again", reSign.status === 403 && /disabled/.test(reSign.body), JSON.stringify(reSign).slice(0, 300));
    const audit = await (await api(base, owner, "/api/admin/audit")).json();
    check(
      "owner actions are in the audit log",
      ["disable", "invite_create", "approve"].every((a) => audit.audit.some((x) => x.action === a && x.actor === "owner@dev.local")),
      JSON.stringify(audit.audit.map((a) => a.action)),
    );
  }

  // --- per-tenant limits (Phase 3) -----------------------------------------------------------
  logStep("per-tenant rate limits and usage");
  await waitFor(() => sessionOf(pa, "sess-a")?.online, { timeout: 15_000, what: "sess-a online for the limit checks" });
  pa.send({ t: "refresh" });
  const st0 = await waitFor(() => [...pa.frames].reverse().find((f) => f.t === "state" && f.usage), { what: "state with usage" });
  check(
    "phone state carries today's usage for this account (plan, messages, cap)",
    st0.usage.plan === "free" && st0.usage.messages > 0 && st0.usage.message_cap === 500 && st0.usage.day === new Date().toISOString().slice(0, 10),
    JSON.stringify(st0.usage),
  );
  let rlErr = null;
  for (let i = 0; i < 15 && !rlErr; i++) {
    pa.send({ t: "send", session_id: "sess-a", text: `burst ${i}`, client_id: `rl-${i}` });
    rlErr = await waitFor(
      () => pa.frames.find((f) => (f.t === "error" || f.t === "message") && f.client_id === `rl-${i}`),
      { what: `answer to burst ${i}` },
    ).then((f) => (f.t === "error" ? f : null));
  }
  check(
    "a burst of phone messages hits the rate limit with a clear error",
    !!rlErr && /^rate limited: too many messages; try again in \d+s$/.test(rlErr.error) && rlErr.retry_after_s > 0,
    JSON.stringify(rlErr),
  );
  let agentErr = null;
  for (let i = 0; i < 15 && !agentErr; i++) {
    const r = await shimA2.client.callTool({ name: "send_message", arguments: { text: `agent burst ${i}`, urgency: "silent" } });
    if (r.isError) agentErr = r.content?.[0]?.text ?? "";
  }
  check(
    "a burst of agent send_message calls gets 'Message NOT sent: rate limited ... try again in Ns'",
    /^Message NOT sent: rate limited: too many messages from your sessions \(20 per minute\); try again in \d+s$/.test(agentErr ?? ""),
    String(agentErr),
  );

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

  // --- clients that ignore the server's close frame (Phase 3 review round 4) ----------------
  logStep("raw clients ignoring close frames");
  {
    const st = await (await fetch(`${base}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const waitPath = `/api/pair/wait?code=${st.code}&pairing_id=${st.pairing_id}`;
    const auth = { Authorization: `Bearer ${st.poll_secret}` };
    const a = await rawWs(base, waitPath, auth);
    await waitFor(() => a.frames.some((f) => f.includes('"pending"')), { what: "pending on raw wait" });
    a.s.write(rawFrame("junk"));
    await waitFor(() => a.closed, { what: "worker closes the raw wait socket" });
    check("the Worker closes a pairing wait socket on an unexpected frame (1008)", a.closed.code === 1008, JSON.stringify(a.closed));
    const sent = await floodAfterClose(a, 2000);
    logStep(`raw pairing client sent ${sent} frames after the close; its TCP connection ended: ${a.ended}`);
    // A late frame "claimed" on that socket must do nothing: it never reaches the Pairing DO.
    const frank = await devLogin(base, "frank");
    const ap = await api(base, frank, "/api/pair/approve", { method: "POST", body: JSON.stringify({ code: st.code }) });
    if (!a.ended) a.s.write(rawFrame("claimed"));
    await sleep(500);
    const b = await rawWs(base, waitPath, auth);
    await waitFor(() => b.frames.length > 0 || b.closed, { what: "second wait answer" });
    check(
      "frames after the close (even 'claimed') never reach the Pairing DO: the approved token is still waiting",
      ap.ok && b.status === 101 && b.frames.some((f) => f.includes('"approved"')),
      JSON.stringify({ approve: ap.status, status: b.status, frames: b.frames.map((f) => f.slice(0, 30)) }),
    );
    const claimed = await fetch(`${base}/api/pair/claim?code=${st.code}&pairing_id=${st.pairing_id}`, { method: "POST", headers: auth });
    await waitFor(() => b.closed || b.ended, { what: "wait socket closed after claim" });
    check("claiming over HTTP (poll secret) ends the pairing and closes the wait socket", claimed.ok && (b.closed?.code ?? 1000) === 1000, String(claimed.status));
    a.s.destroy();
    b.s.destroy();

    // Hub: a phone that floods into a 4029 close and keeps sending is ignored; the account keeps working.
    const grace = await devLogin(base, "grace");
    const ph = await rawWs(base, "/api/ws", { Cookie: grace, Origin: base });
    await waitFor(() => ph.frames.some((f) => f.includes('"state"')), { what: "raw phone state" });
    for (let i = 0; i < 80 && !ph.closed; i++) ph.s.write(rawFrame('{"t":"refresh"}'));
    await waitFor(() => ph.closed, { what: "4029 for the flooding phone" });
    check("a flooding phone is closed with 4029", ph.closed.code === 4029, JSON.stringify(ph.closed));
    const sentHub = await floodAfterClose(ph, 2000);
    logStep(`raw phone client sent ${sentHub} frames after the 4029; its TCP connection ended: ${ph.ended}`);
    ph.s.destroy();
    const ok = await (await api(base, grace, "/api/state")).json();
    check("the flooded account still answers (frames after the close were dropped)", Array.isArray(ok.sessions), JSON.stringify(ok).slice(0, 200));
  }

  // --- unauthenticated abuse protection (Phase 3) -------------------------------------------
  logStep("pairing-start throttle");
  let throttled = null;
  for (let i = 0; i < 10 && !throttled; i++) {
    const r = await fetch(`${base}/api/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (r.status === 429) throttled = { retry: r.headers.get("retry-after"), body: await r.json() };
    else await r.body?.cancel();
  }
  check(
    "repeated /api/pair/start from one network is throttled (429 + Retry-After + clear text)",
    !!throttled && Number(throttled.retry) > 0 && /^too many pairing attempts from your network; try again in \d+ min$/.test(throttled.body.error),
    JSON.stringify(throttled),
  );
  const pairThrottled = spawnLogged("pair-throttled", process.execPath, [CLI, "pair", base], {
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: join(tmp, "throttled") },
  });
  await waitFor(() => pairThrottled.exitCode !== null, { timeout: 15_000, what: "throttled pair to exit" });
  check(
    "`mcp-remote pair` explains the throttle instead of a raw HTTP error",
    pairThrottled.exitCode !== 0 && /too many pairing attempts from your network; try again in/.test(pairThrottled.output),
    pairThrottled.output.slice(-400),
  );
  const big = await fetch(`${base}/api/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname: "x".repeat(10_000) }),
  });
  check("an oversize pairing request is refused with 413", big.status === 413, String(big.status));

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
