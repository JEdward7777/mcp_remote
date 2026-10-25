# Road Plan

## Vision
Take any coding project on the road. A phone talks to a coding agent (Codex, Claude Code, ...) through an MCP server.
Traffic passes through a Cloudflare Worker that authenticates via OAuth. Everything lives under one vendor-independent roof.

## Key ideas
- MCP communication is two-directional: the agent can push to the user unprompted.
- The agent can use phone context, e.g. GPS: "where am I?" or "send me a map link to where I need to go".
- Agent-agnostic: the MCP layer adapts to whichever coding agent is installed.

## Layout
- `mcp/`     MCP server wrapping the coding agent
- `worker/`  Cloudflare Worker (OAuth + proxy)
- `harness/` this folder: plan, phases, session logs

## Open questions
Tracked in `sessions/` logs as they are asked and answered.
