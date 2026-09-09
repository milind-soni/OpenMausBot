# Hindsight memory for individual bots

Hindsight is an optional external memory service. OpenMausBot connects to an
existing service and bank; it does not install Hindsight or configure its models.
Both self-hosted Hindsight and Hindsight Cloud use the same connection form.

## Connect a bot

1. Create a bank in Hindsight for this bot. When available, use an API key
   restricted to that bank.
2. Open the bot's **Settings → Memory → Hindsight**.
3. Enter the server's base URL, existing bank ID, and API key if required.
4. Save, then **Test saved connection**. This reads the bank configuration;
   it does not create a bank or write test memories.
5. Enable Hindsight and save. Only this bot's direct conversations participate.

Each bank can be linked to one bot in this app. An existing bank used by another
application, such as Hermes, can be linked deliberately; that other application
may still read or change it. Different bank IDs separate routing, but access
control is the Hindsight server's responsibility. Prefer bank-scoped keys.

Changing the server or bank clears the saved key unless a replacement is supplied.
API keys require HTTPS, except for a local loopback server (`localhost`, `127.x.x.x`,
or `::1`). Remote self-hosted HTTP connections are allowed without an API key;
use HTTPS to protect conversation text in transit. Previously saved remote HTTP
connections with a key must be reconfigured before use.
Keys are write-only through the API and UI. The server stores them in its private
`config.json` (mode `0600`), like custom MCP credentials; this is not OS-encrypted
storage. They are not added to bot records, provider environments, SSE, or portable
team exports. Only an administrator can configure or test a connection.

## What is remembered

Before a direct turn, OpenMausBot queries the bot's bank using the current user
message. A bounded set of memories accompanies the request as historical data.
Current instructions and explicit local notes take priority. The original
message in OpenMausBot remains unchanged.

After a successful turn with a final text response, OpenMausBot submits the
user's text and final response for asynchronous extraction. Messages delivered
while that turn is running are included as follow-ups. System prompts, reasoning,
attachments and raw tool results are not submitted. The existing secret redactor
also runs at the external boundary; it cannot identify every possible sensitive
fact in prose. Enabling this feature authorizes sending these conversation texts
to the configured service and its memory-processing models.

Groups, peer delegations, routines, webhooks and automatic card continuations do
not use this integration. The existing local `MEMORY.md`, topic files and history
search remain unchanged; there is no automatic migration or synchronization.
Existing mechanisms for sharing local context are not changed by this feature.

## Status and failures

**Refresh status** shows the last connection test, recall, and memory submission
since this server started. A successful submission means Hindsight accepted it
for processing, not that extraction has finished or a new recall can already find
it. Inspect processing and stored facts in Hindsight.

Recall has a three-second deadline and a bounded context. Connection tests and
submissions have an eight-second deadline. Failure leaves the conversation usable
and records a safe error in the card. There is no durable retry queue: failed
submissions are not automatically recovered. Large exchanges exceeding the
submission limit fail visibly rather than being silently truncated. Document and
operation IDs are stable for a provider turn, avoiding duplicate ingestion when
the same operation is sent again.

## Identity and lifecycle

- Renaming the bot, switching models, or starting another task keeps its bank.
- Concurrent conversations use that same bot's bank, with separate recall and
  submission tracking per thread. Stopping one leaves its siblings running.
- Duplicated and imported bots start disconnected, with no copied credentials.
- Disabling or changing a connection cancels pending memory work. A conversation
  already starting can continue without the recalled context.
- Stopping or failing a turn prevents its submission as a completed exchange.
- Disabling cannot remove context already delivered to a provider's native
  conversation. Start a new task to begin without that previous session context.
- Disconnecting or deleting a bot never deletes the external bank. Removing,
  editing or rewinding local messages does not undo facts already sent externally.
  Manage deletion and correction of those facts in Hindsight.

## Development verification

Run `pnpm exec vitest run server/hindsight.test.ts server/hindsight.integration.test.ts`.
The integration suite starts a disposable HTTP harness, a fake Claude CLI and a
fake Hindsight service. It exercises isolation, secret projections, direct-turn
retention, concurrent threads, cancellation, failures, groups and administrator authorization without
using a real provider or memory bank.

For the UI, use the existing isolated
[`verify-bot-settings.ts` fixture](verification/bot-settings.md), then open Memory.
Verify Save, Test, key clearing, bank exclusivity, disabled state, and switching
bots while a read is pending. These fixtures validate the integration contract;
they do not establish compatibility with an unconfigured external installation.

API contracts: [Hindsight reference](https://hindsight.vectorize.io/api-reference),
[retain](https://hindsight.vectorize.io/developer/api/retain), and
[recall](https://hindsight.vectorize.io/developer/api/recall).
