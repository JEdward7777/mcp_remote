# Phases

## To do
- [ ] Phase 0: Settle open design questions (in progress, see sessions/ and DECISIONS.md)
- [ ] Phase 1: Walking skeleton, multi-session (D16): Worker on workers.dev + Google sign-in + Hub DO;
      daemon on one or more computers; shim per Claude Code session (channels); bare PWA with session list + chat.
      Milestone: two sessions open, message each from the phone, replies come back to the right thread.
- [ ] Phase 2: Remote launch/relaunch of sessions via daemon + tmux (D6); permission relay to phone
- [ ] Phase 3: Verify free-tier limits; per-tenant rate limits; reconnect/backoff hardening (D5, D10)
- [ ] Phase 4: PWA polish: favicon/icon set, Web Push, on-demand GPS + map links (D11, D14)
- [ ] Phase 4b: Onboarding (sign-up cap/waitlist, invite links, one-line daemon install) + /admin usage alerts (D12, D13)
- [ ] Phase 5: Codex backend (nice-to-have)

## Completed
- [x] Phase -1: Repo scaffold (mcp/, worker/, harness/) and auto commit/push hook

## Parked
- Live activity feed (tool calls, edits) via hooks or transcript tailing; parked by D17.
- Native Android helper for background location; parked by D14.
- Billing; parked by D10.
