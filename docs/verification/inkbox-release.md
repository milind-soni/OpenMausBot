# Inkbox communication release

This extends the same API-key connection in Settings → Account → Inkbox.
Existing identities, keys and pairing are retained. The configured bot receives
Inkbox tools through a private host relay; its provider API key does not appear
in renderer state, bot environment or a generic MCP configuration.

## Capability boundaries

| Capability | Integration |
| --- | --- |
| iMessage | Owner conversation, questions, action approvals, plain-text replies, typing feedback and persistent task context |
| SMS | Same owner conversation when the identity has a usable phone resource |
| MMS | Read/send through Inkbox tools; signed incoming previews are recorded without trusting ambiguous group membership |
| Email | Read, search, compose, reply, forward and manage mail through available Inkbox tools; incoming mail recorded for review |
| Calls | Available Inkbox call, transcript, readiness and Voice AI tools; ended-call events recorded |
| Slack | Available connection, conversation, search, reply, file and reaction tools; signed incoming activity recorded |
| Agent-to-agent | Available discovery/task tools and incoming task records |
| Contacts and notes | Available identity-scoped Inkbox tools |
| WhatsApp | Not offered by Inkbox's documented API; no unsupported integration is advertised |

Protected attachments returned as typed Inkbox resource links can be read through the same scoped connection. Only previously issued links are readable; message text cannot grant file access. Provider resource reads support files up to 512 KiB. Text/images are returned directly; other binary formats require a compatible document reader and are labeled unparsed.

Tool availability follows the selected identity and Inkbox's live catalog.
Phone resources, workspace installation, provider plans and optional channel
settings may require setup in Inkbox. Connecting Mausbot does not buy numbers
or turn on a hosted voice agent automatically. Inkbox Voice AI is a provider
service, distinct from a direct live voice connection to the local Mausbot bot.

Incoming mail's From field, Slack content, caller transcripts and A2A messages
are not proof of the app owner's authority. Those events do not execute owner
commands. The authenticated, configured phone remains the owner-command path.
An email/Slack reply can be composed and sent by the bot through its normal
approval flow. This release does not implement automatic email or Slack owner
control. It must not be described as that functionality at launch.

## Conversation behavior

Ordinary messages continue the same task, including after restart. `NEW <text>`
explicitly starts another task. A follow-up arriving while the bot works is
saved in a bounded queue rather than discarded. Questions show genuine choices
and simple reply instructions, without request codes. Action approvals show full details and accept `yes`/`approve` or `no`/`deny`, with exact request matching inside the backend. The owner can opt in to automatic ordinary tool approvals with `approve for me`, and return to Ask with `ask me first`. This messaging preference survives restart and is visible in settings; `NEW` returns to Ask. Questions and native proposal/account-connection screens still require their normal answers or app review.

Replies authored before the current approval prompt, including ambiguous same-second timestamps, are rejected with a refresh instruction. Revocation is recorded at authenticated message receipt, before queued work can approve another action.

Initial observation is bounded to 1.5 seconds, followed by background updates,
instead of holding the message processing queue for up to two minutes. Polling
checks every 100 ms during observation. This removes avoidable local queue delay;
it does not guarantee model generation or carrier delivery time. iMessage typing
feedback is best effort and never blocks the reply. Ordinary prose is rendered
as plain text; commands inside approval details stay literal.

## Local acceptance

1. Open the rebuilt OMB2 through its separate test launcher.
2. Open Settings → Account → Inkbox. Confirm your saved connection and discovered
   channel availability. Complete provider-specific setup only for the channels
   you want to use; no need to enter the key again.
3. Send your bot a normal message, then a follow-up referring to its answer.
   Confirm both appear in one task. Restart OMB2 and continue again.
4. Ask the bot to ask a question with choices. Answer with a number or text.
   No question request code should appear.
5. Ask for a harmless action needing approval. Reply `yes` or `approve`; confirm it authorizes only the displayed action. Try `no` or `deny` on another action. Send `approve for me` to test automatic tool approvals, then `ask me first` to restore confirmation.
6. Ask the bot to list available Inkbox channels or read your inbox. Test sending
   only to your own test recipient after checking the approval details.
7. Check incoming email/MMS/Slack/call/A2A activity in settings as applicable.
   Incomplete previews must say so. Inspect full content through the bot tools.

## Synthetic verification

All integration tests use disposable data and fake external endpoints; no
provider account, real email recipient or phone is contacted.

```sh
pnpm exec vitest run shared/channel-text.test.ts shared/channel-replies.test.ts server/channel-conversation.test.ts server/channel-card-guard.test.ts server/channel-answers.e2e.test.ts server/inkbox-owner.e2e.test.ts
pnpm exec vitest run server/inkbox-channel.test.ts server/inkbox-provider.test.ts server/inkbox-setup.test.ts server/inkbox-setup-review.test.ts server/inkbox-setup.e2e.test.ts server/routes/inkbox-setup.test.ts server/inkbox-mcp.test.ts
pnpm exec vitest run src/components/InkboxSetupSection.test.ts src/components/SettingsModal.groups.test.ts src/components/SettingsModal.simple.test.ts
pnpm exec electron scripts/testing/inkbox-setup-ui-smoke.cjs
```

On 2026-10-06, the combined release regression run passed 232 tests across 16 files. The isolated Electron setup smoke passed its five-screen flow, including channel availability and a narrow layout. Lint and locale validation passed. Independent conversation, transport/migration and host-tool reviews found no remaining blocking issues after fixes. Provider calls in these checks were synthetic.

Final package checks and broader engine results are recorded in the local test kit's BUILD.txt.
Use the [main verification guide](README.md) for fixture isolation rules.

## Official contracts

- [Generic MCP capabilities and authentication](https://inkbox.ai/docs/mcp-server)
- [Resource, event and trust contract inventory](../superpowers/specs/2026-10-06-inkbox-contracts.md)
