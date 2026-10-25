# Setup (desktop steps)

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

Optional: `GOOGLE_REDIRECT_URI` (only if you serve from a different URL than the request origin).
**Never** set `DEV_AUTH` on the deployed Worker (it only belongs in `worker/.dev.vars`; the code also refuses it on
`*.workers.dev`). Rotating `SESSION_SECRET` signs everyone out and invalidates every machine token (re-pair).

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
# Adjust the path to the output of `which mcp-remote`.
ExecStart=%h/.npm-global/bin/mcp-remote daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

`systemctl --user enable --now mcp-remote`. The daemon exits with code 3 if the machine is revoked
(`Restart=on-failure` will retry; it keeps failing with a clear log line until you pair again).

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

Each shim registers a session named after the project folder (basename of the cwd) with a random session id.
Set `MCP_REMOTE_SESSION_ID` in the server's `env` to keep a stable id (and thread) across restarts, e.g.
`"env": { "MCP_REMOTE_SESSION_ID": "myproject-main" }`. Offline sessions can be removed from the phone (open the thread -> Forget).

## 13. Launch Claude Code with the channel

```sh
claude --dangerously-load-development-channels server:mcp-remote
```

Accept the development-channel warning ("I am using this for local development") and the "New MCP server found"
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

(Build the CLI first with `npm run build`.) `npm run e2e` runs the whole flow automatically.
