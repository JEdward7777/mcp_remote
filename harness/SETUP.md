# Setup (desktop steps)

> **Important:** Claude Code only delivers phone messages into a session started with
> `claude --dangerously-load-development-channels server:mcp-remote` (step 13). Without that flag the shim still
> runs and the phone still shows "handed to session", but Claude Code silently drops the messages. The shim cannot
> detect this, so it prints a reminder on stderr at startup.

Everything below is done once on your desktop, except step 8 (phone) and steps 9-14 (per computer).
Free Cloudflare plan only; the app is served from `https://mcp-remote.<your-subdomain>.workers.dev` (D15).

## 0. Prerequisites

- Node.js 22+ and npm, git.
- A Cloudflare account (free plan) and a Google account.
- Clone the repo and install: `npm ci` (use `npm ci`, not `npm install`; see README note on npm 10).

## 1. Log in to Cloudflare

```sh
cd worker
npx wrangler login
```

## 2. First deploy (to learn your workers.dev URL)

```sh
npx wrangler deploy
```

Wrangler prints the URL, e.g. `https://mcp-remote.<your-subdomain>.workers.dev`. Call it `$URL` below.
The site will answer "SESSION_SECRET is not configured" until step 5; that is expected.
(If this is your first Worker, wrangler/the dashboard asks you to pick a workers.dev subdomain first.)

## 3. Create the Google OAuth client

In <https://console.cloud.google.com/>:

1. Create (or pick) a project.
2. **APIs & Services -> OAuth consent screen** (Google Auth Platform -> Branding/Audience): user type
   **External**, app name e.g. "mcp remote", your support email. Scopes: `openid`, `email`, `profile`
   (non-sensitive, no verification needed). While in **Testing** mode, add every Google account that should be
   able to sign in under **Test users** (or publish the app).
3. **Credentials -> Create credentials -> OAuth client ID -> Web application**:
   - Authorized JavaScript origins: `$URL`
   - Authorized redirect URIs: `$URL/auth/callback`
4. Copy the **Client ID** and **Client secret**.

## 4. Decide who may sign up

Phase 1 gating is minimal (waitlist/caps come in Phase 4b):
- default: only the emails in `ALLOWED_EMAILS` (comma-separated, verified Google emails);
- or set `"OPEN_SIGNUP": "true"` in `worker/wrangler.jsonc` to let any verified Google account in.

## 5. Set secrets

```sh
cd worker
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET   # >= 32 chars; signs cookies + machine tokens
npx wrangler secret put GOOGLE_CLIENT_ID                           # paste the client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET                       # paste the client secret
npx wrangler secret put ALLOWED_EMAILS                             # e.g. you@gmail.com,friend@gmail.com
```

Gating is re-checked on every request: removing an email from `ALLOWED_EMAILS` (or setting `OPEN_SIGNUP` back to
`false`) signs that person out immediately and refuses their daemons the next time they connect (an already open
daemon socket stays up until it reconnects; revoke the machine to cut it at once).

Optional: `GOOGLE_REDIRECT_URI` (only if you serve from a different URL than the request origin).
**Never** set `DEV_AUTH` on the deployed Worker (it only belongs in `worker/.dev.vars`; the code also refuses it on
`*.workers.dev`). Rotating `SESSION_SECRET` signs everyone out and invalidates every machine token: re-pair every computer, then
revoke each computer's **old** entry on the phone (Machines). The old entries still count as active computers, so
until they are revoked they keep holding their session ids and a fixed `MCP_REMOTE_SESSION_ID` is refused.

## 6. Deploy

```sh
npx wrangler deploy     # runs the PWA build (build-web.mjs) automatically
```

## 7. Check

Open `$URL` on the desktop browser, sign in with Google; you should see an empty session list.

## 8. Phone

Open `$URL` in Chrome on Android, sign in, then menu -> **Add to Home screen** (installs the PWA).

## 9. Install the CLI on each computer

From the repo:

```sh
cd mcp
npm pack                         # builds dist/ and creates mcp-remote-0.1.0.tgz
npm install -g ./mcp-remote-0.1.0.tgz
mcp-remote --help
```

## 10. Pair the computer

```sh
mcp-remote pair $URL             # optional: --name "work laptop"
```

