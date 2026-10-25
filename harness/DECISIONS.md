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
