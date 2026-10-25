# Phases

## To do
- [ ] Phase 0: Settle open design questions (in progress, see sessions/ and DECISIONS.md)
- [ ] Phase 2 (in progress): Remote launch/relaunch of sessions via daemon + tmux (D6), in the user's chosen permission mode (D18)
- [ ] Phase 3: Verify free-tier limits; per-tenant rate limits; reconnect/backoff hardening (D5, D10)
- [ ] Phase 4: PWA polish: favicon/icon set, Web Push, on-demand GPS + map links (D11, D14)
- [ ] Phase 4b: Onboarding (sign-up cap/waitlist, invite links, one-line daemon install) + /admin usage alerts (D12, D13)
- [ ] Phase 5: Codex backend (nice-to-have)

## Completed
- [x] Phase 1: Multi-session walking skeleton + agent-chosen urgency (D16, D19). Ratchet: 7 review rounds,
      clean on round 7. Final: 81/81 tests, e2e 52/52 (local wrangler dev). Not yet deployed (needs desktop, see SETUP.md).
- [x] Phase -1: Repo scaffold (mcp/, worker/, harness/) and auto commit/push hook

## Parked
- Live activity feed (tool calls, edits) via hooks or transcript tailing; parked by D17.
- Native Android helper for background location; parked by D14.
- Billing; parked by D10.
- Permission relay to the phone; parked by D18.
