# worker

Cloudflare Worker (free plan): Google OAuth (D7), device pairing (D4), and one `Hub` Durable Object per user
(D9) holding that user's machines, sessions, messages and WebSockets (Hibernation API, SQLite). Also serves the
phone PWA from `public/` (bundled from `web/app.ts`).

- `npm run dev -w worker` - local dev on :8787 (needs `.dev.vars`, see `.dev.vars.example`)
- `npm test -w worker` - tests inside workerd
- Deploy: see `../harness/SETUP.md`

HTTP surface:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /auth/login`, `/auth/callback` | - | Google authorization code + PKCE; sets `__Host-mr_session` |
| `POST /auth/logout` | cookie + Origin | clear session |
| `GET /auth/dev?user=` | `DEV_AUTH=1` only | local fake sign-in (404 otherwise, and never on *.workers.dev) |
| `GET /api/me`, `/api/state`, `/api/machines` | cookie | who am I / snapshot (incl. today's usage) / machine list |
| `GET /api/usage` | cookie | this account's usage per UTC day (last 35 days) |
| `DELETE /api/machines/:id` | cookie + Origin | revoke a machine (closes its socket) |
| `POST /api/pair/start` | - (throttled per IP) | daemon starts pairing: `{code, pairing_id, poll_secret, expires_at}` |
| `GET /api/pair/wait` (WebSocket) | poll secret | daemon waits for approval |
| `POST /api/pair/approve` | cookie + Origin | phone approves `{code, machine_name?}` |
| `GET /api/ws` (WebSocket) | cookie + Origin | phone socket |
| `GET /api/daemon/ws` (WebSocket) | machine token | daemon socket |

Limits (Phase 3): `src/budget.ts` holds the assumed free-plan numbers (with sources / UNVERIFIED) and every
per-tenant and per-IP limit; `src/ratelimit.ts` is the token-bucket math, `src/usage.ts` the per-tenant usage
counters, `src/throttle.ts` the `Throttle` Durable Object for unauthenticated endpoints. Over a limit, HTTP
answers `429` with `Retry-After` and `{error, retry_after_s}`; WebSockets get an `error` frame (or close
`4029` for floods). See `../harness/SETUP.md` ("Limits and the free plan").