It prints a code like `K7QX-M2RP`. On the phone: **Machines -> Pair a computer**, enter the code, **Approve**.
The CLI prints `Paired "<name>" to <your email>` and saves `~/.config/mcp-remote/config.json` (mode 0600, dir 0700).
Check that the email it prints is yours. Codes expire after 10 minutes.
If you pair a computer again (new token), revoke its previous entry under Machines; the phone flags an older
entry with the same name as "older duplicate?".

## 11. Run the daemon as a user service

```sh
mcp-remote install-service          # --dry-run prints the file instead; --no-start only writes it
```

- **Linux**: writes `~/.config/systemd/user/mcp-remote.service` with absolute paths to node and the CLI (systemd's
  minimal PATH can't find an nvm/fnm/volta node), your current `PATH` (so `claude` and `tmux` are found),
  `Restart=on-failure`, `RestartPreventExitStatus=3 4 5` and `KillMode=process`, then runs
  `systemctl --user daemon-reload`, `systemctl --user enable mcp-remote` and `systemctl --user restart mcp-remote`
  (restart, so re-running `install-service` after a node or mcp-remote upgrade moves a running daemon onto the new
  paths; launched sessions keep running and are re-adopted; `--no-start` skips these).
  Logs: `journalctl --user -u mcp-remote -f`. For an always-on desktop that you are not logged in to:
  `loginctl enable-linger $USER`. Re-run `install-service` after upgrading node (the path changes).
- **macOS**: writes `~/Library/LaunchAgents/com.mcp-remote.daemon.plist` (RunAtLoad, `KeepAlive` with
  `SuccessfulExit=false`, `AbandonProcessGroup`) and loads it with `launchctl bootstrap gui/$(id -u)`.
  Logs: `~/Library/Logs/mcp-remote.log`. launchd can't be told "don't restart on exit 3/4/5", so the agent sets
  `MCP_REMOTE_FATAL_EXIT_ZERO=1`: the daemon then exits 0 in those cases (after logging why) and launchd leaves it
  stopped. Limit: it is started again at your next login, logs the same reason and exits again.
- **Windows**: prints Task Scheduler steps (no installer). Remote launch needs tmux, so it is only available when
  the daemon runs inside WSL.

`mcp-remote uninstall-service` removes it. Without a service, `mcp-remote daemon` in a terminal works too.

Environment: the unit/plist carries `PATH`, and `CLAUDE_CONFIG_DIR` / `MCP_REMOTE_CONFIG_DIR` if you have them set
when you run `install-service` (so launched sessions find the same Claude Code login and shim registration as
your shell). Run `install-service` from the shell you use Claude Code in. **Secrets and shell-only settings do not
belong in the unit/plist** (they are world-readable files): put them in `~/.config/mcp-remote/service.env`, which
`install-service` creates empty with mode 0600 and the daemon reads at startup on every platform. Syntax:
`KEY=value` or `export KEY=value`, one per line; `#` starts a comment (also after an unquoted value);
`'single quotes'` are literal; `"double quotes"` and unquoted values expand `$VAR` / `${VAR}` from the daemon's
environment and earlier lines (so `PATH="$HOME/.local/bin:$PATH"` works); no other shell syntax (`$(...)`,
backslashes, `${VAR:-default}`, an unquoted `~`: write `$HOME` instead) — such lines are skipped with a warning
naming the key. `HOME`, `XDG_CONFIG_HOME`, `APPDATA`,
`USERPROFILE`, `MCP_REMOTE_CONFIG_DIR` and `MCP_REMOTE_SOCKET` are ignored there (they would move the config dir
the daemon already read). The file must be a regular file you own (not a symlink); a looser mode is tightened to
0600. E.g. `CLAUDE_CODE_OAUTH_TOKEN=...` (from `claude setup-token`, the usual login for an always-on
machine), `CLAUDE_CODE_USE_BEDROCK=1` / `AWS_PROFILE=...`, `CLAUDE_CODE_USE_VERTEX=1`, `HTTPS_PROXY=...`.
Restart the service after editing it. Already-running launched sessions keep their environment, and the dedicated
tmux server keeps the one it started with until it exits (it does when no launched session is left, or
`tmux -L mcp-remote kill-server`). Launched sessions get the daemon's whole environment except the markers of a
Claude Code session the daemon may itself have been started from (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_SSE_PORT`, session ids).

Exit codes: 3 = the machine was revoked or the account is no longer allowed (pair again); 4 = another computer runs a
daemon with the same token (e.g. a copied `~/.config/mcp-remote`: pair each computer separately, never copy
`config.json`); 5 = the daemon's own settings are unusable (no or invalid `config.json`, or a `service.env` that is a
symlink, not yours, or can't be made 0600; the log says which). Restarting can't help in any of these cases, which
is why the service files above don't (`RestartPreventExitStatus=3 4 5`; under launchd the daemon exits 0 instead).
A unit written by an older `install-service` only lists `3 4`: run `mcp-remote install-service` again. Other exits
(crash, network) are restarted; the daemon also reconnects with backoff on its own. Stopping or restarting the
service does **not** end Claude Code sessions launched from the phone: they live in a separate tmux server and the
next daemon re-adopts them.

## 12. Register the shim with Claude Code

```sh
mcp-remote setup-claude             # runs: claude mcp add mcp-remote --scope user -- <node> <cli.js> shim
```

(`--dry-run` prints the command, `--force` replaces an existing `mcp-remote` entry, `--scope local` registers it for
the current folder only.) User scope makes the shim available in every project **without** Claude Code's
"New MCP server found in this project" approval prompt, which a project `.mcp.json` entry triggers and which would
block a session launched from the phone (its highlighted default is "Continue without using this MCP server").
So don't also list `mcp-remote` in a project's `.mcp.json`. (If a project does have it there, pre-approve it with
`"enabledMcpjsonServers": ["mcp-remote"]` in that project's `.claude/settings.local.json`.)

Manual equivalent, or a per-project `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-remote": { "command": "mcp-remote", "args": ["shim"] }
  }
}
```

Each shim registers a session named after the project folder (basename of `CLAUDE_PROJECT_DIR`, which Claude Code sets, else of the cwd) with a random session id.
It only does so in a session that can receive phone messages: one launched from the phone, one with
`MCP_REMOTE_SESSION_ID` set, or one whose `claude` process was started with `--dangerously-load-development-channels`
(the shim checks its parent's command line). In `claude -p`, `claude mcp list` or a session without the flag it
stays dormant (logged on stderr; `send_message` explains why), so those don't show up on the phone or push real
threads out of the 50-session limit. `MCP_REMOTE_ACTIVATE=1` forces registration (e.g. on Windows, where the
parent can't be inspected it registers anyway).
Sessions started from the phone (step 14) get their id from the daemon automatically. For sessions you start
yourself at the desk, to keep a stable id (and thread) across restarts, set `MCP_REMOTE_SESSION_ID` **per project
and per computer**, never in a committed `.mcp.json` and never at user scope (user scope would give every project on
the computer the same id). Run this once inside each project, using `<computer>-<project>` as the id:

```sh
cd ~/code/myproject
claude mcp add -e MCP_REMOTE_SESSION_ID=laptop-myproject --scope local mcp-remote -- mcp-remote shim
```

Argument order matters: `-e` takes any number of `KEY=value` values, so anything right after it is read as another
variable. Put another option (here `--scope local`) between `-e ...` and the server name, or put the name first
(`claude mcp add mcp-remote -e MCP_REMOTE_SESSION_ID=... --scope local -- mcp-remote shim`). Writing
`--scope local -e MCP_REMOTE_SESSION_ID=... mcp-remote -- ...` fails with "Invalid environment variable format".

(`--scope local` is private to you and this project directory.) Only **one live session** can use an id at a time:
a second concurrent Claude Code session in the same project with the same id is refused by the daemon, and its
`send_message` says "another live session on this computer already uses session id ...". If you want several
concurrent sessions in one project, don't set a fixed id for that project: every launch then gets its own random id.
Two active computers announcing the same id is refused too: the second one's `send_message` fails with "already
used by another computer on this account", and the phone keeps showing the first.
The only hand-over is from a **revoked** computer: after you revoke a computer and pair its replacement, the new one
takes the id over together with its history (the Hub tells the other daemons to re-announce, no polling).

Offline sessions can be removed from the phone (open the thread -> Forget); each computer keeps at most 50 sessions,
and the least recently active offline ones are pruned automatically.

## 13. Launch Claude Code with the channel (at the desk)

```sh
claude --dangerously-load-development-channels server:mcp-remote
```

**Do not skip the flag**: it is what makes Claude Code register the shim as a channel. Accept the development-channel warning ("I am using this for local development") and, for a `.mcp.json` server, the "New MCP server found"
prompt. Channels need an interactive session; `-p` / Agent SDK mode ignores the flag. Run it in the permission
mode you want the session to use while you are away (D18: no permission relay yet).

On the phone the session appears under your computer with a green dot. Send it a message; Claude receives it as
a `<channel source="mcp-remote" ...>` event and answers with `send_message` (silent / normal / urgent).

## 14. Start sessions from the phone (remote launch)

Needs **tmux 3.2+** on the computer (`tmux -V`; `apt install tmux` / `brew install tmux`) and Claude Code logged in.

1. Allow folders (only these can be started; the phone sees folder names and opaque ids, never paths):

   ```sh
   mcp-remote projects add ~/code/myproject        # one folder (--name to rename it)
   mcp-remote projects add-root ~/code             # every non-hidden sub-folder of ~/code, one level deep
   mcp-remote projects list                        # what the phone can start, plus warnings
   mcp-remote projects remove ~/code/myproject
   ```

2. Pick the permission mode the sessions run in (passed as `--permission-mode`; `mcp-remote config modes` lists them):

   ```sh
   mcp-remote config set permission-mode acceptEdits
   ```

   `acceptEdits` (edits run without asking, other commands still prompt), `auto` (everything runs, Claude Code's
   safety classifier blocks risky actions; needs a supported model, otherwise Claude Code silently falls back to
   Manual), `bypassPermissions` (no checks at all; isolated machines only, refused when running as root),
   `dontAsk`, `plan`, `default`/`manual`. Unset (`config unset permission-mode`) passes no flag. Prompts can't be
   answered from the phone yet (D18), so a session in a prompting mode waits for you at the desk.
   Other settings: `config set claude-path <path>`, `config set extra-args --model opus` (everything after the key,
   as separate arguments), `config set max-sessions 4`, `config set auto-restart on` (default for the phone's
   toggle). All of it lives in `~/.config/mcp-remote/launch.json` (0600); the running daemon re-reads it.

3. One-time desk steps so an unattended start doesn't stop at a dialog Claude Code shows on first use
   (verified with Claude Code 2.1.310; order: trust -> MCP approval -> bypass warning -> development channels):
   - **Workspace trust**: run `claude` once in each allowed folder, or once in the root folder (trust covers
     sub-folders), and choose "Yes, I trust this folder". `projects list` flags folders Claude Code hasn't trusted.
   - **MCP approval**: use `mcp-remote setup-claude` (step 12) instead of `.mcp.json`.
   - **Bypass permissions** (only if you chose it): accept the warning once at the desk; Claude Code then stores
     `skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`.
   - **Development channels warning**: shown on every start; the daemon answers it (it sends `1`) only when it is
     the expected warning listing exactly `server:mcp-remote`. Nothing else is ever answered automatically.

On the phone, each computer has a **Start session** picker (with "resume last conversation": the folder's most
recent conversation, continued as a fork under a new id the daemon picks, `--continue --fork-session --session-id <uuid>`,
so later resumes reopen exactly that fork; and
"auto-restart on crash"). A launched session shows its state: *starting*, *running*, **needs you at the desk**
(with what to do, e.g. a trust prompt), *exited* (with the exit code and Claude Code's last line) or *failed*.
Buttons: **Stop**, **Restart** (new conversation), **Restart + resume** (this launch's own conversation:
each fresh start passes `--session-id <uuid>` and resuming passes `--resume <uuid>`, so another session's
conversation in the same folder is never picked; launches recorded by an older version resume like "resume last
conversation" once and are exact from then on), and **Remove** for ended ones. Limit: if you run `/clear` in a
launched session at the desk, Claude Code continues under a new conversation id the daemon doesn't know, so a
later **Restart + resume** reopens the conversation from before `/clear` (use **Restart** for a fresh one).
`--continue`, `--resume`, `--session-id`, `--fork-session`, `--from-pr` and the short `-c` / `-r` (also inside
clusters like `-cr`, `-pc`, `-rabc`; read the way Claude Code's parser does, so `-nrobot` or `-dc`, which are a
name and a debug filter, are fine) are refused in `extra-args`, since the daemon chooses the conversation. If a
long option's value looks like one of them, write it as `--option=value`. Launched sessions
appear in the session list like any other (badge "launched") and keep their thread across restarts.

At the desk, `mcp-remote attach mr-<id>` opens a launched session's terminal (detach with `Ctrl-b d`); they run on
a dedicated tmux server: `tmux -L mcp-remote ls`. Each runs
`claude --dangerously-load-development-channels server:mcp-remote [--permission-mode X] [extra args]` plus one of
`--session-id <new uuid>` (fresh), `--resume <uuid>` (resume this launch's saved conversation) or
`--continue --fork-session --session-id <new uuid>` ("resume last conversation", or resuming a fork Claude Code
hasn't saved yet: it saves a conversation only once something was said, so the daemon checks for its transcript
under `~/.claude/projects/` first)
in the project folder (under a small `mcp-remote run-claude` wrapper that records its exit code, which tmux
sometimes loses), with `MCP_REMOTE_SESSION_ID` and a per-start `MCP_REMOTE_LAUNCH_TOKEN` in its environment
so the shim it starts is linked to the launch. The daemon only reads a session's screen (and only answers the
development-channels warning) right after it started it, before its shim connects; sessions it re-adopts after a
restart are never typed into. Auto-restart (off by default) restarts a crashed session (non-zero
exit) with growing delays, resuming the conversation, and gives up after 5 crashes in a row (a run longer than
10 minutes resets the count); a clean exit or **Stop** is never restarted.

## Limits and the free plan (Phase 3)

Everyone who signs up shares the deployer's free Cloudflare quota (D9), so every account gets its own limits,
enforced in its own Hub (D10), and the endpoints anyone on the internet can call are throttled before they
can wake Durable Objects. All numbers live in `worker/src/budget.ts`; the assumed Cloudflare free-plan numbers
there are mostly **unverified** (see the checklist below).

### Per-account daily budget (the real bound)

Per-minute limits alone don't bound a day (a rate x 1440 minutes is a lot), so each account also has a
**daily budget** on what actually costs quota, as a share of each free daily limit (default **10%**):

| Counted (per UTC day) | Free plan budget at 10% | Owner plan at 50% |
| --- | --- | --- |
| Requests: connects + API calls + inbound WebSocket frames / 20 | 10,000 | 50,000 |
| Database rows read by the account's Hub | 500,000 | 2,500,000 |
| Database rows written by the account's Hub | 10,000 | 50,000 |

The Hub counts the rows of every statement it runs (no extra queries). Once any of these is used up, the
account's Hub refuses work until 00:00 UTC: phone requests get "this account's daily budget is used up
(database rows written: 10000 of 10000 per UTC day, 10% of the free plan's daily limit, "free" plan); it
resets at 00:00 UTC, in 5 h", the daemon is disconnected with close 4029 and waits until midnight (its
sessions show offline, and Claude's `send_message` says "... the server refused this account for now (daily
budget used up); the daemon reconnects in 5 h"), API calls and daemon connects get HTTP 429 with
`Retry-After`. A phone can still connect, at most 5 times in a burst and 6 per hour (`LIMIT_BLOCKED_CONNECTS`),
and gets only the reason (no machine or session list, so no database reads); further connects are closed with
4029. While blocked, nothing more is written for the account. Tune with `TENANT_DAILY_SHARE_PERCENT` (1-100,
free plan) and `OWNER_DAILY_SHARE_PERCENT` (owner plan).

Exhausting the shared free quota takes accounts whose shares add up to 100%: ten free accounts at 10% each, or
the owner (50%) plus five free accounts. Ordinary use needs a fraction of a share: a message round trip writes
about 6-8 rows, so the free plan's 500 messages a day use about 3,500 of its 10,000 rows written.

Computers per account are capped too (free: 10, owner: 30; `MAX_MACHINES` for the free plan): this also bounds
what any single request can cost (a session list reads at most 10 computers x 50 sessions). Pairing an 11th
computer is refused with "this account already has 10 computers (the "free" plan allows 10); revoke one under
Machines first (a revoked computer still counts while it has sessions: Forget them)". Forgetting a session (or
the automatic eviction of old ones) deletes up to ~1,050 history rows in one go and may overshoot the daily
budget by that much once; that is accepted, since it is bounded per session and sessions per account are capped.

### Plans: `free` and `owner`

Each account record carries a `plan` (Hub `meta` row, `free` by default); it selects all limits. The `owner`
plan is for the deployer: per-minute limits about 2-3x higher, 5,000 messages/day, 30 computers and a 50% daily budget, so
a runaway loop in your own sessions still can't take the whole quota. To get it for your account(s) without a
code change, list the Google email(s):

```sh
npx wrangler secret put OWNER_EMAILS        # e.g. you@gmail.com (comma-separated, case-insensitive)
```

The `LIMIT_*` / `DAILY_MESSAGE_CAP` / `TENANT_DAILY_SHARE_PERCENT` env vars only change the `free` plan.
Billing is parked (D10).

### Per-minute limits (plan `free`)

A limit is a token bucket: `burst` requests at once, refilled continuously at the given rate. They stop
bursts and loops; the daily budget above bounds the day.

| What | Default | Env var | Over the limit |
| --- | --- | --- | --- |
| Phone messages | `10,20/min` | `LIMIT_PHONE_SEND` | phone: "rate limited: too many messages; try again in 3s" (the text stays in the box) |
| Agent `send_message` (all sessions together) | `10,20/min` | `LIMIT_AGENT_SEND` | tool result: "Message NOT sent: rate limited: too many messages from your sessions (20 per minute); try again in 3s" |
| Messages per UTC day (phone + agent) | `500` | `DAILY_MESSAGE_CAP` | "daily message limit reached (500 messages per day on the "free" plan, ...); it resets at 00:00 UTC, in 5 h" |
| Start / stop / restart / remove from the phone | `20,20/min` | `LIMIT_LAUNCH` | "rate limited: too many start/stop requests; try again in ..." |
| History pages (up to 200 rows read each, charged to the daily rows-read budget) | `20,20/min` | `LIMIT_HISTORY` | "rate limited: too many history requests; ..." |
| Any phone frame | `60,60/min` | `LIMIT_PHONE_FRAMES` | socket closed with code 4029; the PWA waits the hinted time (at least 60 s) |
| Any daemon frame (all computers together) | `200,120/min` | `LIMIT_DAEMON_FRAMES` | socket closed with 4029; the daemon waits the hinted time |
| WebSocket connects (phones + daemons) | `20,10/min` | `LIMIT_CONNECTS` | phone: close 4029; daemon: HTTP 429 + `Retry-After` |
| `/api/state`, `/api/machines`, `/api/usage`, revoke | `30,30/min` | `LIMIT_HTTP` | HTTP 429 + `Retry-After` |
| Pairing approvals (right or wrong code) | `5,10/h` | `LIMIT_PAIR_APPROVE` | HTTP 429 "too many pairing approvals on this account; try again in N min" |

Why 500 messages/day: a message costs about 1/20 of a request (inbound WebSocket frame), a few SQLite rows
written (message row, its index entries, the session counter, the delivery ack) and a broadcast, so 500
messages fit well inside the account's 10,000 rows-written budget alongside connects and session changes.

Session announcements only write when something changed: a repeated `session_up` for a session that is
already online, a `session_down` for one already offline, or a reconnect `hello` with the same sessions write
nothing; a session really flapping up/down costs about one row per change (bounded by the daily budget).

### Unauthenticated endpoints (per client IP; IPv6 by /64)

| Endpoint | Default | Env var | How |
| --- | --- | --- | --- |
| `POST /api/pair/start` | `5,10/h` per IP | `LIMIT_PAIR_START_IP` | `Throttle` Durable Object (4 shards, persisted) |
| `POST /api/pair/start` per IPv6 /48 | `15,30/h` | `LIMIT_PAIR_START_IP48` | same call (one site rotating through its /64s) |
| `POST /api/pair/start`, everyone together | `20,52/h` | `LIMIT_PAIR_START_GLOBAL` | split evenly over the 4 shards (5 burst, 13/h each) |
| `/api/pair/wait` | `30,120/h` per IP | `LIMIT_PAIR_WAIT_IP` | isolate memory only (best effort, free) |
| `/auth/login`, `/auth/callback` | `30,120/h` per IP | `LIMIT_AUTH_IP` | isolate memory only (they never touch a Durable Object) |
| Approve attempts on one pairing code | 5 | - | the code locks: "run `mcp-remote pair` on the computer again" |

The global default is derived in `budget.ts`: pairing starts from everyone together may use 10% of the free
plan's daily rows written, at an estimated 8 rows per start (Throttle row, Pairing DO state + alarm, wipe at
expiry; ~7 measured locally), i.e. 52 per hour. The Throttle table has no secondary index (it would double every
write); refilled buckets are deleted by a bounded scan of 64 keys every 32 writes.

Why a Durable Object for `/api/pair/start` only: each start creates a Pairing Durable Object (a write, an alarm
and a wipe 10 minutes later, ~3 DO requests); the throttle check costs one DO request and writes a row only
when the start is allowed, and a refusal is then remembered in the Worker's memory, so a client that keeps
trying is mostly turned away without touching any Durable Object. For `/api/pair/wait` and `/auth/*` a DO check
would cost as much as what it protects, so those use free per-isolate memory. Bodies over 4 KiB are refused
(413) from `Content-Length`, or after reading 4 KiB of a chunked body, before anything else runs; malformed
pairing waits (bad code, id or secret format) are refused (400) by the Worker without waking the Pairing DO.
`CF-Connecting-IP` is set by Cloudflare and cannot be forged by the client there (locally under
`wrangler dev` every request shares one key).

Optional: the [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
exists in the installed wrangler (`ratelimits` in `wrangler.jsonc`, periods 10 or 60 s), but whether it is
available on the free plan could not be checked. If it is, add it in front of the Throttle DO (it is consulted
first; the Throttle DO still runs):

```jsonc
"ratelimits": [
  { "name": "PAIR_START_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }
]
```

### Tuning

Set any of the env vars as a plain var, e.g. in `worker/wrangler.jsonc` under `"vars"`
(`"LIMIT_PHONE_SEND": "20,40/min"`, `"DAILY_MESSAGE_CAP": "1000"`) and `npx wrangler deploy`. Format:
`<burst>,<rate>/<unit>` with unit `s`, `min`, `h` or `day`. An invalid value is ignored with a warning in
`wrangler tail` and the default applies. Each Hub reads the values when it starts; a deploy restarts the
Durable Objects, so new values are in effect right after it.

### Usage counters

Each Hub counts its own account's messages, launches, requests (connects and API calls), inbound WebSocket
frames, and database rows read and written per UTC day: in memory, written as one row per 50 events, when the
last socket closes and at midnight; counts not yet written (and the rate-limit buckets) survive hibernation
inside a WebSocket attachment, are moved to another open socket when the one carrying them closes, and are
written to the database (usage row + one `meta` row for the buckets) when the last socket closes. With no
socket open (API calls only) every allowed call writes the counts (one row; those calls are rate limited), and
refused calls at most once per 10 s.
They never read another account's data (D9). The phone shows "Today (UTC): N of 500 messages on the free plan" under the session list;
`GET /api/usage` returns the last 35 days (ready for the Phase 4b admin view). A deploy can lose up to 49
not-yet-written events per account.

### Reconnects

- Keepalive: daemon and PWA send `ping` every 30 s; the Hub's auto-response answers `pong` without waking the
  Durable Object. No frame within 15 s after a ping means the connection is half-open: it is dropped and
  replaced. No other periodic traffic exists (no polling).
- After a working connection drops (e.g. a Worker deploy drops every socket at once), the first retry waits a
  random 0.5-15 s (daemon) or 0.25-3 s (PWA) so clients don't all reconnect in the same second; failed attempts
  then back off with jitter up to 2 min (daemon) / 30 s (PWA).
- HTTP 429 or close 4029: wait the server's `Retry-After` / "retry in Ns" (at least 60 s without one), plus
  jitter. HTTP 5xx: at least 5 s.
- PWA on Android: while the app is in the background a dropped socket is not reconnected; when it comes back
  to the foreground an open socket is checked with a 5 s ping deadline and a missing one reconnects at once.

### Verify at the desk

`developers.cloudflare.com` was unreachable while Phase 3 was written. Check each assumption below against the
named page and fix `worker/src/budget.ts` (and the defaults above) if it is wrong:

- [ ] Workers requests, free plan: 100,000/day; CPU time 10 ms per invocation —
      <https://developers.cloudflare.com/workers/platform/limits/>
- [ ] Durable Objects on the free plan: requests 100,000/day, duration 13,000 GB-s/day; SQLite storage:
      5 million rows read/day, 100,000 rows written/day, 5 GB stored —
      <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [ ] Incoming WebSocket messages billed 20:1 against requests; outgoing messages free; whether an
      auto-responded `ping` counts at all — same page, and
      <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- [ ] Do index updates count as extra rows written in Durable Object SQLite (the 500/day sizing assumes yes) —
      <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [ ] Maximum WebSocket message size (assumed 1 MiB; we never send more than 64 KiB) and WebSocket attachment
      size (local workerd allows 16 KiB; older docs said 2 KiB; our snapshots stay under 1.5 KiB) —
      <https://developers.cloudflare.com/durable-objects/platform/limits/>
- [ ] Idle WebSocket timeout (assumed ~100 s; our ping is every 30 s) —
      <https://developers.cloudflare.com/workers/runtime-apis/websockets/>
- [ ] How long an idle Durable Object stays in memory before hibernating (~10 s) —
      <https://developers.cloudflare.com/durable-objects/reference/in-memory-state/>
- [ ] Workers Rate Limiting binding: available and free on the free plan? `namespace_id` rules —
      <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- [ ] Close code / behavior clients see when a deploy restarts Durable Objects (we treat any close the same) —
      <https://developers.cloudflare.com/durable-objects/reference/durable-object-lifecycle/>

Also on the first `npx wrangler deploy` after Phase 3: it applies migration `v2` (new `Throttle` class);
wrangler should say so.

## Troubleshooting

- `/mcp` inside Claude Code shows the shim's status; `claude --debug --dangerously-load-development-channels server:mcp-remote`
  writes shim stderr to `~/.claude/debug/<session-id>.txt`.
- `send_message` errors "daemon is not running": start `mcp-remote daemon`. The shim reconnects by itself.
- Revoke a lost computer: phone -> Machines -> Revoke. Its daemon is disconnected immediately.
- A phone-launched session says **needs you at the desk**: its detail line names the dialog. `mcp-remote attach
  mr-<id>` to answer it; the session continues on its own once the shim registers. "did not start the mcp-remote
  shim within 90s" usually means the shim isn't registered (`mcp-remote setup-claude`), Claude Code isn't logged
  in, or a prompt this version doesn't recognize is showing (attach to see it).
- "exited (1) No conversation to resume for this session yet": the launch was started fresh and nothing was said
  in it, so there is nothing to resume; **Restart** gives the same empty start. "No earlier conversation in this
  folder": the folder has no conversation at all yet. A "resume last conversation" launch that was stopped before
  anything was said is handled for you: **Restart + resume** forks the folder's conversation again (if Claude
  Code had no record of it after all, the next **Restart + resume** does the same).
- "The folder's most recent conversation is running in a Claude Code background session": "resume last
  conversation" found it in `claude agents` (background sessions); attach to it at the desk, or use **Restart**.
  This is never retried automatically.
- A launched session that never comes up although Claude Code runs: the detail line shows if the daemon refused
  its shim (daemon log: `refused shim for mr-...`). `claude` behind wrappers (Volta, npm's wrapper, scripts) is fine.
  Register the shim with `mcp-remote setup-claude` (absolute node + CLI paths); an `npx`-style registration or a
  hook that runs `claude` itself at session start can make the daemon take the wrong process for the session's shim.
- "remote launch is not available": the phone shows why (no tmux, tmux older than 3.2, invalid launch.json, Windows).
- "rate limited: ... try again in Ns" (phone toast or `send_message` result) or "daily message limit reached":
  a per-account limit (see "Limits and the free plan"); wait, or raise it with the env var named there.
- `mcp-remote pair` says "too many pairing attempts from your network": wait the time it names (default 5
  starts per hour per IP), or raise `LIMIT_PAIR_START_IP`. On the phone "too many approval attempts for this
  code": run `mcp-remote pair` again for a fresh code.
- Daemon log "server is rate limiting this account's connections (HTTP 429 ...)": something reconnects in a
  loop (several daemons with one token, a phone tab reloading); it retries after the named time on its own.
- Worker logs: `cd worker && npx wrangler tail`.

## Local development (no Cloudflare/Google needed)

```sh
cp worker/.dev.vars.example worker/.dev.vars    # sets SESSION_SECRET and DEV_AUTH=1
npm run dev -w worker                           # http://localhost:8787, "Dev sign-in" on the start page
MCP_REMOTE_CONFIG_DIR=/tmp/mr-dev node mcp/dist/cli.js pair http://localhost:8787
MCP_REMOTE_CONFIG_DIR=/tmp/mr-dev node mcp/dist/cli.js daemon
```

(Build the CLI first with `npm run build`.) The shim finds the daemon through the same config dir, so a shim for
this dev daemon needs the same `MCP_REMOTE_CONFIG_DIR` (or `MCP_REMOTE_SOCKET=/tmp/mr-dev/daemon.sock`), e.g. in a
test project's `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-remote": {
      "command": "node",
      "args": ["/path/to/mcp_remote/mcp/dist/cli.js", "shim"],
      "env": { "MCP_REMOTE_CONFIG_DIR": "/tmp/mr-dev" }
    }
  }
}
```
`npm run e2e` runs the whole flow automatically.
