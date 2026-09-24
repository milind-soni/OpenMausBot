---
status: done
created: 2026-09-24
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: codex driver MCP tool approvals
owner: assistant
related: [done--shared-task-board.md]
---

# Let Codex bots use the task board and bot messaging tools

Codex-backed bots (SoSo, Dell) loaded the `gbs_agents` MCP server, but every call to `list_tasks`, `ask_bot`, and the other tools failed with "user rejected MCP tool call". Codex asks before each MCP tool call with `mcpServer/elicitation/request`. The driver answered with the command-approval shape `{decision: "accept"}`. Codex could not deserialize that reply (`failed to deserialize McpServerElicitationRequestResponse`) and rejected the call.

---

## 1. Codex driver

- [x] **Answer MCP elicitations in their own shape** — `server/drivers/codex.ts`. Reply `{action: "accept" | "decline", content}`.
- [x] **Pre-approve the agents MCP server** — `server/drivers/codex.ts`. Tool calls from `gbs_agents` are accepted without prompting, matching `mcp__agents` being pre-allowed for Claude. Other servers' tool calls are auto-accepted in full-auto, and otherwise surface as a permission request (`tool: "mcp"`). Elicitations that need real form input are declined.
- [x] **Tests** — `server/drivers/codex.test.ts`, `server/testing/fake-codex-app-server.ts` (`mcp-approval` mode).
