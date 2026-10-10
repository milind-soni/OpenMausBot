# Greenference provider

Run:

```sh
pnpm exec vitest run server/greenference.e2e.test.ts server/drivers/greenference.test.ts server/drivers/openai-chat-tools.test.ts server/config.test.ts server/provider-key-check.test.ts
```

The end-to-end test launches a disposable server with `launchVerificationServer`
and a loopback HTTP provider. It saves and replaces synthetic tokens, discovers
models, creates a bot, sends two real harness turns, rejects a later token, and
clears the connection. It also proves that a successful public catalog check
does not erase the failed authentication state. Public configuration, messages,
events and retained server logs must not expose the tokens. It saves the exact
fixture URL, retained log path and result counts beside that log in
`openmausbot-verification-evidence/server-*-greenference.json` under the OS temp
directory, then stops its own server and removes only its disposable workspace.

Driver tests check catalog parsing, failed refreshes, context sizes, image and
text-only model requests, SSE keepalive/usage handling, and endpoint-scoped
credentials. The shared tool contract also runs through the Greenference
driver using real loopback HTTP and stdio MCP processes: tool execution,
continuation, approvals, denial, cancellation and failure receipts.

These tests do not verify a real Greenference token, billing, every model's
tool quality, or interaction with the Settings UI. For live acceptance, use a
separate disposable workspace, add your own token through Settings, choose a
tool-capable model from the live list, and check a short chat plus a harmless
read-only tool call. Never put the token in a prompt or a test log.
