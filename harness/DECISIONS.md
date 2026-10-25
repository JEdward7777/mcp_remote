# Decisions

- D1 (proposed, revised) Topology: phone = custom web page served by the Cloudflare Worker (OAuth there).
  Desktop agent (Claude Code / Codex) is the MCP *client*; our MCP server is a local stdio process the agent spawns.
  That stdio server dials OUT to the Worker over WebSocket (Durable Object relays phone <-> desktop). No inbound ports at home.
- D2 (proposed, revised) Push into the agent: Claude Code via its "channels" feature (MCP server sends channel
  notifications that become new input in the session). Codex fallback: a blocking wait_for_message tool / codex exec per message.
  Push to the phone: the Worker relays live over WebSocket to the page, plus Web Push when the page is closed.
