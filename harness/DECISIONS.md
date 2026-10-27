# Decisions

- D1 (proposed, revised) Topology: phone = custom web page served by the Cloudflare Worker (OAuth there).
  Desktop agent (Claude Code / Codex) is the MCP *client*; our MCP server is a local stdio process the agent spawns.
  That stdio server dials OUT to the Worker over WebSocket (Durable Object relays phone <-> desktop). No inbound ports at home.
- D2 (proposed, revised) Push into the agent: Claude Code via its "channels" feature (MCP server sends channel
  notifications that become new input in the session). Codex fallback: a blocking wait_for_message tool / codex exec per message.
  Push to the phone: the Worker relays live over WebSocket to the page, plus Web Push when the page is closed.
- D3 (proposed) Keep a thin local stdio MCP shim. Verified (code.claude.com/docs/en/channels-reference, 2026-10-25):
  Claude Code channels must be stdio subprocesses; remote HTTP MCP servers cannot push into the session.
  Channels are research preview: custom ones need `claude --dangerously-load-development-channels server:<name>`.
  Bonus: channels can relay tool-permission prompts (`claude/channel/permission`) so approvals can happen from the phone.
  The Worker holds state, OAuth and phone UI; the shim is just a relay. Codex = nice-to-have (Phase 5).
- D4 (proposed) Multi-machine, multi-project routing:
  One per-user "Hub" Durable Object (WebSocket Hibernation, SQLite storage) holds every shim socket and every phone socket.
  Each shim registers as session {machine, project, session_id}; machine = hostname, project = repo folder name.
  Machines authenticate once via a device-pairing flow (shim prints a code, you approve on the phone, it stores a
  long-lived machine token locally). Phone uses OAuth. Hub keeps history so offline sessions still show with their logs.
  Phone page = list of sessions grouped by machine, online/offline dots, one chat thread per session.
