# Phases

## To do
- [ ] Phase 0: Settle open design questions (in progress, see sessions/ and DECISIONS.md)
- [ ] Phase 4b (in progress): Onboarding (sign-up cap/waitlist, invite links, one-line daemon install) + /admin usage alerts (D12, D13)
- [ ] Phase 5: Codex backend (nice-to-have)

## Completed
- [x] Phase 4: PWA icons/manifest/service worker, Web Push from the Worker (RFC 8291/8292) with urgency mapping
      and per-device suppression, consented on-demand location, map links (D11, D14, D17, D19). Ratchet: 2 review
      rounds (major fixed: location leaked to any session on deny); round-2 fixes verified by orchestrator.
      Final: 296/296 tests, e2e 112/112. Real-Android behaviour on SETUP desk checklist.
- [x] Phase 3: Free-tier budget module, per-tenant limits + daily budgets + plans (free/owner), machine caps,
      unauthenticated abuse protection, reconnect hardening, usage counters (D5, D9, D10). Ratchet: 5 review rounds
      (majors fixed: daily-budget bypasses, pairing-socket flood, non-hibernatable refusal socket); round-5 fix
      verified by orchestrator. Final: 239/239 tests, e2e 89/89. Cloudflare numbers UNVERIFIED → SETUP desk checklist.
- [x] Phase 2: Remote launch/relaunch via daemon + tmux in chosen permission mode, service install (D6, D18).
      Ratchet: 9 review rounds (2 majors fixed: tmux -c format injection, key press into live sessions);
      round-9 nits verified by orchestrator. Final: 161/161 tests, e2e 78/78. Desk-unverified: real systemd/launchd runs, macOS.
- [x] Phase 1: Multi-session walking skeleton + agent-chosen urgency (D16, D19). Ratchet: 7 review rounds,
      clean on round 7. Final: 81/81 tests, e2e 52/52 (local wrangler dev). Not yet deployed (needs desktop, see SETUP.md).
- [x] Phase -1: Repo scaffold (mcp/, worker/, harness/) and auto commit/push hook

## Parked
- Live activity feed (tool calls, edits) via hooks or transcript tailing; parked by D17.
- Native Android helper for background location; parked by D14.
- Billing; parked by D10.
- Permission relay to the phone; parked by D18.
