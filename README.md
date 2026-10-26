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
- **Notifications, location, maps** (Phase 4): the phone app is an installable PWA (Android) with Web Push sent
  directly by the Worker (VAPID, no push service account): `normal` messages notify, `urgent` ones notify with high
  priority and stay, `silent` ones don't, and nothing is pushed while the app is open. Claude can ask for the
  phone's location on demand (`get_location`; you tap Share every time, or open the notification) and send
  Google Maps links (`map_link`), which the app shows as tappable links.

Free Cloudflare plan only. Everyone shares the deployer's quota, so each account has its own limits (messages
per minute and per day, launches, connects, ...) enforced in its own Hub, the public endpoints (pairing,
sign-in) are throttled per IP, and the phone shows today's usage; numbers and tuning in `harness/SETUP.md`
("Limits and the free plan"). See `harness/DECISIONS.md` for the design contract and `harness/SETUP.md` for
deployment and desktop setup.

## Layout

| Path | What |
| --- | --- |
| `shared/` | `@mcp-remote/shared`: wire protocol (zod schemas + types) for every link, frame limits, backoff, `link.ts` (heartbeat / half-open detection, reconnect spreading), `maplink.ts` (Google Maps URLs), `links.ts` (which message parts become tappable) |
| `worker/src/index.ts` | Worker router: `/auth/*` (Google OAuth, dev auth), `/api/*` (pairing, machines, WebSockets) |
| `worker/src/hub.ts` | `Hub` Durable Object: machines, sessions, messages; phone + daemon sockets |
| `worker/src/pairing.ts` | `Pairing` Durable Object: pending pairing codes (outside any tenant Hub) |
| `worker/src/budget.ts` | the one place for assumed free-plan numbers (sources / UNVERIFIED) and every limit |
| `worker/src/ratelimit.ts`, `usage.ts`, `throttle.ts` | token buckets, per-account usage counters, `Throttle` DO for unauthenticated endpoints |
| `worker/src/auth.ts`, `crypto.ts`, `oauth.ts` | session cookies, machine tokens, Google ID-token verification |
| `worker/web/app.ts`, `link.ts`, `pwa.ts` | the PWA (bundled to `worker/public/app.js`); `link.ts` = its WebSocket/reconnect logic; `pwa.ts` = service worker registration/updates, push subscription, geolocation |
| `worker/sw/sw.ts` | service worker (bundled to `worker/public/sw.js`): offline app shell, push -> notification, notification clicks |
| `worker/src/webpush.ts` | Web Push with WebCrypto: RFC 8291 payload encryption, RFC 8292 VAPID, push service allowlist |
| `worker/icons/icon.svg`, `worker/scripts/icons.mjs` | the one icon source and the offline renderer that makes every PNG/ICO from it |
| `worker/public/` | static assets: `index.html`, `style.css`, manifest, icons, `_headers` (CSP) |
| `worker/test/` | vitest tests running inside workerd (`@cloudflare/vitest-plugin`) |
| `mcp/src/` | `mcp-remote` CLI: `pair`, `daemon`, `shim`, plus remote launch: `launcher.ts` (lifecycle), `tmux.ts` (argv-only tmux driver), `dialogs.ts` (startup dialog detection), `launch-config.ts` (allowlist), `desk.ts` (`projects`, `config`, `setup-claude`, `attach`), `service.ts` (`install-service`) |
| `mcp/test/` | daemon routing, config, launcher lifecycle, tmux, dialog fixtures (`fixtures/`, captured from Claude Code), service files |
| `scripts/fake-claude.mjs` | stand-in for `claude` in the e2e (shows the dev-channels warning, runs the shim) |
| `scripts/e2e.mjs` | end-to-end test against a real local `wrangler dev` (incl. a local fake push service and a simulated phone sharing its location) |
| `harness/` | plan, decisions, phases, setup guide, session logs |

## Commands

```sh
npm ci                 # install (a lockfile is committed; see note below)
npm run typecheck      # tsc --noEmit, strict, every package (worker, PWA, service worker, mcp, shared)
npm test               # unit + workerd integration tests
npm run e2e            # builds, starts wrangler dev locally, pairs a daemon, drives two shims, and launches
                       # a fake claude in tmux from a fake phone (needs tmux 3.2+)
npm run dev -w worker  # local Worker on http://localhost:8787 (copy worker/.dev.vars.example to .dev.vars)
npm run vapid          # print a VAPID key pair for Web Push (see harness/SETUP.md step 5)
npm run icons -w worker  # re-render the icon set from worker/icons/icon.svg
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
