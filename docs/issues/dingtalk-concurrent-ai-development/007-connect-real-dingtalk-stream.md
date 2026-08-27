# [007] Connect real DingTalk Stream

**Type**: AFK  
**Status**: TODO  
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

- [ ] Recorded fixtures for bot messages, card actions, duplicate delivery, late acknowledgement, and reconnect pass through the common adapter contract.
- [ ] Enterprise identity uniqueness includes provider, corporation, identity type, and external identifier.
- [ ] Conversation identifiers and proactive-send identifiers remain distinct unless an explicit alias links them.
- [ ] Card actions use transport-level event identity for deduplication and server-side state for authorization.
- [ ] No test, log, persisted event, or Agent input exposes the application Secret or action token.

## User stories addressed

- E2E-1: Multiple real group participants contribute to one problem.
- E2E-2: Real DingTalk interaction produces a structured Work Item and status.
- E2E-8: Unauthorized card actions are rejected and recorded.

## Background hints

Separate inbound Stream reception, identity resolution, short-lived replies, and proactive/card sending into distinct adapter responsibilities.

