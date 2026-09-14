# OpenAI-compatible structured tools

This recipe exercises the shared chat-completions runtime through a real
isolated harness. It uses an offline loopback provider and a synthetic stdio
MCP server that can write exactly one file in the fixture's disposable home.
It needs no provider account, API key, browser, or desktop access.

Run the permanent acceptance test:

```sh
pnpm exec vitest run server/openai-tools.e2e.test.ts
```

`server/openai-tools.e2e.test.ts` launches its own server with
`launchVerificationServer`, then uses `runControlOmb` with the launcher's exact
URL for `new-bot`, `set-model`, `send`, `wait`, `messages`, and `interrupt`.
Configuration and approval go through the fixture's existing HTTP routes;
approval uses `/api/bots/ID/respond`. The fixture explicitly enables each MCP
server after adding it, following the normal disabled-on-create behavior.
The control CLI does not provide an
approval verb.

The assertions prove:

- Tool schemas reach the provider, and arguments fragmented across streaming
  events form one structured call.
- `wait` reports `needs-user` before any file exists. Allowing the pending
  card creates the expected file, returns a result correlated with the
  assistant call ID, and produces a second provider response before settling.
- Denial returns a tool result and lets the model explain it, while the turn
  remains failed and the file remains absent.
- Interrupting while awaiting approval dismisses the card, records an
  unsuccessful tool result, and produces no file and no continuation. The
  existing control `settled` status means the interrupted conversation is idle;
  the tool result carries the unsuccessful operation outcome.
- Text that resembles a call stays text, ordinary responses settle, and
  neither causes execution.
- An explicitly tools-disabled connection sends no `tools`, starts no MCP
  process, and completes direct and room conversations against a provider
  fixture that rejects tool schemas. Its preview also omits tool guidance.
- Saved memory remains in direct, room, and preview prompts without promising
  native filesystem tools that API drivers do not provide.

The test prints `evidencePath`, next to the fixture's retained server log.
The JSON records the control commands, wait states, bounded messages, file
existence, and provider request counts. It does not retain the provider's
headers, MCP environment, or configuration payloads. The launcher stops its
own child and removes its disposable data on exit.

Driver contract tests cover the three shared adapters, protocol errors,
non-streaming responses, tool errors, and lifecycle edge cases:

```sh
pnpm exec vitest run server/drivers/openai-chat-tools.test.ts server/workspace.test.ts
```

The harness proves the OpenAI-compatible adapter and the shared execution
path. It does not establish that every third-party model supports tools, or
that live Grok and MiniMax services accept a particular schema. Model support
and service-specific limits remain separate from the implemented protocol.

## Text-only model connections

Tool support is enabled by default for these three API drivers. For a model
or endpoint that supports only ordinary chat, disable tools explicitly on its
provider instance using the existing instance settings route:

```http
PATCH /api/instances/ID
Content-Type: application/json

{"tools": false}
```

Use the exact instance ID from `pnpm control:omb models --url URL`, and direct
the request only to that explicitly selected server. The route accepts this
setting for OpenAI-compatible, Grok API, and MiniMax API instances, refuses
changes while the instance is busy, and stores `config.tools` on that instance.
Set `tools` back to `true` to enable discovery and execution. This affects all
bots using the instance; use separate configured instances for models with
different tool support. A model response or HTTP error never silently disables
tools. No fallback replays a requested operation without its tools.
