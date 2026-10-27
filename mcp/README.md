# mcp

`mcp-remote` CLI (Node 22+):

- `mcp-remote pair <worker-url> [--name <n>]` - device pairing; saves `~/.config/mcp-remote/config.json` (0600).
- `mcp-remote pair --code XXXX-XXXX-XXXX-XXXX <worker-url>` - one-line install: redeems a pre-approved code the
  signed-in user got in the app (Machines -> Add a computer); no approval step.
- `mcp-remote daemon` - one per computer; single outbound WebSocket to the Hub, plus a Unix socket
  (`~/.config/mcp-remote/daemon.sock`, 0600; a per-user named pipe on Windows) for shims.
- `mcp-remote shim` - stdio MCP server Claude Code spawns per session. Declares `claude/channel`; phone messages
  become `notifications/claude/channel` events (`meta`: `message_id`, `session_id`, `sent_at`); exposes
  `send_message {text, urgency: silent|normal|urgent}` (silent = in the app only; normal = phone notification;
  urgent = high-priority notification that stays), `get_location {reason, max_age_s?, timeout_s?}` (asks the
  phone; the user confirms each request; returns position + accuracy + age, or why not with no position; a session may reuse only a position shared with it, within max_age_s) and `map_link {destination |
  lat+lon, directions?, origin? | origin_lat+origin_lon, mode?}` (a Google Maps URL, built locally). Logs go to
  stderr only; positions are never logged.

Remote launch (Phase 2, D6/D18):

- `mcp-remote projects list | add <dir> [--name n] | add-root <dir> | remove <dir|name|id>` - the allowlist in
  `launch.json` (0600). The Hub/phone only ever see `{id, name}`; ids are hashes of the real path.
- `mcp-remote config get | modes | set <key> <value> | unset <key>` - `permission-mode`, `claude-path`,
  `extra-args`, `max-sessions`, `auto-restart`, `tmux-path`, `server-name`, `startup-timeout`; Codex:
  `agents`, `default-agent`, `codex-path`, `codex-mode` (read-only | workspace-write | danger-full-access | bypass),
  `codex-extra-args` (allowlisted), `codex-skip-git-check`, `codex-turn-timeout`, `codex-final-message`.
- `mcp-remote projects add <dir> --agent codex` - the project starts Codex unless the phone picks another agent.
- `mcp-remote setup-codex [--force] [--dry-run] [--no-register]` - enable Codex launches; checks `codex` and
  `codex login status`, backs up `config.toml` and runs `codex mcp add mcp-remote -- <node> <cli.js> shim`
  (no-op when already registered).
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

Codex (Phase 5): a Codex launch has no long-running process. The daemon announces the session itself and runs
each batch of phone messages as one turn: `tmux -L mcp-remote new-session ... -- node cli.js run-codex
--status-file <run>/mr-<id>.exit --prompt-file <run>/mr-<id>.prompt -- codex exec [resume] --json [--last]
[-c approval_policy="never"] [-c sandbox_mode=... | --dangerously-bypass-approvals-and-sandbox]
-c mcp_servers.mcp-remote.{command,args,env_vars,enabled,startup_timeout_sec,tool_timeout_sec}=... [extra] -- [<thread>] -`.
`run-codex` feeds the prompt file (0600, deleted once opened) to Codex's stdin, summarises the JSONL events in the
pane, records exit status + thread id + final answer + auth/other errors in the status file, and pings the daemon
(`turn_end` on the socket). The shim Codex starts gets `MCP_REMOTE_SESSION_ID`, `MCP_REMOTE_LAUNCH_TOKEN`,
`MCP_REMOTE_SOCKET`, `MCP_REMOTE_CONFIG_DIR` and `MCP_REMOTE_AGENT=codex` through `env_vars`, registers as that
turn's shim (`register.agent = "codex"`; refused when no turn of that session runs), declares no channel
capability, and offers the same tools. The daemon acks a message when a turn takes it and reports failed turns.

Env: `MCP_REMOTE_CONFIG_DIR`, `MCP_REMOTE_SOCKET`, `MCP_REMOTE_SESSION_ID`, `MCP_REMOTE_LAUNCH_TOKEN` (set by the
daemon for launched sessions), `MCP_REMOTE_FATAL_EXIT_ZERO=1` (exit 0 instead of 3/4/5; used by the launchd agent), `MCP_REMOTE_ACTIVATE=1` (shim
registers even though its parent `claude` was not started with `--dangerously-load-development-channels`; without
it, and without a session id or launch token, the shim stays dormant).

Build: `npm run build -w mcp` (bundles `src/` + `@mcp-remote/shared` into `dist/cli.js`). Setup: `../harness/SETUP.md`.
