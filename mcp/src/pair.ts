// `mcp-remote pair <url>`: device pairing (D4). Prints a short code, waits on a WebSocket
// (no polling) until a signed-in phone approves it, then stores the machine token.
import { hostname } from "node:os";
import WebSocket from "ws";
import { PairResult, PairStartResponse, backoffDelay, parseFrame } from "@mcp-remote/shared";
import { normalizeWorkerUrl, saveConfig, wsUrl } from "./config";
import { log } from "./log";

export interface PairOutcome {
  configPath: string;
  machine_id: string;
  machine_name: string;
  account: string;
}

export async function pair(
  rawUrl: string,
  opts: { name?: string; onCode?: (code: string, url: string) => void } = {},
): Promise<PairOutcome> {
  const url = normalizeWorkerUrl(rawUrl);
  const r = await fetch(`${url}/api/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostname: (opts.name ?? hostname()).slice(0, 128) }),
  });
  if (!r.ok) {
    const body = await r.text();
    let msg = body;
    try {
      msg = (JSON.parse(body) as { error?: string }).error ?? body;
    } catch {
      /* not JSON */
    }
    if (r.status === 429) throw new Error(`the server refused to start pairing: ${msg} (HTTP 429)`);
    throw new Error(`pairing start failed: HTTP ${r.status} ${msg}`);
  }
  const start = PairStartResponse.parse(await r.json());
  if (opts.onCode) opts.onCode(start.code, url);
  else {
    process.stderr.write(
      `\n  Pairing code:  ${start.code}\n\n  On your phone, open ${url} -> Machines, and enter the code.\n  Waiting for approval (expires in ${Math.round((start.expires_at - Date.now()) / 60000)} min)...\n\n`,
    );
  }

  let attempt = 0;
  for (;;) {
    if (Date.now() > start.expires_at) throw new Error("pairing code expired; run `mcp-remote pair` again");
    // The token is saved before the server is told "claimed": if saving fails, the pairing stays
    // unclaimed and its expiry removes the orphan machine.
    let saved: string | null = null;
    const persist = (r: Extract<PairResult, { t: "approved" }>) => {
      saved = saveConfig({
        url,
        token: r.token,
        machine_id: r.machine_id,
        machine_name: r.machine_name,
        account: r.account,
      });
    };
    const result = await waitOnce(url, start, persist);
    if (result === "retry") {
      const d = backoffDelay(attempt++, { baseMs: 1000, capMs: 30_000 });
      await new Promise((res) => setTimeout(res, d));
      continue;
    }
    if (result.t === "expired") throw new Error("pairing code expired; run `mcp-remote pair` again");
    if (result.t === "approved" && saved) {
      return { configPath: saved, machine_id: result.machine_id, machine_name: result.machine_name, account: result.account };
    }
  }
}

/** One WebSocket wait. Resolves with the final result, or "retry" if the socket dropped. */
function waitOnce(
  url: string,
  start: PairStartResponse,
  persist: (r: Extract<PairResult, { t: "approved" }>) => void,
): Promise<PairResult | "retry"> {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl(url, "/api/pair/wait"));
    u.searchParams.set("code", start.code);
    u.searchParams.set("pairing_id", start.pairing_id);
    const ws = new WebSocket(u, { headers: { authorization: `Bearer ${start.poll_secret}` }, handshakeTimeout: 15_000 });
    let done = false;
    const finish = (v: PairResult | "retry") => {
      if (done) return;
      done = true;
      clearInterval(ping);
      resolve(v);
    };
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 30_000);
    ws.on("unexpected-response", (_req, res) => {
      log(`pairing wait refused: HTTP ${res.statusCode}`);
      res.resume();
      ws.terminate();
      finish(res.statusCode === 404 ? { t: "expired" } : "retry");
    });
    ws.on("message", (data) => {
      const text = data.toString();
      if (text === "pong") return;
      const r = parseFrame(PairResult, text);
      if (!r.ok) return;
      if (r.value.t === "pending") return;
      if (r.value.t === "approved") {
        try {
          persist(r.value);
        } catch (e) {
          done = true;
          clearInterval(ping);
          ws.close();
          reject(new Error(`approved, but could not save the config (${e instanceof Error ? e.message : e}); run pair again`));
          return;
        }
        ws.send("claimed");
      }
      setTimeout(() => ws.close(), 200);
      finish(r.value);
    });
    ws.on("error", () => {});
    ws.on("close", () => finish("retry"));
  });
}
