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

`OPEN_SIGNUP` in `worker/wrangler.jsonc` (`vars`) picks the mode (details: "Sign-up, admin and alerts" below):

- `"false"` (default, closed): only `ALLOWED_EMAILS`, `OWNER_EMAILS` and people with an invite link you created
  in Admin;
- `"waitlist"`: everyone else can sign up but waits until you approve them in Admin (one tap);
- `"true"` (open): anyone with a verified Google account is let in automatically until `USER_CAP` active
  accounts (default **10**), then new sign-ups go to the waitlist.

Set `OWNER_EMAILS` (step 5 / "Plans") to your own email: that is what shows you the **Admin** page.

## 5. Set secrets

```sh
cd worker
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET   # >= 32 chars; signs cookies + machine tokens
npx wrangler secret put GOOGLE_CLIENT_ID                           # paste the client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET                       # paste the client secret
npx wrangler secret put ALLOWED_EMAILS                             # e.g. you@gmail.com,friend@gmail.com
```

Web Push (phone notifications, Phase 4) needs a VAPID key pair. Generate it on your computer (WebCrypto,
offline, nothing is written to disk) and store it as secrets:

```sh
npm run vapid                                    # from the repo root: prints VAPID_PUBLIC_KEY=... / VAPID_PRIVATE_KEY=...
cd worker
npx wrangler secret put VAPID_PUBLIC_KEY         # paste the public key
npx wrangler secret put VAPID_PRIVATE_KEY        # paste the private key (keep it secret, never commit it)
npx wrangler secret put VAPID_SUBJECT            # optional: mailto:you@example.com (default: the app's own URL)
```

Without these keys everything else works; the phone's Settings say "Notifications are not set up on the
server". Replacing the keys later invalidates every phone's subscription: each phone re-registers by itself the
next time the app is opened (until then it gets no notifications).

Gating is re-checked on every request for accounts that got in through `ALLOWED_EMAILS` / `OWNER_EMAILS` (or
before Phase 4b): removing the email (or, for pre-4b accounts, setting `OPEN_SIGNUP` back to `false`) signs that
person out immediately and refuses their daemons the next time they connect (an already open daemon socket stays
up until it reconnects; revoke the machine to cut it at once). Accounts let in by the Registry (invite link, user
cap, your approval) stay until you **Disable** them in Admin, which cuts everything at once.

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

Open `$URL` in Chrome on Android and sign in. Then:

1. **Install**: Chrome menu (⋮) -> **Install app** / **Add to Home screen** (or **Settings -> Install app**
   in the app when Chrome offers it). The app gets its own icon (adaptive/maskable on Android 8+) and opens
   full screen. It also opens offline (showing "You are offline"), from the service worker's cache; when a new
   version is deployed, a banner says "A new version of the app is available" with **Reload**.
2. **Notifications**: in the app, **Settings -> Notifications on this phone -> Turn on**, and allow
   notifications when Chrome asks. Up to 5 phones/browsers per account can be registered (a 6th replaces the
   oldest). "Show the first words of a message in notifications" (on by default) puts the project name and up to
   100 characters of the message in the notification, which Android also shows on the lock screen; turn it off
   to get just "New message from a session". If you blocked notifications earlier: Chrome -> site settings (lock
   icon in the address bar, or Android Settings -> Apps -> Chrome -> Notifications) -> allow, then **Turn on**
   again. Android's own per-app settings (Settings -> Apps -> mcp remote -> Notifications) can also silence them.
   **Settings -> Devices that get notifications** lists every registered phone/browser ("Chrome on Android",
   when it was added): **Remove** one (e.g. a lost phone, from any other device) or **Remove all devices**.
   **Sign out** turns notifications off for that browser first, so a signed-out browser (or the next person
   signing in on it) never gets your notifications.
