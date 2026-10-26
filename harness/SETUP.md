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
  `Restart=on-failure`, `RestartPreventExitStatus=3 4` and `KillMode=process`, then runs
  `systemctl --user daemon-reload && systemctl --user enable --now mcp-remote`.
  Logs: `journalctl --user -u mcp-remote -f`. For an always-on desktop that you are not logged in to:
  `loginctl enable-linger $USER`. Re-run `install-service` after upgrading node (the path changes).
- **macOS**: writes `~/Library/LaunchAgents/com.mcp-remote.daemon.plist` (RunAtLoad, `KeepAlive` with
  `SuccessfulExit=false`, `AbandonProcessGroup`) and loads it with `launchctl bootstrap gui/$(id -u)`.
  Logs: `~/Library/Logs/mcp-remote.log`. launchd can't be told "don't restart on exit 3/4", so the agent sets
  `MCP_REMOTE_FATAL_EXIT_ZERO=1`: the daemon then exits 0 in those cases (after logging why) and launchd leaves it
  stopped. Limit: it is started again at your next login, logs the same reason and exits again.
- **Windows**: prints Task Scheduler steps (no installer). Remote launch needs tmux, so it is only available when
  the daemon runs inside WSL.

`mcp-remote uninstall-service` removes it. Without a service, `mcp-remote daemon` in a terminal works too.

Exit codes: 3 = the machine was revoked or the account is no longer allowed (pair again); 4 = another computer runs a
daemon with the same token (e.g. a copied `~/.config/mcp-remote`: pair each computer separately, never copy
`config.json`). Restarting can't help in either case, which is why the service files above don't. Other exits
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
`--continue`, `--resume`, `--session-id`, `--fork-session`, `--from-pr` and short flags containing `c` or `r`
(`-c`, `-r`, `-rabc`, `-dc`) are refused in `extra-args`, since the daemon chooses the conversation. Launched sessions
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
- A launched session that never comes up although Claude Code runs: the detail line shows if the daemon refused
  its shim (daemon log: `refused shim for mr-...`). `claude` behind wrappers (Volta, npm's wrapper, scripts) is fine.
  Register the shim with `mcp-remote setup-claude` (absolute node + CLI paths); an `npx`-style registration or a
  hook that runs `claude` itself at session start can make the daemon take the wrong process for the session's shim.
- "remote launch is not available": the phone shows why (no tmux, tmux older than 3.2, invalid launch.json, Windows).
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
