# Claude coordination and turn-scoped tools

“OpenMausBot: the turn ended” is an approval-broker denial, not evidence of
an internet outage. Browser capabilities also expire when their owning turn
ends; “unauthorized” after that boundary must not be repaired by giving a
worker permanent browser credentials.

The Claude driver keeps native background tasks disabled. Native subagents
can still work within the active turn; asynchronous work across bots uses
OpenMausBot's `delegate_bot` path, which owns each recipient's turn, approvals,
and completion receipt. Long-running native Bash commands can no longer
auto-background past the owning turn. This does not change approval modes or
disable sandbox protections.

Claude can emit a synthetic result with `origin.kind = "task-notification"`.
That result must not settle a submitted user turn or consume its permissions.
The regression fixture emits this result, then asks for WebFetch permission,
and only finishes the parent after the test releases a file gate.

The small `agents` and `ogb` MCP servers use `alwaysLoad: true` so the first
prompt includes coordination and approval tools. Other MCP servers retain
normal deferred loading. This prevents the deferred-lookup dependency; it
does not magically reconnect a crashed server or override a user's denied
tool policy.

Sources:

- [Claude MCP server loading](https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral)
- [Claude background-task setting](https://code.claude.com/docs/en/env-vars)
- [SDK result and background-task messages](https://code.claude.com/docs/en/agent-sdk/typescript)

Regression checks:

```sh
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/agents-proxy.test.ts server/browser-connection.test.ts
```

For end-to-end verification, launch the isolated fixture described in
[README.md](README.md), then follow [Chat turns](chat-turns.md). Never use the
customer's running app to create test bots, approve requests, or rotate tools.
These fixture checks do not prove that a customer's real provider account or
network is healthy. Ask for their app version, Claude CLI version, and a
redacted diagnostic export if failures remain; do not request credentials.
