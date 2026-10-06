# Inkbox host tool relay verification

The configured bot mounts the dedicated `integrations.inkbox` stdio proxy.
Only its turn-scoped internal capability enters the child environment, through
`OMB_INKBOX_MCP_TOKEN`; the provider key and upstream session remain in the host.
The relay uses the fixed `https://inkbox.ai/mcp` endpoint, refuses redirects,
bounds JSON/SSE responses, and exposes the identity's live tool catalog.

Protected file links returned by successful provider tools are also readable
through native `resources/read` or the reserved `inkbox_resource_read` tool.
Only exact `inkbox://` URIs in typed MCP resource links or embedded resource
blocks issued for the current connection qualify; grants
are capped at 256 and discarded with the connection session. Another identity's
actor parameter, arbitrary URLs, unissued paths, JSON text and generic
structured content cannot grant access. Native `resources/list` lists only the
currently granted links without upstream discovery. Resource links are rendered as visible URI metadata so
tool-only engines can request the same file. Text and supported images return
as normal tool content. Other binary files return bounded base64 and metadata
explicitly labeled unparsed; this does not claim that a PDF has been read.
Inkbox documents a 512 KiB resource-read file limit. This integration does not
download arbitrary external attachment URLs. Provider prompt templates and
unrelated vault, billing and tunnel administration APIs are outside this relay.

Documented reads have a conservative host allowlist. Every mutation and unknown
tool requires a one-time outbound approval, even if the provider advertises
`readOnlyHint`. The full arguments must fit the 16,000-character review limit;
larger actions fail before an approval is offered. Revoked turns, disconnected
identities, changed bindings, denied requests and stale approvals cannot dispatch
the provider call. An uncertain write is never automatically retried.

Claude, Codex, Pi and the shared Chat Completions runtime recognize the dedicated
host-owned integration so the host hold is the approval authority. A custom MCP
server merely named `inkbox` does not inherit this privilege. ACP engines retain
their native permission boundary and may show an additional permission prompt;
model-authored tool titles are not trusted to suppress that boundary.

## Reproduction

Run from the repository with Node 24 and the disposable verification fixture:

```sh
pnpm exec vitest run server/inkbox-mcp.test.ts server/harness-mcp-proxy.test.ts server/config.test.ts server/mcp-registry.test.ts server/inkbox-mcp.e2e.test.ts
pnpm exec vitest run server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/pi.test.ts -t Inkbox
pnpm exec vitest run server/drivers/openai-chat-tools.test.ts -t 'host-owned Inkbox approval'
```

The first command passed 223 tests on 2026-10-06. The chat-driver regression
first failed because the built-in received a native prompt, then passed both
built-in and custom-name cases after the fix. The full-server fixture verifies
configured-bot-only mounting, dynamic email/call/Slack/A2A discovery, reads,
denied and approved writes, cancellation during a hold, and stale capability
rejection. It writes a `.inkbox-mcp.json` receipt beside its server evidence log.
The passing receipt from this run was
`server-1791297980402-78652.log.inkbox-mcp.json` in the temporary
`openmausbot-verification-evidence` directory.

The final broader affected-driver run passed 594 tests (one skipped) across Claude, Codex, Pi, shared chat MCP tools and Chat Completions tools.

All provider responses and mutations in these tests are synthetic. No real
email, carrier message, call, purchase or provider-account mutation is performed.
The protected-resource extension first failed four focused tests, then passed
the relay/proxy tests and the isolated server test. The server test retrieves an
issued PDF resource through the actual proxy and live internal turn capability;
the receipt includes `protectedResourceRead: true`. Additional unit checks cover
native reads, text/image/binary conversion, catalog-name collisions, forged and
foreign-identity links, revoked turns, bounded grants and reflected-key scrubbing.
Use [the release checklist](inkbox-release.md) for separately authorized live
acceptance and [the fixture guide](README.md) for isolation requirements.
