# Ratchet pipeline

How every phase gets built.

1. The orchestrator (main session) starts a **new implementer** sub-agent for the phase.
   All implementation for that phase goes through that one implementer.
2. When the implementer says the phase is complete, a **fresh independent reviewer** sub-agent reviews it
   (never a reviewer used before).
3. Every finding from the reviewer goes back to the **same implementer**, which fixes or answers each one.
4. Then a **new** reviewer (not any previous one) reviews again. Repeat 3-4 until a review comes back clean,
   or the orchestrator makes the executive call that remaining findings are noise (logged with reasons).
5. Mark the phase complete in PHASES.md, log it in sessions/, then start the next phase with a new implementer.

Commits and pushes are automatic (no user approval) at logical moments: implementer milestones, after each
review-fix round, and at phase completion. Each review round is logged in the phase's session log.
