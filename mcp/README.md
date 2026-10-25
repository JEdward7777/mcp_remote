# mcp

`mcp-remote` CLI (Node 22+):

- `mcp-remote pair <worker-url> [--name <n>]` - device pairing; saves `~/.config/mcp-remote/config.json` (0600).
- `mcp-remote daemon` - one per computer; single outbound WebSocket to the Hub, plus a Unix socket
  (`~/.config/mcp-remote/daemon.sock`, 0600; a per-user named pipe on Windows) for shims.
- `mcp-remote shim` - stdio MCP server Claude Code spawns per session. Declares `claude/channel`; phone messages
  become `notifications/claude/channel` events (`meta`: `message_id`, `session_id`, `sent_at`); exposes
  `send_message {text, urgency: silent|normal|urgent}`. Logs go to stderr only.

Remote launch (Phase 2, D6/D18):

- `mcp-remote projects list | add <dir> [--name n] | add-root <dir> | remove <dir|name|id>` - the allowlist in
  `launch.json` (0600). The Hub/phone only ever see `{id, name}`; ids are hashes of the real path.
- `mcp-remote config get | modes | set <key> <value> | unset <key>` - `permission-mode`, `claude-path`,
  `extra-args`, `max-sessions`, `auto-restart`, `tmux-path`, `server-name`, `startup-timeout`.
- `mcp-remote setup-claude [--scope user|local] [--force] [--dry-run]` - `claude mcp add mcp-remote --scope user -- <node> <cli.js> shim`.
- `mcp-remote attach mr-<id>` - attach to a launched session (`tmux -L mcp-remote attach -t mr-<id>`).
- `mcp-remote install-service [--dry-run] [--no-start]` / `uninstall-service` - systemd user unit / launchd agent.

The daemon runs each launch as `tmux -L mcp-remote new-session -d -s mr-<id> -c <dir> -e MCP_REMOTE_SESSION_ID=mr-<id>
-e MCP_REMOTE_LAUNCH_TOKEN=... -- claude --dangerously-load-development-channels server:mcp-remote [...]` (execFile,
no shell; `remain-on-exit` so the exit status and last output can be read), watches startup with `capture-pane`
for Claude Code's dialogs (answers only the development-channels warning for its own server), and tracks state in
`launches.json` so a restarted daemon re-adopts running sessions.

Env: `MCP_REMOTE_CONFIG_DIR`, `MCP_REMOTE_SOCKET`, `MCP_REMOTE_SESSION_ID`, `MCP_REMOTE_LAUNCH_TOKEN` (set by the
daemon for launched sessions), `MCP_REMOTE_FATAL_EXIT_ZERO=1` (exit 0 instead of 3/4; used by the launchd agent).

Build: `npm run build -w mcp` (bundles `src/` + `@mcp-remote/shared` into `dist/cli.js`). Setup: `../harness/SETUP.md`.
