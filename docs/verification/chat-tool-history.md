# Complete chat tool history

Upstream already preserves the clocks and context notes carried by earlier user
messages. This change retains a bounded complete provider exchange, including
tool calls/results, supported reasoning, images, and final replies. A follow-up
can reuse it while canonical IDs and text, the model, stable instructions,
execution policy, and mounted catalog fingerprint still agree. An anchored
suffix lets the durable replay window slide without rewriting the retained wire
prefix. Changed volatile context rides a complete snapshot on the newest turn.

The retained wire history is in memory, bounded by thread count, message count,
and serialized bytes. Reset, interruption, incomplete replies, failed cleanup,
and invalid history rebuild safely. The upstream delivered-user fallback remains
bounded and strips earlier automatic recall. Its records also check canonical
IDs when available and are scoped to the model, stable instructions, policy,
and catalog fingerprint.

A definite provider context-limit rejection can rebuild a reused prefix once,
before any output, tool activity, or steering. The replacement uses a fresh
image-retention budget. Other provider errors do not trigger this recovery.
Complete final replies after denied or failed tool calls retain their recorded
exchange while the turn still reports failure. Recorded history does not execute
an operation again; an explicit retry requires a fresh approval.

Run the focused checks from the repository root:

```sh
pnpm exec vitest run server/drivers/openai-chat.test.ts server/drivers/openai-chat-context.test.ts server/drivers/openai-chat-catalog.test.ts server/drivers/openai-compat.test.ts server/cache-continuity.e2e.test.ts
pnpm typecheck
pnpm lint
```

The direct-chat acceptance fixture uses disposable data and a loopback synthetic
provider. It records requests and command results beside its persistent server
log, verifies no write after denial, a preserved next-request prefix, and one
write only after a new approval. Current-upstream replay, recall-budget, and
identical-text ancestry tests remain unchanged. Separate benchmarks must measure
the remaining gain over that current upstream behavior.
