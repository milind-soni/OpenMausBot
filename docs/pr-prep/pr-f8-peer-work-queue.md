# PR F8 — Queue peer work while a bot is busy

## Title

feat: queue peer work for busy bots

## Scope

Make valid bot-to-bot messages behave like queued human messages when the target bot is already working. A peer request should be accepted, tracked, and run when the target becomes available instead of returning a busy response or being cancelled later because the target was busy.

The behavior is similar to Grok Bot's per-agent run scheduling and asynchronous agent messaging: work is queued against the agent, execution remains exclusive, and the sender receives a later result rather than holding the target turn open. The implementation remains native to OpenMausBot's existing event, transcript, approval, and provider contracts.

This branch implements the contract below in the runtime scheduler, durable work-order store, delegation/consultation paths, and regression suite. The existing event, transcript, approval, and provider contracts remain the integration boundaries.

## Problem

- A synchronous peer question can return a busy result when the target is already executing.
- An asynchronous delegation can be accepted and then cancelled when the target is still busy at drain time.
- Waiting inline for a busy target can block the source bot and create a peer-to-peer deadlock.
- The existing human-message fallback queue is intentionally scoped to direct 1:1 messages and cannot safely be reused for peer work without preserving source identity, approval, depth, and delivery state.
- A queued peer request needs a truthful lifecycle and a durable result so it cannot silently disappear during a restart.

## Proposed behavior

### Per-bot execution scheduling

Add one exclusive execution lane per bot, keyed by bot identity rather than conversation identity. The scheduler owns pending work in four FIFO lanes:

```text
user > urgent peer > normal peer > background
```

The scheduler must:

- allow exactly one provider turn to execute for a bot at a time;
- choose the next pending run by lane priority without interrupting an active run;
- preserve FIFO order within each lane;
- allow different bots to execute concurrently;
- keep pending work separate from the active `busy` state;
- release the lane after synchronous failures, provider failures, interruptions, and safe watchdog settlement;
- prevent a late completion from settling a newer run;
- support deduplication, pending cancellation, bounded queue diagnostics, and typed capacity failures;
- reserve capacity for human messages so peer traffic cannot starve user work.

All normal bot executions must enter through this scheduling boundary, including direct messages, room responders, routines, webhooks, connector continuations, and peer work. Existing live steering remains available only where the provider explicitly supports it.

### Durable peer work orders

Represent consultations and delegations as durable work orders with explicit transitions:

```text
pending source
  → awaiting approval | queued | cancelled | failed

awaiting approval
  → queued | cancelled | failed

queued
  → running | cancelled | failed

running
  → completed | failed | cancelled
```

Terminal records are immutable. Every transition is persisted before it is broadcast. Stored result and error text is redacted for credential-shaped content, while the original user-authored request remains unchanged.

Each work order pins:

- the source bot and source task that created it;
- the exact source execution that created it;
- the target bot and target task selected at acceptance time;
- the request, reason, priority, depth, delivery mode, and attempt count;
- the channel and activity context used for visibility.

Queued work must run in its pinned target task. If that task or either bot is deleted, the work order reaches an explicit terminal failure or cancellation state instead of being silently redirected.

### `delegate_bot`

Delegation validates the sender, target, section, depth, task ownership, approval state, and queue capacity before accepting the work order. The target's current `busy` value is not a rejection condition.

The tool returns an acceptance receipt containing the work-order identifier, target identity, queue position, and a clear statement that acceptance is not completion. The source bot is free to continue its own turn.

Approval waits outside the target execution lane. After approval, the sender, target, section, pinned tasks, and depth are revalidated before the target is queued.

### `ask_bot`

Keep the current inline reply behavior only when the target can start immediately and no approval is required. Otherwise, accept a deferred consultation and return promptly so the source bot cannot deadlock behind the target.

When a deferred consultation completes:

- record the terminal result on the work order;
- mirror the result or failure into the existing bot-to-bot channel;
- append the terminal activity to the pinned source task;
- queue a hidden continuation on the source bot in the matching peer lane;
- coalesce multiple completed consultations for the same source task;
- mark the delivery undeliverable if the source bot or pinned task no longer exists.

The continuation must not receive peer tools or create a new peer chain. The source bot must be told that the earlier receipt represented acceptance, not completion.

### Existing human queue integration

Preserve the current human-message experience:

