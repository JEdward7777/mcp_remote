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
