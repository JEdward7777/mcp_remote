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

The daemon runs each launch as `tmux -L mcp-remote new-session -d -s mr-<id> -e MCP_REMOTE_SESSION_ID=mr-<id>
-e MCP_REMOTE_LAUNCH_TOKEN=... -- node cli.js run-claude --status-file <config>/run/mr-<id>.exit --
claude --dangerously-load-development-channels server:mcp-remote [...]` (execFile,
no shell; `remain-on-exit` keeps the last output readable; `run-claude` records the exit status because tmux 3.4
sometimes leaves `#{pane_dead_status}` empty, and forwards SIGHUP/SIGTERM to Claude Code). The project folder is the tmux
client's working directory (execFile `cwd`), never a tmux argument, because tmux format-expands `-c` (a folder
named `#(cmd)` would run `cmd`). While a session it just spawned starts up (before its shim has ever connected),
it reads the screen with `capture-pane` to spot Claude Code's dialogs, and answers only the development-channels
warning for its own server, matched by its exact full-screen layout. Re-adopted sessions are never read or typed
into. State is kept in `launches.json` (including pending auto-restarts) so a restarted daemon re-adopts running
sessions.

Env: `MCP_REMOTE_CONFIG_DIR`, `MCP_REMOTE_SOCKET`, `MCP_REMOTE_SESSION_ID`, `MCP_REMOTE_LAUNCH_TOKEN` (set by the
daemon for launched sessions), `MCP_REMOTE_FATAL_EXIT_ZERO=1` (exit 0 instead of 3/4/5; used by the launchd agent), `MCP_REMOTE_ACTIVATE=1` (shim
registers even though its parent `claude` was not started with `--dangerously-load-development-channels`; without
it, and without a session id or launch token, the shim stays dormant).

Build: `npm run build -w mcp` (bundles `src/` + `@mcp-remote/shared` into `dist/cli.js`). Setup: `../harness/SETUP.md`.