- provider-supported live steering continues unchanged;
- fallback messages return an accepted queue receipt;
- pending messages remain out of the active transcript until the follow-up begins;
- multiple messages for one task can be coalesced in order;
- the user lane always outranks pending peer and background work;
- existing pending chips and queue identifiers continue to work.

The human queue and peer work orders share the scheduler's execution boundary, but they retain their different transcript, approval, cancellation, and delivery semantics.

## Recovery and visibility

On startup:

- queued work orders are reconstructed into the scheduler;
- approval-waiting work orders receive fresh approval requests after stale cards are dismissed;
- work orders waiting for a source execution are cancelled because the source turn cannot survive a restart;
- work orders that were running are marked failed with an explicit restart reason and are not replayed automatically;
- terminal history is retained within a bounded limit, pruning only the oldest terminal records.

Expose bounded work-order listing, detail, and cancellation operations. Broadcast every accepted transition through the existing event stream. Existing activity chips, bot-to-bot channels, pending message indicators, and busy state remain the primary user-facing surfaces; a new management page is not part of this change.

## Safety and compatibility

- Preserve the one-hop peer depth limit.
- Do not provide peer tools to peer-invoked target turns or result continuations.
- Keep source and target section membership checks.
- Do not allow self-messaging, deleted targets, deleted pinned tasks, or stale source executions to proceed.
- Keep approval and “always allow” behavior unchanged except that approval no longer occupies the target's execution lane.
- Do not interrupt an active provider turn in this change.
- Do not allow multiple provider turns for one bot.
- Do not introduce a runtime dependency.
- Do not modify generated build output.
- Do not copy implementation code from the Grok Bot reconstruction; use its scheduling behavior as a reference only.

## Relationship to existing work

This is a distinct change rather than a duplicate of the existing queue and delegation PRs:

- the merged human-message queue establishes the direct-user fallback behavior;
- the merged peer-communication work establishes approval, asynchronous delegation, depth limits, and visibility;
- the merged delegation persistence work establishes restart-safe storage for the existing handoff path;
- the merged channel-visibility work establishes terminal result mirroring;
- this change unifies execution admission and adds the missing peer queue semantics, durable lifecycle, deferred consultation delivery, and cross-entry-point exclusivity.

## Tests

Add deterministic coverage for:

- one active execution per bot;
- concurrent execution for different bots;
- strict lane priority and FIFO ordering;
- user work overtaking peer and background work;
- urgent peer work overtaking normal peer and background work without overtaking user work;
- no active-turn preemption;
- synchronous and asynchronous execution failures releasing the next run;
- deduplication, cancellation, capacity limits, and diagnostics;
- late settlement isolation between scheduler generations;
- work-order persistence, reload, transition validation, terminal immutability, redaction, task pinning, approval, and recovery;
- busy-target delegation remaining queued and eventually running;
- busy consultation returning promptly and delivering its result later;
- deferred-result continuation coalescing;
- rooms, routines, webhooks, connector resumes, and direct messages sharing the same per-bot exclusion;
- deletion, task switching, depth limits, approval denial, provider failure, watchdog settlement, channel mirroring, and undeliverable results;
- peer and continuation turns receiving no peer tools.

Tests must wait on fake-driver events, promises, state changes, or event-stream frames. Fixed sleeps are not acceptable.

## Validation before submission

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `git diff --check`
- [ ] No generated output, lockfile churn, or unrelated feature changes
- [ ] No regression in the existing human queue, approval flow, routine receipts, or channel visibility

Focused validation for this implementation also covers the scheduler, durable work-order store, busy-target delegation, comms integration, and server-index integration suites. Repository-wide lint currently reports anti-slop findings across the server tree; the passing typecheck, build, and focused suites are the implementation-specific gates used here.

## Definition of done

- A valid peer message is accepted while the target is busy.
- No peer path reports or cancels solely because the target is busy.
- Exactly one provider turn executes for a bot at any moment across all conversation types.
- Pending human work always runs before pending peer or background work.
- A busy consultation cannot hold the source provider turn open indefinitely.
- Every accepted work order is durably queued, awaiting approval, or terminally settled.
- Queued work recovers safely after restart; running work is not replayed automatically.
- Approval, depth, section, deletion, task-pinning, and unattended safety rules remain intact.
- The complete repository checks pass before the PR is opened.

## Non-goals

- Active-turn preemption for urgent peer work.
- Resuming an interrupted provider turn.
- Multiple simultaneous turns for one bot.
- Raising the one-hop peer recursion limit.
- Replacing the transcript or event-stream architecture.
- A new work-order management screen.
