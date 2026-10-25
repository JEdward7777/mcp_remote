# mcp_remote

Talk to your Claude Code sessions from your phone.

```
Android PWA  <--wss-->  Cloudflare Worker (workers.dev)  -->  per-user Hub Durable Object
                                                                   ^
                                       one outbound WebSocket per computer (daemon)
                                                                   |
                         per-session stdio shim (Claude Code "channel" MCP server) <--unix socket--> daemon
```

- **Phone**: a small installable web app served by the Worker. Sign in with Google, see every session on every
  paired computer (online/offline), open a thread per session, send a message.
- **Worker + Hub**: Google OAuth, device pairing, and one Hub Durable Object per user (WebSocket Hibernation,
  SQLite). Tenants are separated by construction: each user's data lives in their own Hub (D9).
- **Daemon** (`mcp-remote daemon`): one per computer; holds the single WebSocket to the Hub (no polling, D5).
  It can also **start, restart and stop Claude Code sessions from the phone** (D6): only in folders you allowlist
  (`mcp-remote projects add <dir>`), in the permission mode you choose (D18), each in its own tmux session.
  `mcp-remote install-service` runs it as a systemd user unit / launchd agent.
- **Shim** (`mcp-remote shim`): Claude Code spawns one per session. It is a
  [channel](https://code.claude.com/docs/en/channels-reference) MCP server: phone messages arrive in the session
  as `<channel>` events, and Claude replies with the `send_message` tool, choosing an urgency
  (`silent` / `normal` / `urgent`, D19). Messaging is discrete and intentional (D17).

Free Cloudflare plan only. See `harness/DECISIONS.md` for the design contract and `harness/SETUP.md` for
deployment and desktop setup.

## Layout

| Path | What |
| --- | --- |
| `shared/` | `@mcp-remote/shared`: wire protocol (zod schemas + types) for every link, frame limits, backoff helper |
| `worker/src/index.ts` | Worker router: `/auth/*` (Google OAuth, dev auth), `/api/*` (pairing, machines, WebSockets) |
| `worker/src/hub.ts` | `Hub` Durable Object: machines, sessions, messages; phone + daemon sockets |
| `worker/src/pairing.ts` | `Pairing` Durable Object: pending pairing codes (outside any tenant Hub) |
| `worker/src/auth.ts`, `crypto.ts`, `oauth.ts` | session cookies, machine tokens, Google ID-token verification |
| `worker/web/app.ts` | the PWA (bundled to `worker/public/app.js`) |
| `worker/public/` | static assets: `index.html`, `style.css`, manifest, favicon, `_headers` (CSP) |
| `worker/test/` | vitest tests running inside workerd (`@cloudflare/vitest-plugin`) |
| `mcp/src/` | `mcp-remote` CLI: `pair`, `daemon`, `shim`, plus remote launch: `launcher.ts` (lifecycle), `tmux.ts` (argv-only tmux driver), `dialogs.ts` (startup dialog detection), `launch-config.ts` (allowlist), `desk.ts` (`projects`, `config`, `setup-claude`, `attach`), `service.ts` (`install-service`) |
| `mcp/test/` | daemon routing, config, launcher lifecycle, tmux, dialog fixtures (`fixtures/`, captured from Claude Code), service files |
| `scripts/fake-claude.mjs` | stand-in for `claude` in the e2e (shows the dev-channels warning, runs the shim) |
| `scripts/e2e.mjs` | end-to-end test against a real local `wrangler dev` |
| `harness/` | plan, decisions, phases, setup guide, session logs |

## Commands

```sh
npm ci                 # install (a lockfile is committed; see note below)
npm run typecheck      # tsc --noEmit, strict, every package (worker, PWA, mcp, shared)
npm test               # unit + workerd integration tests
npm run e2e            # builds, starts wrangler dev locally, pairs a daemon, drives two shims, and launches
                       # a fake claude in tmux from a fake phone (needs tmux 3.2+)
npm run dev -w worker  # local Worker on http://localhost:8787 (copy worker/.dev.vars.example to .dev.vars)
```

Note: with npm 10, a fresh `npm install` without the lockfile can crash inside npm's peer-dependency resolver
(`Cannot read properties of null (reading 'edgesOut')`). `npm ci` from the committed lockfile works; to change
dependencies, use `npx npm@11 install ...`.

## Example `.mcp.json`

```json
{
  "mcpServers": {
    "mcp-remote": { "command": "mcp-remote", "args": ["shim"] }
  }
}
```

Then start Claude Code with `claude --dangerously-load-development-channels server:mcp-remote`, or register the
shim once for all projects with `mcp-remote setup-claude` and start sessions from the phone
(see `harness/SETUP.md`, steps 11-14).
