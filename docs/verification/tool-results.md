# Bounded built-in tool results

Run the permanent checks from a clean checkout:

```sh
pnpm exec vitest run server/tool-results.test.ts server/drivers/agents-result.test.ts server/drivers/agents-proxy.test.ts server/agent-tool-policy.test.ts server/tool-results.e2e.test.ts
```

The end-to-end test launches the shared `launchVerificationServer` fixture with
its fake engine, temporary home and explicit loopback URL. It uses
`control-omb doctor`, `new-bot`, thread-pinned `send`, `messages`, and
`interrupt`. Profile/task setup uses that same isolated server's HTTP API.
It creates 70 idle profiles to produce a genuinely large roster, then calls
the real provider-mounted agents MCP process. No live models, computers,
credentials, user data or external services are used.

The assertions cover:

- `list_bots` returns a bounded preview and a real saved-result id.
- `tool_result_read` pages the missing text without repeating the original
  operation; every fixture profile remains present across the pages.
- The saved result belongs to both the bot and conversation. Another bot or
  sibling thread cannot read it, even with a valid capability of its own.
- Spoofed conversation ids, unauthenticated requests, oversized writes and
  invalid offsets are refused. Stop revokes the old capability; a fresh turn
  on the same conversation can still read its unexpired result.
- Unit/transport checks cover Unicode boundaries, redaction, expiry, cache
  pressure, missing handles and storage failure. Oversized errors remain
  errors; success is not turned into failure when caching is unavailable.

The test prints a persistent `*.tool-results.json` evidence path next to the
server log, containing the control commands, preview and read outcome. Raw
provider launch dumps and their temporary credentials are never retained.
Cleanup stops the exact fixture children and removes their temporary data.

## Bounds and limitations

Only built-in agents-tool text results are changed. Replies above 24,000 UTF-16
code units receive a prefix of at most 16,000 plus a short notice. Pages use
those same character offsets without splitting surrogate pairs. Cache I/O has
a three-second timeout; the original tool call is not retried or cancelled
by that timeout. Tool errors keep their error status.

Saved text uses the existing secret-redaction rules and is capped at 128 Ki
UTF-16 code units; omitted tails are explicitly marked, never described as
fully saved. Redaction is best-effort, not a guarantee that arbitrary sensitive
prose can be recognized. Results expire after one hour without read-based
renewal, on app restart, or earlier under cache pressure. They are ephemeral,
not another persistent history/backup store. The cache holds at most 128
entries and 16 MiB of UTF-8 text total, with at most 16 entries and 2 MiB per
bot/conversation; expired entries are swept on access. JavaScript string memory
and bookkeeping can exceed the UTF-8 accounting size, but remain bounded.

External MCP trimming, structured shared-computer results, shell command
semantics, automatic retries, provider fallback, model/account selection and
permissions are unchanged. The new read tool is annotated as a local read,
but still requires the live turn's scoped capability. This fixture verifies
the real proxy/server path with a fake provider; it does not prove every live
provider's UI or Windows/Linux packaging. CI must cover those platforms.
