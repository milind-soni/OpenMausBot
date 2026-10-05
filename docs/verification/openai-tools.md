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

One turn stops after 64 model steps, or 200 tool calls in total (each reply
may carry up to 32). The stop says so in one line with one next action: the
steps so far already ran, so ask only for what's left (retrying the whole task
would repeat them). A batch that would pass 200 runs none of its calls. There
is no per-bot or per-thread setting for either number.

The harness proves the OpenAI-compatible adapter and the shared execution
path. It does not establish that every third-party model supports tools, or
that live Grok and MiniMax services accept a particular schema. Model support
and service-specific limits remain separate from the implemented protocol.

## Computer and browser screenshots

The OpenAI-compatible driver opts into structured image input and mounts the
harness-provided `localComputer` and `browser` stdio descriptors. It does not
discover or grant a desktop itself. Host, VM, VPS, Boat and room routing
continue to use the harness's existing ownership and permission gates. A Boat
cloud computer arrives in the same `localComputer` slot as every other
computer (`harness-mcp-proxy computer`), so the selected API model is kept, as
it is for every engine with computer tools.

MCP images become bounded inline image parts. Tool results retain their call IDs;
only after the full tool-result batch is appended does a separate image message
carry labelled screenshots. Image data is not copied into text tool previews.
Computer-enabled MCP transports accept frames up to 32 MiB for screenshots;
ordinary text-only transports retain their 2 MiB limit. Each image is bounded to
20 MiB, with 32 MiB of encoded images retained across the whole turn, including
user attachments. Exceeding the turn budget stops without replaying an operation.
Remote image/computer connections require HTTPS; local loopback HTTP is allowed.
Image-bearing completion requests do not follow redirects. Custom text MCP
servers retain their 2 MiB transport cap even in computer-enabled sessions.
PNG, JPEG, WebP and GIF are accepted; invalid base64/MIME results fail
instead of being reported as successful screenshots.

Native unsigned-number formats and root composition constraints are validated
locally. For computer-enabled requests, root composition constraints appear in
the description rather than the outgoing parameter root, preserving the full
original validator before execution.

The driver contract tests exercise real loopback HTTP and stdio MCP processes:
input-image encoding, computer/browser screenshot delivery, call-ID ordering,
approval denial with no side effect, malformed images and a screenshot larger
than the ordinary text frame limit. They do not use real desktop access or paid
inference, and do not establish vision/tool support for every provider model.

### Boat cloud computer

`pnpm exec vitest run server/cloud-computer-tools.test.ts server/harness-mcp-proxy.test.ts server/openai-boat.e2e.test.ts server/hosted-desktop.e2e.test.ts`
tests an owned loopback Boat/API fixture. It covers direct chats, group member
turns and cloud routines retaining the selected model, screenshots arriving as
image parts, and human control blocking an approved action. The tool tests
cover each advertised action, invalid arguments (checked against the
advertised schema before anything reaches the Boat), expired turn
capabilities and in-flight cancellation without replay. The hosted-desktop
fixture runs the same tools for a Claude bot and proves Boat's own runner is
never asked.

Model screenshots use native resolution and a separate file from panel frames.
Every action rechecks the harness control gate. Commands run with an isolated
environment; the Boat credential stays in the harness, and the agent process
holds only a turn-scoped capability that ends with the turn. Tests use
synthetic image bytes, not a paid Boat account or real desktop input.

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
different tool support. Configured MCP tools are never silently disabled.
An otherwise plain turn initially offers the built-in question tool; only an
explicit unsupported-tools HTTP 400/422 rejection permits one retry without
that optional tool. Authentication, schema and network failures do not trigger
this downgrade, nor does a response after any tool call. The next turn offers
questions again. No fallback replays a requested operation without its tools.

Cloud routine readiness uses the executing bot’s selected runner (including a
thread’s model override at dispatch), rather than any available cloud engine.
The probe checks the bot-owned or inherited team Boat without provisioning or
waking it. Dispatch repeats the check so a removed key or unavailable Boat fails
the run before model execution. Explicit Cloud still permits creating/waking
the bot’s own Boat; a missing assigned team computer requires explicit repair.

Run `pnpm exec vitest run server/routine-requests.test.ts server/openai-boat.e2e.test.ts`
for target selection and the isolated direct/group/scheduled bridge fixture,
including credentials removed after scheduling and a Boat outage at dispatch.
The fixture also holds the Boat readiness response: the execution stays busy,
`wait` cannot report it settled, and Stop prevents dispatch when the response
arrives. Readiness is part of generation-owned setup, not an untracked wait
before turn admission.