3. **Location** (optional): nothing to set up. The first time a session asks and you tap **Share**, Chrome asks
   for location permission for the site ("Allow only while using the app" is enough). To stop sessions from
   asking at all: **Settings -> Location** off (this also deletes the stored last position).

## 9. Install the CLI on each computer

**Easiest (Phase 4b):** on the phone or any browser where you are signed in: **Machines -> Add a computer**. It
shows one command for the computer's terminal, with a pairing code already filled in:

```sh
npm i -g https://mcp-remote.<you>.workers.dev/dl/mcp-remote-0.1.0-<sha8>.tgz && mcp-remote pair --code XXXX-XXXX-XXXX-XXXX https://mcp-remote.<you>.workers.dev
```

It installs the CLI from your own Worker (the file is built from this repo by `wrangler deploy`; the name pins
version and content, and the app shows its full sha256 plus a "verify first" variant:
`curl -fsSLO <url> && echo "<sha256>  <file>" | sha256sum -c - && npm i -g ./<file> && mcp-remote pair --code ...`;
nothing is piped into a shell) and pairs the computer to the signed-in account without an approval step (the code
works once, for 10 minutes; whoever has it can pair a computer to your account until then, so don't share it).
Then continue with steps 11 and 12 (`mcp-remote install-service`, `mcp-remote setup-claude`), which the app lists
too. If `npm i -g` needs root, set a user prefix first (`npm config set prefix ~/.local`, with `~/.local/bin` on
your `PATH`).

Or from the repo:

```sh
cd mcp
npm pack                         # builds dist/ and creates mcp-remote-0.1.0.tgz
npm install -g ./mcp-remote-0.1.0.tgz
mcp-remote --help
```

## 10. Pair the computer

(Skip this if you used the one-line install in step 9.)

```sh
mcp-remote pair $URL             # optional: --name "work laptop"
```

It prints a code like `K7QX-M2RP`. On the phone: **Machines -> Or: approve a code**, enter the code, **Approve**.
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

## Sign-up, admin and alerts (Phase 4b)

### Who gets in (precedence)

The first rule that matches decides, at every sign-in (`worker/src/signup.ts`):

1. No verified email: refused.
2. `OWNER_EMAILS`: in (can't be waitlisted or disabled).
3. Disabled by you in Admin: refused ("disabled by the operator").
4. `ALLOWED_EMAILS`: in (skips cap and waitlist).
5. Already in through the Registry (invite, cap, your approval): stays in, even if the cap is lower now.
   (Accounts that got in through the lists keep their old rule: removing the email ends it. Accounts from before
   Phase 4b: while `OPEN_SIGNUP` is `false` they keep the old rule (in only if listed); the first time one is
   used or signs in while it is `waitlist` or `true`, it becomes a Registry account like any other and stays in
   from then on, also if you later switch modes, until you disable it.)
6. A valid invite link: in (skips the waitlist, the cap and a sign-up pause).
7. On the waitlist: still waiting. Denied by you: refused.
8. `OPEN_SIGNUP`: `false` -> refused ("not on the sign-up list; ask for an invite"); `waitlist` -> waitlist;
   `true` -> in while active accounts < `USER_CAP` and sign-ups are not paused, else waitlist. A full waitlist
   (`WAITLIST_MAX`, default 500) refuses.

If the Registry can't be reached at sign-in, owners and `ALLOWED_EMAILS` still get in (fail open: they need no
Registry decision); everyone else is asked to try again (fail closed: the cap can't be checked). Already
signed-in users never need the Registry (it is not on any request path).

**Waitlist.** A waitlisted person gets a "You're on the waitlist" page (a waitlist cookie, not a session: no API
access). When you approve them, they are in the next time they open the page (it re-checks with the Registry at
most every 30 s; no polling, no email is sent: tell them). **Approve**, **Deny** (refused from then on; you can
still approve later) or **Remove** (forgets the entry and its email, also in earlier audit entries; they can sign
up again). The waiting page also takes an invite link pasted by the person (it skips the waitlist).

**Invite links.** Admin -> Invite links: valid for 1-30 days (default 7), up to N uses (default 5; empty =
unlimited), with a note. The link is `https://<your app>/?invite=<token>`; the token is signed with
`SESSION_SECRET` (forged or expired links are refused without touching any Durable Object), and the Registry
checks at sign-in that it is not revoked or used up (a used-up link falls back to the normal rules). The sign-in
page tells a visitor whether the link is still good, expired, withdrawn or used up (one Registry lookup, per-IP
limited). **Revoke** stops it at once. Rotating `SESSION_SECRET` invalidates every link.

**Upgrading from Phase 4:** `OPEN_SIGNUP: "true"` now means "up to `USER_CAP` (default 10) accounts". Accounts
that already exist are registered as active the first time they are used after the deploy (their Hub reports),
so they don't count as new; an account not used at all since the deploy would be treated as a new sign-up when
its 30-day cookie runs out. To be safe, raise `USER_CAP` or list existing users in `ALLOWED_EMAILS` before deploying.
The deploy applies migration `v3` (new `Registry` class); wrangler should say so.

### Admin page (owner only)

Open **Admin** in the app (or `https://<your app>/admin`). It appears only for `OWNER_EMAILS` accounts, and every
`/api/admin/*` call checks the cookie and `OWNER_EMAILS` on the server (non-owners get 403; writes also need
our Origin). It shows, loaded on open / **Refresh** (no polling):

- **Today vs the free plan**: Durable Object requests (connects, API calls, WebSocket frames / 20), database rows
  read and written, summed over all accounts plus the Registry itself, against the assumed free daily limits
  (`budget.ts`, unverified), and what the guard is doing. Not counted: Worker-only requests (static files,
  `/api/me`, sign-in) and anonymous pairing starts; numbers lag by at most `USAGE_REPORT_MINUTES` per account.
- **Accounts**: active / cap, waiting, disabled, denied; per UTC day (last 14): sign-ups, active accounts (DAU),
  requests, rows written, messages.
- **Waitlist** with Approve / Deny / Remove. **Top accounts today** by share of a free limit (emails are shown
  to the owner only). **All accounts**: change the plan (`free` / `owner`), **Disable** / **Enable**.
- **Invite links** (create / copy / revoke) and the **Audit log** (every owner action: approve, deny, remove,
  disable, enable, plan, pause, invite create / revoke, and invite uses; last 1,000 kept).

**Disable** cuts the account off at once: its Hub refuses everything (API calls 403 "disabled", which also signs
that browser out; the phone socket is closed with 4403 and the app says the account is disabled), its daemons are
disconnected (close 4001) and refused on reconnect (403), so they exit with code 3 and the service doesn't
restart them (as for a revoked machine). It also can't sign in again. **Enable** lets it back in (a browser that
was just refused may need up to a minute, or a new sign-in); its computers need `mcp-remote daemon` / the
service started again. Changing the plan takes effect in that account's Hub at once. Every sign-in also re-sends
the account's state to its Hub, so an account whose Hub missed an Enable (or that became an owner) is put right
by signing in again.

### Global guard and owner alerts

The `Registry` keeps today's deployment-wide totals. When the highest share of any free daily limit reaches:

| Setting | Default | Effect |
| --- | --- | --- |
| `ALERT_USAGE_PERCENTS` | `50,80` | Web Push to the owner's phones ("Usage passed 50% of the free plan"), once per threshold per UTC day |
| `GUARD_PAUSE_SIGNUPS_PERCENT` | `80` | new sign-ups that would be auto-approved go to the waitlist for the rest of the UTC day |
| `GUARD_TIGHTEN_PERCENT` / `GUARD_FREE_SHARE_PERCENT` | `90` / `5` | free accounts' daily share drops from 10% to 5% for the rest of the UTC day (owner plan unchanged) |
| `ALERT_SIGNUPS_PER_DAY` | `20` | alert when that many accounts signed up today (once a day) |
| `ALERT_WAITLIST` | on | alert when someone joins the waitlist (at most once a day; `off` to stop) |

Any of them can be `off`. Alerts go to every phone with notifications on of every active account whose email is in
`OWNER_EMAILS` (their own Hub sends them; they count against that account's push cap). Tapping one opens Admin.
The manual **Pause new sign-ups** switch in Admin does the same as the guard's pause until you switch it off.

Why these are safe defaults: the guard only ever makes things stricter, and only for the current UTC day (it
lifts itself at midnight). If the Registry can't be reached, Hubs keep the last guard state they got for today
(fail open to the per-account daily budgets, which still bound every account); sign-ups for strangers fail closed.

### The Registry (what is stored, what it costs)

One `Registry` Durable Object (SQLite) is the only store that spans accounts (D13). It holds: per account its id,
email (no name), when it signed up, status (active / waitlisted / denied / disabled), how it got in, plan, and the
last active day; per account per UTC day the counters its Hub reported (requests, rows read / written, messages,
launches, pushes, computers, sessions; kept 35 days); per day the totals, sign-ups and active accounts; invite
links; the audit log. Never message content, project or machine names, or locations.

Each account's Hub reports its own counters at most every `USAGE_REPORT_MINUTES` (default 15) while something is
counted, once at the start of a new UTC day (with the final numbers of the previous one) and once when its daily
budget runs out; never per message. A report costs one Registry request and about 3 rows read / 2 written there
(measured; 4 / 3 on an account's first report of the day), charged to that account's own daily budget, plus one
row in its Hub. Sign-ins cost one Registry request each; the Admin page a few. Chosen over D1: no new product or
setup step, one object serializes the cap and invite counts without races, and its load is small (see the
checklist for the single-object throughput assumption).

### Settings (all optional, `vars` in `worker/wrangler.jsonc`)

`OPEN_SIGNUP` (`false` / `waitlist` / `true`), `USER_CAP` (default 10), `WAITLIST_MAX` (500),
`USAGE_REPORT_MINUTES` (15; `off` disables reports, and with them the Admin numbers and the guard),
`ALERT_USAGE_PERCENTS`, `ALERT_SIGNUPS_PER_DAY`, `ALERT_WAITLIST`, `GUARD_PAUSE_SIGNUPS_PERCENT`,
`GUARD_TIGHTEN_PERCENT`, `GUARD_FREE_SHARE_PERCENT`, `LIMIT_PAIR_START_SIGNED` (one-line install codes per
account, free plan default `5,10/h`). Invalid values fall back to the default.

### One-line install: what it costs and why it bypasses the anonymous pairing cap

**Add a computer** starts the pairing from the signed-in session (`POST /api/pair/start-signed`): it is charged to
that account (its own persisted bucket `LIMIT_PAIR_START_SIGNED`, its daily budget, its machine cap; the Pairing
DO's ~8 rows written are added to its usage) and never touches the global cap on anonymous `POST /api/pair/start`
(about 52 per hour for everyone), so a flood of anonymous starts can't block signed-in users from adding
computers. The code is 16 characters (~79 bits), single use, 10 minutes; redeeming it (`POST /api/pair/redeem`,
per-IP limited like the pairing wait) returns the machine token directly, and the CLI then confirms with the
existing claim call. The 8-character flow (`mcp-remote pair <url>` + approve on the phone) still works.

## Notifications, location and map links (Phase 4)

**When the phone is notified (D19).** A session's `send_message` urgency decides it:

| urgency | in the app | notification (only while the app is not open) |
| --- | --- | --- |
| `silent` | shown | none (no push at all) |
| `normal` | shown | yes; one per session (a newer message replaces it quietly) |
| `urgent` | shown, vibrates | yes, high priority (`Urgency: high`), buzzes again and stays until dismissed |

The decision is per device. "The app is open on a device" means that browser is connected, its page is visible
and it showed a sign of life in the last 75 s (a message, or the keepalive ping that the runtime answers
without waking the Hub). The page says whether it is visible when it connects (a socket opened in the
background counts as hidden) and whenever that changes, including when the screen turns off; a phone that
vanished without closing its socket stops counting after ~75 s. Every registered device whose app is not open
gets a Web Push (so a browser tab left open on your desktop doesn't keep your phone silent). The Hub sends it
itself (encrypted with the phone's keys, RFC 8291; signed with your VAPID key, RFC 8292;
outbound `fetch` from the Hub, at most 5 s each, all phones in parallel, awaited inside the same event). Claude's
tool result says what happened: "push notification sent to 1 phone", "the phone app is open, so it is shown
there", "push notification sent to 1 phone; also shown in the app that is open", "no notification: notifications are not enabled on any phone", or what the push service answered.

Push services are only ever called for endpoints on the known Web Push hosts (FCM `fcm.googleapis.com` /
`android.googleapis.com` for Chrome, Mozilla, Apple, Microsoft); other endpoints are refused when a phone
registers. A `404`/`410` answer deletes that phone's registration (Settings on that phone then offers
**Turn on** again; it re-registers by itself only when the server's VAPID keys changed); `429`
or `5xx` skips that phone for the `Retry-After` time (at least 1 min, at most 1 h) without retrying the message;
other errors drop that notification (logged with the status, never the content). The payload holds only the
session id, message id, urgency and, with the preview setting on, the project name and the first 100
characters.

**Location (D14).** `get_location` (in Claude) asks the phone; nothing is ever tracked in the background, and
you consent to each request:

- App open: a banner "*project* asks for your location: *reason*" with **Share** / **Not now**. Share reads the
  position once (`navigator.geolocation`, high accuracy, 20 s) and sends it.
- App not open: a high-priority notification "Claude wants your location" (the push service drops it if the phone
  can't be reached within 2 min). Tapping it (or its **Share location** button) is the consent: the app opens,
  checks with the server that this exact request is still open (the notification carries the request's random
  token), and shares once. A request can be answered for 10 minutes; after that, or once answered, a tap
  shares nothing ("expired or was already answered"). **Not now** or ignoring it shares nothing. A link to the
  app with made-up request parameters shares nothing either. The notification disappears once the request is
  answered or gone (the next time the app is open).
- Claude gets the position with its accuracy and age, or a clear reason without any position: declined,
  location turned off, no phone reachable, rate limited, or no answer within its timeout (default 60 s, at most
  120 s).
- Only the session whose request you answered gets the position. That session may reuse it for its own later
  calls if it is at most `max_age_s` old (default 5 min; `0` = always ask) and is told how old it is; any other
  session's request asks you again. An answer that comes after the session stopped waiting is kept for that
  session only.
- Storage: only the last shared position (with the session it belongs to), only in your account's Hub, deleted
  after 6 hours or when you turn location off (which also cancels pending requests); never written to any log.
  The phone's Settings only show *when* and *with which project* it was shared.
- Calls that have to ask the phone are limited (free plan: 5 at once, 20 per hour, `LIMIT_LOCATION`).

**Map links.** `map_link` builds a Google Maps link locally (no API key, no network): a pin, or directions
(from a given origin, or from wherever the phone is when the link is opened). In messages, the app makes only
Google Maps links (`https://www.google.com/maps/...`, `maps.google.com`, `maps.app.goo.gl`, `goo.gl/maps`) and
`geo:` coordinates tappable (checked on the parsed URL; links with `..`, `%2e` or backslashes are refused so a
path can't escape `/maps`); any other link stays plain text you can copy, so a session that read something
malicious can't put a convincing tappable phishing link on your phone.

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
4029. That allowance survives the Hub being evicted (once it is used up it is written down, one row). While
blocked, nothing else is written for the account. Tune with `TENANT_DAILY_SHARE_PERCENT` (1-100,
free plan) and `OWNER_DAILY_SHARE_PERCENT` (owner plan).

Exhausting the shared free quota takes accounts whose shares add up to 100%: ten free accounts at 10% each, or
the owner (50%) plus five free accounts. What the shares bound: database rows, and requests from clients that
behave (our daemon and PWA stop at a refusal and wait). They do not bound a raw request flood: every request
that reaches a Durable Object costs one DO request, even when it is refused at once (and a WebSocket's frames
that were already sent still arrive after the socket is closed); that is limited only by Cloudflare itself.
Daemon connects refused for bad credentials (a revoked or stolen token) are counted separately
(`refused`) and never block the account; the Worker also remembers refused tokens for 10 minutes. Ordinary use needs a fraction of a share: a message round trip writes
about 6-8 rows, so the free plan's 500 messages a day use about 3,500 of its 10,000 rows written.

Computers per account are capped too (free: 10, owner: 30; `MAX_MACHINES` for the free plan): this also bounds
what any single request can cost (a session list reads at most 10 computers x 50 sessions). Pairing an 11th
computer is refused with "this account already has 10 computers (the "free" plan allows 10); revoke one under
Machines first (a revoked computer still counts while it has sessions: Forget them)" (checked again when the
computer is added, so simultaneous approvals can't exceed it). Forgetting a session, or the automatic eviction
of old ones, removes the session at once and deletes its history afterwards, at most 200 rows per event (no
deletes while the account is over its budget); until that is done the session id can't be used again (a daemon
announcing it is told so and re-announces automatically when it is free) and its history is empty, so old rows
never show up anywhere. A single `hello` that announces many new sessions re-checks the budget between them.

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
| `/api/state`, `/api/machines`, `/api/usage`, revoke, push (un)subscribe | `30,30/min` | `LIMIT_HTTP` | HTTP 429 + `Retry-After` |
| Pairing approvals (right or wrong code) | `5,10/h` | `LIMIT_PAIR_APPROVE` | HTTP 429 "too many pairing approvals on this account; try again in N min" |
| Web Push notifications per UTC day (each phone counts) | `200` | `DAILY_PUSH_CAP` | the message is still delivered in the app; Claude's result says "no notification: daily notification limit reached" |
| `get_location` calls that ask the phone (cached answers are free) | `5,20/h` | `LIMIT_LOCATION` | result "Not asked: too many location requests ...; try again in ..." |

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
| `/api/pair/wait` and `POST /api/pair/claim` (one shared bucket) | `30,120/h` per IP | `LIMIT_PAIR_WAIT_IP` | isolate memory only (best effort, free) |
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
- [ ] After a Durable Object closes a WebSocket, are later frames from a client that ignores the close still
      delivered to `webSocketMessage`? Locally they are (a raw client kept sending ~17,000 frames in 2 s after
      a 4029); the Hub drops them before any work, but each would still be a billed DO request —
      <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- [ ] Duration billing for a Durable Object holding sockets that await a close handshake (the client ignores
      our close): with hibernatable sockets (all of ours; `ws.accept()` is never used in a DO) the object
      should hibernate and bill nothing while idle — confirm on the dashboard with such a socket open —
      <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [ ] A WebSocket accepted by the Worker itself (the pairing wait socket): does each client frame count
      against the invocation's CPU limit, so a flood ends the connection (wrangler dev doesn't enforce it),
      and are its frames free of request billing? Also: may a Worker hold such a socket (and its link to a
      Durable Object) for the full 10-minute pairing window? —
      <https://developers.cloudflare.com/workers/runtime-apis/websockets/> and
      <https://developers.cloudflare.com/workers/platform/limits/>
- [ ] Close code / behavior clients see when a deploy restarts Durable Objects (we treat any close the same) —
      <https://developers.cloudflare.com/durable-objects/reference/durable-object-lifecycle/>

Phase 4 (Web Push, PWA, location) adds these; `developers.cloudflare.com` was still unreachable:

- [ ] Subrequests (outbound `fetch`) per invocation on the free plan: assumed 50 (a Hub event sends at most 5
      pushes) — <https://developers.cloudflare.com/workers/platform/limits/#subrequests>
- [ ] A Durable Object waiting on an outbound `fetch` is billed duration for that wall-clock time (we bound each
      push at 5 s and cap pushes per day), and outbound fetches from a DO are not billed as DO requests —
      <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [ ] `ctx.getWebSocketAutoResponseTimestamp(ws)` is updated by every auto-answered `ping` in production (the
      "app is open" check relies on it; verified in local workerd) —
      <https://developers.cloudflare.com/durable-objects/api/state/>
- [ ] Static asset requests (`/sw.js`, icons, the app shell) are free and don't count against the Workers request
      limit on the free plan, and `_headers` applies to them (`Cache-Control: no-cache` on `/sw.js`) —
      <https://developers.cloudflare.com/workers/static-assets/>
- [ ] On a real Android phone (Chrome, installed PWA): install prompt and maskable icon crop; monochrome badge
      in the status bar; a `normal` push shows a notification while the app is closed and none while it's open;
      `urgent` buzzes again and stays (`requireInteraction`); tapping opens the right thread; the location
      notification's tap shares once; offline start shows the cached app; the update banner appears after a
      deploy.
- [ ] FCM accepts our VAPID JWT + `aes128gcm` body (`201`), honors `Urgency: high` and `TTL`, and endpoints are
      still on `fcm.googleapis.com` (the subscribe allowlist, `src/webpush.ts`). If Chrome hands out another
      host, registration fails with "endpoint host ... is not a known Web Push service": add the host there.

Phase 4b (sign-up, Registry, admin, one-line install) adds these; `developers.cloudflare.com` was still unreachable:

- [ ] A single Durable Object (the `Registry`) can take our load: assumed soft limit ~1,000 requests/s per object;
      our load is one call per sign-in, per account per `USAGE_REPORT_MINUTES` and per Admin page load —
      <https://developers.cloudflare.com/durable-objects/platform/limits/>
- [ ] A Durable Object calling another one over RPC (Hub -> Registry reports, Registry -> Hub alerts / account
      changes) is billed as one request on the callee and not on the Worker request limit —
      <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- [ ] `ctx.waitUntil()` in a Durable Object keeps the report / alert call running after the event returns (the
      Hub doesn't await the Registry's answer inside the event) —
      <https://developers.cloudflare.com/durable-objects/api/state/>
- [ ] D1 (not used; the alternative to the Registry DO): free-plan limits (assumed 5 million rows read / 100,000
      rows written per day, 5 GB) — <https://developers.cloudflare.com/d1/platform/pricing/>
- [ ] Static assets: the CLI tarball (`/dl/mcp-remote-<v>-<sha8>.tgz`, ~180 KB) is within the per-file asset
      size limit (assumed 25 MiB), is served with a binary content type, and `_headers` caching rules apply —
      <https://developers.cloudflare.com/workers/static-assets/>
- [ ] `wrangler deploy` runs the build command (`node build-web.mjs`, which runs `npm pack -w mcp`) from the repo
      checkout, so the deployed tarball matches the commit (it does locally with wrangler 4.152.0).
- [ ] On a real deploy: `npm i -g https://<app>/dl/...tgz` installs on Linux and macOS (Node 22+), then
      `mcp-remote pair --code ...` pairs; the Admin page and its numbers load on an Android phone; an owner alert
      push arrives and opens Admin; a waitlisted Google account sees the waiting page and gets in after approval.

Also on the first `npx wrangler deploy` after Phase 3: it applies migration `v2` (new `Throttle` class);
wrangler should say so. Phase 4 needs no migration (new tables are created by the Hub itself). Phase 4b applies
migration `v3` (new `Registry` class).

### Known gaps

- The global pairing-start cap (about 52 per hour for everyone) protects the quota, but someone hammering
  `/api/pair/start` from many networks can use it up and block new *anonymous* pairings (`mcp-remote pair <url>`)
  for everyone until it refills. Phase 4b: signed-in users add computers with **Add a computer** (one-line
  install), which is charged to their account and does not use that cap.
- Unknown install codes sent to `POST /api/pair/redeem` each wake a (fresh, empty) Pairing Durable Object, like
  `/api/pair/wait` with a made-up code: limited per IP in isolate memory only (free, best effort); a distributed
  flood is bounded only by the platform.
- The Admin totals cover what Hubs and the Registry meter (Durable Object requests and SQLite rows); Worker-only
  requests (static files, `/api/me`, sign-in) and anonymous pairing starts are not counted, and each account's
  numbers can lag by up to `USAGE_REPORT_MINUTES` (an account that goes quiet right after a burst reports it with
  its next event, or the next day). Up to 49 of the Registry's own events can be lost on a deploy.
- Waitlisted people are not notified when you approve them (no email); they get in the next time they open the
  page.
- The pairing wait socket is accepted by the Worker, not by the Pairing Durable Object: the Worker answers at
  most one `ping` per 5 s and closes the socket (1008) on any other frame; client frames never reach the DO
  (tested: none arrive even when a raw client keeps sending after the close, and a late `claimed` frame does
  nothing). The DO only sees the Worker's own link (a hibernatable socket on its side, so it sleeps while it
  waits). "Token saved" is an HTTP POST `/api/pair/claim` authenticated by the pairing id and poll secret.
- Hub sockets (phone, daemon) are accepted by the Hub so it can hibernate. They are authenticated, and every
  frame is bucketed per minute and counted against the account's daily budget; a client that ignores the
  4029 close and keeps sending is dropped before any work (no SQL, not counted), but each such frame may
  still be a billed DO request if Cloudflare delivers it (see the checklist). That cost is attributable to a
  signed-in account or a paired computer's token (revoke it); it is bounded only by the platform.

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
- No notifications: phone app -> Settings shows the state for this phone. "Not set up on the server": set the
  VAPID secrets (step 5). "Blocked for this site": allow notifications in Chrome's site settings, then Turn on.
  Claude's `send_message` result says why a message didn't notify (app open, silent, no phone registered, daily
  limit, or the push service's answer). `wrangler tail` showing "push service rejected a notification (HTTP 403)"
  usually means the VAPID keys changed: open the app on the phone once (it re-registers).
- `get_location` keeps saying "No answer within ...": the phone didn't get or didn't tap the notification;
  check notifications as above. "turned off": phone app -> Settings -> Location.
- A lost phone or a shared computer still gets notifications: on any other signed-in device, Settings ->
  Devices that get notifications -> **Remove** (or **Remove all devices**).
- The app shows an old version: tap **Reload** on the "new version" banner (or close and reopen the app).
- "You're on the waitlist" for someone you want in: Admin -> Waitlist -> Approve (or send them an invite link).
  "This Google account is not on the sign-up list": `OPEN_SIGNUP` is `false`; add them to `ALLOWED_EMAILS` or
  send an invite link.
- No Admin tab: your email must be in `OWNER_EMAILS` (secret), exactly as Google reports it (case doesn't matter).
- Admin numbers stay at 0: `USAGE_REPORT_MINUTES` is `off`, or nothing was used yet today (accounts report with
  their next event, at most every 15 min).
- `mcp-remote pair --code` says "unknown or expired code": get a new command in the app (codes last 10 minutes and
  work once). "this code was already used": the computer is probably paired already (check Machines).
- A daemon exits with code 3 and logs "account disabled": the owner disabled the account (Admin -> Enable, then
  start the service again).
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
