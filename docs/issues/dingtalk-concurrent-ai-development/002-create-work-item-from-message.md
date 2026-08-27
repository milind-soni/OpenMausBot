# [002] Create Work Item from message

**Type**: AFK  
**Status**: DONE
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/001-establish-runnable-project-baseline.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Deliver the first user-visible path through a fake DingTalk adapter: accept an explicitly addressed message, resolve or create a non-privileged Principal, persist and deduplicate the event, create or update a Work Item, and publish a concise primary status card through an outbox. Support deterministic references and ambiguous-association handling described by the PRD's DingTalk, aggregation, identity, and messaging sections.

## Ground Truth

- A group member addresses the bot and receives a Work Item identifier and an acknowledgement that means “received,” not “understood” or “completed.”
- Replaying the same external message does not create another Work Item, event, or execution.
- A reply that unambiguously references an existing Work Item supplements that item instead of creating a new one.
- When a message could belong to multiple items, the user is asked to choose rather than having the system silently guess.
- An unresolved external member can contribute information but gains no control authority.

## 完成信号

- [x] Duplicate inbound identifiers produce one durable event and one observable acknowledgement outcome.
- [x] Explicit references deterministically update the referenced Work Item.
- [x] Ambiguous association leaves work blocked until a user selects an outcome.
- [x] The Work Item state and outbound status update commit atomically from the user's perspective.
- [x] Unresolved identities cannot perform any privileged state transition.

## Completion evidence

- Migration v2 adds separate Principal aliases, conversation aliases, external business/transport IDs, Work Items, append-only contributions, association options and transactional outbox records.
- `server/collaboration/inbound.test.ts` covers explicitly addressed creation, received-only wording, business-event deduplication across transport redelivery IDs, explicit ID and reply-chain association, ambiguity without candidate mutation, resolved/unresolved Principal behavior, fake transport ignore behavior, and full transaction rollback when outbox persistence fails.
- Ticket 001 Ledger and Headless service regression suites remain green after the forward migration from schema version 1 to 2.
- Focused strict TypeScript validation passes for every ticket 002 implementation and test file.

## User stories addressed

- E2E-1: Product, test, and development participants contribute to one problem.
- E2E-2: The system groups contributions into a Work Item and displays its structured state.

## Background hints

Model inbound transport IDs, business event IDs, identity aliases, and conversation aliases separately.
