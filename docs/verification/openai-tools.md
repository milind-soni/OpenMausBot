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

## Computer and browser screenshots

The OpenAI-compatible driver opts into structured image input and mounts the
harness-provided `localComputer` and `browser` stdio descriptors. It does not
discover or grant a desktop itself. Host, VM, VPS and room routing continue to
use the harness's existing ownership and permission gates. The driver's Box
bridge consumes the separately leased cloud descriptor and keeps the selected
API model; other engines retain their native Box runner.

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

### Box bridge

`pnpm exec vitest run server/drivers/chat-box-tools.test.ts server/openai-box.e2e.test.ts`
tests an owned loopback Box/API fixture. It covers direct chats, group member
turns and cloud routines retaining the selected model, screenshots arriving as
image parts, and human control blocking an approved action. Bridge tests cover
each advertised action, invalid arguments, expired control capabilities,
changed ownership and in-flight cancellation without replay.

Model screenshots use native resolution and a separate file from panel frames.
Every action rechecks the harness control gate. Commands run with an isolated
environment; Box and control credentials do not enter model messages. Tests
use synthetic image bytes, not a paid Box account or real desktop input.

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

Cloud routine readiness uses the executing bot’s selected runner (including a
thread’s model override at dispatch), rather than any available cloud engine.
The probe checks the bot-owned or inherited team Box without provisioning or
waking it. Dispatch repeats the check so a removed key or unavailable Box fails
the run before model execution. Explicit Cloud still permits creating/waking
the bot’s own Box; a missing assigned team computer requires explicit repair.

Run `pnpm exec vitest run server/routine-requests.test.ts server/openai-box.e2e.test.ts`
for target selection and the isolated direct/group/scheduled bridge fixture,
including credentials removed after scheduling and a Box outage at dispatch.