- D5 (proposed) Cloudflare free plan only. From memory (UNVERIFIED: developers.cloudflare.com is blocked from this
  session's network): Workers 100k req/day; Durable Objects on free plan with SQLite storage; WebSocket Hibernation
  means idle sockets cost ~nothing; inbound WS messages billed ~20:1 against requests; auto-response pings don't wake the DO.
  Rules: no polling anywhere; hibernatable WebSockets only; ping/pong via setWebSocketAutoResponse; reconnect with
  exponential backoff + jitter; Web Push (free, VAPID) instead of paid services.
- D6 (proposed) One always-on daemon per computer (user service: systemd/launchd/Task Scheduler) holds the single
  WebSocket to the Hub and can launch/relaunch Claude Code sessions in a terminal multiplexer (tmux), since channels need
  an interactive session. Per-session stdio shims talk to the local daemon over localhost, not to Cloudflare directly.
- D7 (proposed, amended by D9) Auth: Google OAuth done directly in the Worker (user has done this before). Authorization-code + PKCE,
  allowlist of the owner's Google account `sub`, then the Worker issues its own signed HttpOnly session cookie.
  No workers-oauth-provider needed: the Worker is not an OAuth server for third-party MCP clients.
  Machines use separate pairing tokens (D4), revocable from the phone.
- D8 (accepted) Language: TypeScript everywhere (worker/, daemon + shim in mcp/), shared message types package.
- D9 (proposed) Multi-tenant from day one. Tenant key = Google `sub`. Each user gets their own Hub Durable Object
  (idFromName(sub)), so data, sockets and history are separated by construction, not by filtering.
  Pairing codes are approved by a signed-in user and mint a machine token bound to that user's `sub`; the Worker
  routes a token only to its own Hub. No code path lists or reads across Hubs. Owner allowlist (D7) becomes a
  sign-up allowlist / invite list. Note: all users share the deployer's free-tier quota.
- D10 (proposed, amended by D12) Growth path: sign-up gating per D12. Each tenant record
  carries a `plan` field and per-tenant rate limits enforced in its Hub, so one user can't exhaust the shared free quota.
  If it gets popular: move to Workers Paid and add billing (e.g. Stripe) keyed on `plan`. No billing code until needed.
- D11 (accepted) Phone = Android. Page is an installable PWA (manifest, service worker, Web Push) with a real favicon
  and app icon set (favicon.svg/.ico, 192/512 PNG, maskable).
- D12 (proposed) Low-friction onboarding: open sign-up with Google, auto-approved until a configurable user cap, then
  a waitlist (owner approves with one tap). Shareable invite links skip the waitlist. After sign-in the page shows one
  copy-paste install line for the daemon with the pairing code pre-filled; the daemon installs itself as a user service.
- D13 (proposed) Popularity/usage monitoring: a global Registry (D1 or a single Durable Object) holds ONLY tenant
  metadata and counters (sign-ups, daily active users, requests per tenant), never message content; this is the one
  sanctioned cross-tenant store (refines D9). Owner-only /admin page in the PWA. Web Push to the owner when daily usage
  passes thresholds (e.g. 50% / 80% of free quota) or sign-ups spike.
- D14 (accepted) Location is on-demand only: the page reports position when open, or the agent sends a push you tap
  to share. Agent gets last-known position + timestamp. No background tracking, no native Android app for now;
  revisit after hands-on use.
- D15 (accepted) Hosting: free `<worker>.<account>.workers.dev` subdomain; no custom domain.
- D16 (accepted) Build order: walking skeleton first, and it must already support multiple concurrent sessions
  (several Claude Code sessions per computer, any number of computers), with a session list on the phone.
  Not aiming for Remote Control parity (see D17); multi-session support is the part we match.
- D17 (accepted) Messaging model: discrete, intentional events in both directions. The agent decides when to message
  the user (reply/notify tools); the user's messages arrive as single channel events. No live activity/transcript feed.
- D18 (accepted) No permission relay for now. User runs sessions in auto-approve mode; the daemon will launch sessions
  in the user's chosen permission mode. Relay (D3 bonus) parked.
- D19 (accepted) Agent-chosen urgency ships in Phase 1: the shim exposes a messaging tool with an urgency level
  (e.g. silent / normal / urgent) and the session instructions tell Claude when each fits. The phone renders it,
  and in Phase 4 urgency maps to Web Push behavior.
- D20 (accepted) Build process = "Ratchet" pipeline (see harness/RATCHET.md). Commits/pushes happen automatically
  (no user approval) at logical moments; the Stop-hook autosync was removed.
- D21 (accepted, made during Phase 1 build) Implementation details: tenant id `g-<sub>`; machine token
  `mrm1.<tenant>.<machine>.<rand>.<hmac>` (HMAC checked at Worker, sha256 stored in Hub); Pairing DO per code,
  8-char code, 10-min TTL, hibernatable wait socket; dev auth needs DEV_AUTH=1 and is refused on *.workers.dev;
  Origin checks on cookie-authenticated writes + phone WS; daemon exit 3 = revoked/not allowed, 4 = token in use
  elsewhere; session id hand-over only from a revoked computer (resync frame on revoke/forget/evict); 50 stored /
  64 live sessions per machine; history capped at 1000 msgs/session (amortized trim, queued inbound never trimmed).
- D22 (accepted, made during Phase 2 build) Launch details: launch.json (0600) allowlist with opaque project ids;
  dedicated tmux server `-L mcp-remote -f /dev/null`, no `-c` (cwd via execFile only); launch id = session id =
  tmux name `mr-<12hex>`; run-claude wrapper records exit status and forwards HUP/TERM; daemon auto-answers ONLY the
  exact dev-channels warning naming server:mcp-remote, only on fresh spawns before shim link, else needs_attention;
  shim dormant unless launched / session id / channels flag / MCP_REMOTE_ACTIVATE; own-shim = pane pid in ancestry +
  remembered parent; fresh = --session-id, resume = --resume, "resume last" = --continue --fork-session --session-id
  with fork_pending until transcript exists; launched env strips only nested-session markers; secrets in daemon-loaded
  0600 service.env (limited syntax); exit codes 3 revoked / 4 duplicate token / 5 unusable settings.
- D23 (accepted, made during Phase 3 build) Limits: all free-plan numbers in worker/src/budget.ts (most UNVERIFIED,
  desk checklist); per-tenant token buckets carried in WS attachments (+ rl_snap row on last close); per-tenant daily
  budgets = share of free limits (free 10%, owner 50%) on requests / rows read / rows written, metered via SQL cursor
  wrapper, refusal until 00:00 UTC; plans via meta.plan, owner via OWNER_EMAILS; machine cap free 10 / owner 30;
  Throttle DO (4 shards) for unauthenticated pair-start, global cap derived from FREE_PLAN; pairing wait socket
  held by the Worker (DO never sees client frames), claim via authenticated POST; DOs never use ws.accept();
  closed sockets' frames dropped before any work; history GC batched, capped at 50% of rows_written.
- D24 (accepted, made during Phase 4 build) Push/location: Web Push sent directly from the Hub (VAPID secrets,
  WebCrypto, allowlisted push hosts, redirect manual), at most 5 devices per account, daily push caps; push only to
  devices not currently showing the app (per-device suppression via subscription id); silent = no push, normal =
  Urgency normal, urgent = Urgency high + requireInteraction; lock-screen preview setting. Location: every share
  needs the user's tap for that session's request (random token per request in loc_req), only `ok` results carry a
  position, a session may reuse only its own last share within max_age_s, last-known kept 6 h, off = deleted.
  Only Google Maps (normalised paths) and geo: links are tappable.
- D25 (accepted, made during Phase 4b build) Onboarding/monitoring: single Registry SQLite DO (not D1) holding only
  account metadata, per-day counters, invites and an audit log; sign-up precedence owner > disabled > allowlist >
  registered > invite > waitlist/deny > OPEN_SIGNUP (false | waitlist | true capped by USER_CAP); cookie carries
  adm (env | reg); Hubs report every 15 min (charged to tenant); guard pauses auto-approval at 80% and lowers free
  share to 5% at 90% for the UTC day; owner alerts at 50%/80%; signed-in pairing with 16-char codes bypasses the
  anonymous global cap; mcp-remote tarball served from /dl with sha256, no pipe-to-shell.
- D26 (accepted, made during Phase 5 build) Codex: opt-in per computer (`agents`), agent per project/launch;
  each phone message batch = one `codex exec [resume <thread>|--last] --json -- … -` turn under run-codex in the
  dedicated tmux server; prompt via 0600 file → stdin only; shim injected per turn via `-c mcp_servers.*` with
  env_vars forwarding and default_tools_approval_mode="approve"; one turn at a time, mid-turn messages batched
  (≤20 msgs / 40k chars); final answer forwarded only if Codex never called send_message; daemon-originated
  messages go through a persisted outbox (≤3/session, paced, at-least-once); `--last` refused when it could
  collide with another Codex session in the same folder; extra args allowlisted.
