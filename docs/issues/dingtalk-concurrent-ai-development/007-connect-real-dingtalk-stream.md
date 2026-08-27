# [007] Connect real DingTalk Stream

**Type**: AFK  
**Status**: DONE (automated scope; credentialed smoke remains Ticket 009 HITL)
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/002-create-work-item-from-message.md`, `docs/issues/dingtalk-concurrent-ai-development/005-control-and-accept-as-owner.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Implement the production-shaped DingTalk adapter behind the fake adapter contract using the exactly pinned stable Stream SDK. Receive bot messages and card callbacks, normalize text and rich-text references, persist before acknowledgement, resolve internal Principals from enterprise identity aliases, reply through short-lived session channels, and create or update cards through the active-send path. Preserve unknown message types safely and keep credentials outside Git and Agent context.

## Ground Truth

- A member of the configured enterprise group can address the real bot and receive the same Work Item behavior proven by the fake adapter.
- The same DingTalk member is resolved consistently across a normal message and a card action.
- An external or unresolvable member may contribute but cannot gain Owner authority.
- An expired reply channel does not lose task state; the system uses the configured proactive channel or reports a delivery problem.
- Unsupported media is acknowledged as unsupported and is not injected into the Agent as unchecked text.

## 完成信号

- [x] Recorded fixtures for bot messages, card actions, duplicate delivery, late acknowledgement, and reconnect pass through the common adapter contract.
- [x] Enterprise identity uniqueness includes provider, corporation, identity type, and external identifier.
- [x] Conversation identifiers and proactive-send identifiers remain distinct unless an explicit alias links them.
- [x] Card actions use transport-level event identity for deduplication and server-side state for authorization.
- [x] No test, log, persisted event, or Agent input exposes the application Secret or action token.

## Completion evidence

- The npm registry does not publish the requested `dingtalk-stream@2.1.6`; it publishes stable versions through `2.1.5`, and its `latest` tag is `2.1.6-beta.1`. The implementation pins the exact registry-published latest `2.1.6-beta.1` in `package.json` and the pnpm lockfile. This prerelease is restricted to the confirmed non-production milestone until a stable replacement is evaluated.
- `stream-sdk.ts` is the only vendor import. Its implementation was checked against the installed export map and declarations: `DWClient`, `TOPIC_ROBOT`, `TOPIC_CARD`, `registerCallbackListener`, `connect`, `disconnect`, and `socketCallBackResponse`. SDK debug is disabled and its built-in reconnect is not wrapped in a second retry loop.
- Stream messages are strictly allowlisted and bounded. Business `msgId`, Stream `messageId`, callback `eventId`, inbound `conversationId`, and proactive open-conversation IDs remain separate. Rich text extracts only bounded text/mentions; file and unknown payloads become a fixed unsupported sentence, so URLs, download codes, and unchecked media bodies never enter Agent input.
- Message and card-action identities normalize the same stable `senderCorpId + senderStaffId`. Nickname, mutable sender ID, `isAdmin`, and card-provided action/role/Work Item/version claims cannot authorize anything. The bridge forwards only the opaque token, current sender, optional reject reason, and time to Ticket 005.
- Success ACK is emitted only after collaboration ingress or Owner action returns a committed result; idempotent duplicates are also acknowledged. Persist/parse failures remain unacknowledged for Stream redelivery. Callback handlers are registered once, SDK reconnect remains authoritative, and stop/connect races are generation-fenced.
- `sessionWebhook` is validated as HTTPS under `*.dingtalk.com`, kept only in a TTL memory registry, sent with redirects disabled, and never logged or persisted. Expiry/failure falls back only to an explicitly supplied proactive target; missing routing returns a delivery problem without rolling back task state.
- Card callbacks have a separate SQLite transport-event ledger storing only payload hashes and token-free outcomes. Core hashed action-token replay remains the authoritative state-change fence, so a crash between the two databases can replay safely without a second transition.
- `pnpm smoke:dingtalk-stream` is opt-in, defaults to receive-only, emits only hashes/allowlisted metadata, uses a separate data directory, and refuses `ALLOW_SEND=1` until a non-production active-send setup is explicitly configured. Real enterprise credentials, bot, group, template and human card click remain Ticket 009 HITL and were not falsely claimed here.
- Automated verification passes 11 files / 37 tests, focused strict TypeScript passes for every new adapter file and smoke script, `git diff --check` passes, and `pnpm install --frozen-lockfile --lockfile-only --offline` confirms package/lock consistency. A full workspace materialization was retried but remained blocked by DNS for unrelated existing Next.js/workerd tarballs after resolving 686/689 packages.

## User stories addressed

- E2E-1: Multiple real group participants contribute to one problem.
- E2E-2: Real DingTalk interaction produces a structured Work Item and status.
- E2E-8: Unauthorized card actions are rejected and recorded.

## Background hints

Separate inbound Stream reception, identity resolution, short-lived replies, and proactive/card sending into distinct adapter responsibilities.
