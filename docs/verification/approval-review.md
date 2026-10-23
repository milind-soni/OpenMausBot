# Configurable approval review verification

This branch is independently based on upstream 0.1.122 (`087f01f31`). It adds isolated
review for app-owned Auto gates and Claude when its native reviewer explicitly
reports inactive. A native active or unknown reviewer remains authoritative.

Run the unit and isolated HTTP checks:

```sh
node_modules/.bin/vitest run server/approval-review.test.ts server/approval-review.e2e.test.ts server/drivers/openai-chat.test.ts server/drivers/meta.test.ts server/drivers/claude.test.ts server/drivers/claude-accounts.test.ts src/components/ApprovalReviewSettings.test.ts
node_modules/.bin/tsc -b
node_modules/.bin/tsc -p tsconfig.server.json
```

The HTTP test launches a disposable fake-engine server and loopback model/MCP
services. Its tools only write fixed artifacts inside the fixture. It checks
allow, deny, Ask fallback, exact model routing, persisted settings, reasoning
`none`, and stale-review refusal. Working-agent effort remains unchanged.

The separate settings smoke mounts the real settings component in a disposable
Electron profile. These checks establish synthetic behavior only; they make no
live model, Splash, mailbox, or user-workspace calls.

Reviewer effort defaults to None when the provider advertises it, otherwise
the lowest advertised effort (Low for Claude). Variant-only providers retain
their exact variant without adding an effort. An explicit unsupported effort
is refused rather than replaced. The working agent’s effort is unchanged.
OpenCode reviews use a fresh ACP process with no MCP servers, no client file or
terminal access, and denied native tools. The selected model and variant must
be acknowledged before the prompt; otherwise the action goes to the person.
The stable rubric and authorization evidence precede each exact
action, and oversized or incomplete evidence falls back to a human card.

On 2026-10-21, OpenCode v2.0.32 reviewed a synthetic read through the local
Splash model in a temporary profile and returned `allow`. No proposed tool ran.
This checks the real ACP route; the fake ACP tests cover exact variant selection
and failure handling.

Claude Code 2.1.296 reports Low through Max, without None, in its read-only
`--help` metadata. The native fixture rejects unsupported flags independently;
review routing verifies Low reaches the CLI, while API review still sends None.
The real settings fixture checks the supported default and API refusal of an
explicit unsupported Claude effort.

The judge-only model evaluation also covers tool discovery during an authorized
cleanup, a recoverable Trash retry after the original report leaves recent
context, an explicitly protected message included in a batch, and permanent
deletion proposed when only Trash was requested:

```sh
node --experimental-strip-types scripts/eval-approval-review.ts --url http://127.0.0.1:PORT/v1 --model EXACT_MODEL --effort none --skip-cache-probe --output /tmp/approval-review-evaluation.json
```

This evaluation submits text to the selected loopback model and never executes
any proposed tool. Category-based permission survives equivalent API retries;
opaque IDs alone do not revoke an explicit selection of the reviewed batch.
Conflicting target evidence and explicit keep exceptions still block execution.
Moving to Trash does not grant permission for permanent deletion. These are
model evaluations, not evidence that any mailbox operation completed.
