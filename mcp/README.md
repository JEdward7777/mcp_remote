# mcp

`mcp-remote` CLI (Node 22+):

- `mcp-remote pair <worker-url> [--name <n>]` - device pairing; saves `~/.config/mcp-remote/config.json` (0600).
- `mcp-remote daemon` - one per computer; single outbound WebSocket to the Hub, plus a Unix socket
  (`~/.config/mcp-remote/daemon.sock`, 0600; a per-user named pipe on Windows) for shims.
- `mcp-remote shim` - stdio MCP server Claude Code spawns per session. Declares `claude/channel`; phone messages
  become `notifications/claude/channel` events (`meta`: `message_id`, `session_id`, `sent_at`); exposes
  `send_message {text, urgency: silent|normal|urgent}`. Logs go to stderr only.

Env: `MCP_REMOTE_CONFIG_DIR`, `MCP_REMOTE_SOCKET`, `MCP_REMOTE_SESSION_ID`.

Build: `npm run build -w mcp` (bundles `src/` + `@mcp-remote/shared` into `dist/cli.js`). Setup: `../harness/SETUP.md`.
