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
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/agents-proxy.test.ts server/browser-proxy.test.ts
```

The turn boundary itself — a capability whose owning turn has been replaced
is refused with 401 even when its request body arrives late — is covered by
`server/index.test.ts` ("binds profile proposals to the capability's bot and
thread and rechecks late bodies"); every internal capability, the browser's
included, passes through that same gate.

A message steered into a running Claude turn is folded in only before a
model call that has not started yet. Words that land during the turn's last
call are queued and run as the CLI's next native turn, in the same process
and on the same tools. The driver holds that turn open until the queued
words are answered: one `turn.completed`, the bot busy throughout, and the
turn's internal tool pass valid until then — never revoked under a running
continuation and never re-issued. From Claude Code 2.1.282 the driver runs
the CLI with `--replay-user-messages`: the CLI echoes each stdin message, with
the uuid it was sent with, as a model call takes it in. A steer written during
a tool call is echoed right after that tool's result; one written during the
turn's last model call is echoed only after the turn's `result`, as its own
turn starts. A `result` is held when the CLI reports `queued_turn_count` above
zero, or while a steer has not been echoed (2.1.282 reports 0 for words
waiting on stdin, so 0 decides nothing). On an older CLI nothing says whether
a steer was folded in, so every steer since the previous hold holds the
result, and a folded one costs the grace below. A held result stands as the
turn's if no `init` follows within 2 s (the words were folded after all), or
if the continuation's `init` is followed by 30 s of silence. Peer asides and
the queue-steer
buttons go through the same `steer()`, so an aside landing in the last
model call extends the turn into its continuation the same way. The CLI's
`total_cost_usd` is a running total, so the turn's cost is the latest
figure; per-turn token usage adds up.

```sh
pnpm exec vitest run server/drivers/claude.test.ts -t "could not fold"
pnpm exec vitest run server/drivers/claude.test.ts -t "queued_turn_count|tool result did not take in|echoed as taken in|does not echo|held window|stays silent|steered continuation|whole grace"
pnpm exec vitest run server/steer-e2e.test.ts -t "internal tool pass"
```

For end-to-end verification, launch the isolated fixture described in
[README.md](README.md), then follow [Chat turns](chat-turns.md). Never use the
customer's running app to create test bots, approve requests, or rotate tools.
These fixture checks do not prove that a customer's real provider account or
network is healthy. Ask for their app version, Claude CLI version, and a
redacted diagnostic export if failures remain; do not request credentials.

## Rebuilt conversations

Editing a message or rebuilding context must start a new Claude session,
even when its old process is still idle. Ordinary follow-ups keep reusing or
resuming the current session. A transient retry after a reset resumes the
replacement session, not the abandoned one.

```sh
pnpm exec vitest run server/drivers/claude.test.ts server/turn-context.test.ts server/resume-recovery.test.ts
pnpm exec vitest run server/delta-context.e2e.test.ts -t "resets Claude's native context"
```

The second command launches a disposable server and fake CLI through the
shared verification launcher. It creates a conversation, edits the last user
message with `control-omb edit`, and checks the native launch, reset log,
active-branch replay and subsequent resume. Abandoned request/reply markers
must not reach the replacement prompt. It does not exercise a live Claude
account or claim automatic context compaction is implemented.
