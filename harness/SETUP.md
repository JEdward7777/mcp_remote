# Setup (desktop steps)

> **Important:** Claude Code only delivers phone messages into a session started with
> `claude --dangerously-load-development-channels server:mcp-remote` (step 13). Without that flag the shim still
> runs and the phone still shows "handed to session", but Claude Code silently drops the messages. The shim cannot
> detect this, so it prints a reminder on stderr at startup.

Everything below is done once on your desktop, except step 8 (phone) and steps 9-12 (per computer).
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

## 11. Run the daemon

```sh
mcp-remote daemon
```

Keep it running (Phase 2 will install it as a user service). Until then, e.g. a systemd user unit
`~/.config/systemd/user/mcp-remote.service`:

```ini
[Unit]
Description=mcp-remote daemon

[Service]
# systemd runs units with a minimal PATH, so `mcp-remote` (a `#!/usr/bin/env node` script) fails with
# exit 127 when node comes from nvm/fnm/volta. Use absolute paths to node and to the CLI script:
#   node:  `which node`                     e.g. /home/you/.nvm/versions/node/v22.22.0/bin/node
#   CLI:   `readlink -f "$(which mcp-remote)"`  e.g. .../lib/node_modules/mcp-remote/dist/cli.js
ExecStart=/ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/mcp-remote/dist/cli.js daemon
Restart=on-failure
RestartSec=10
# 3 = revoked / account no longer allowed, 4 = token in use by another computer: restarting can't help.
RestartPreventExitStatus=3 4

[Install]
WantedBy=default.target
```

Replace both placeholder paths (if you upgrade node via nvm, update the node path too), then
`systemctl --user daemon-reload && systemctl --user enable --now mcp-remote`; check with
`journalctl --user -u mcp-remote -f`. The daemon exits on purpose, and must not be restarted, with code 3 if the
machine is revoked or the account is no longer allowed (pair again), and with code 4 if another computer is running
a daemon with the same token (e.g. a copied `~/.config/mcp-remote`: pair each computer separately, never copy
`config.json`). `RestartPreventExitStatus=3 4` keeps systemd from restarting it in those cases; any other
supervisor (launchd `KeepAlive`, Task Scheduler "restart on failure") must likewise not restart on exit codes 3 or 4.
Other exits (crash, network) are fine to restart; the daemon already reconnects with backoff on its own.

## 12. Add the shim to Claude Code

Per project, `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "mcp-remote": { "command": "mcp-remote", "args": ["shim"] }
  }
}
```

or once for all projects: `claude mcp add --scope user mcp-remote -- mcp-remote shim`.

Each shim registers a session named after the project folder (basename of `CLAUDE_PROJECT_DIR`, which Claude Code sets, else of the cwd) with a random session id.
To keep a stable id (and thread) across restarts, set `MCP_REMOTE_SESSION_ID` **per project and per computer**,
never in a committed `.mcp.json` and never at user scope (user scope would give every project on the computer the
same id). Run this once inside each project, using `<computer>-<project>` as the id:

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

## 13. Launch Claude Code with the channel

```sh
claude --dangerously-load-development-channels server:mcp-remote
```

**Do not skip the flag**: it is what makes Claude Code register the shim as a channel. Accept the development-channel warning ("I am using this for local development") and the "New MCP server found"
prompt. Channels need an interactive session; `-p` / Agent SDK mode ignores the flag. Run it in the permission
mode you want the session to use while you are away (D18: no permission relay yet).

On the phone the session appears under your computer with a green dot. Send it a message; Claude receives it as
a `<channel source="mcp-remote" ...>` event and answers with `send_message` (silent / normal / urgent).

## Troubleshooting

- `/mcp` inside Claude Code shows the shim's status; `claude --debug --dangerously-load-development-channels server:mcp-remote`
  writes shim stderr to `~/.claude/debug/<session-id>.txt`.
- `send_message` errors "daemon is not running": start `mcp-remote daemon`. The shim reconnects by itself.
- Revoke a lost computer: phone -> Machines -> Revoke. Its daemon is disconnected immediately.
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
