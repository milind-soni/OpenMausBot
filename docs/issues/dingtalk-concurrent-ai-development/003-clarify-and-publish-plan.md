# [003] Clarify requirements and publish plan

**Type**: AFK  
**Status**: DONE
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/002-create-work-item-from-message.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Turn accepted Work Item events into an executable contract. Maintain a versioned snapshot of goal, repository, facts, assumptions, and observable acceptance conditions. Ask up to three currently answerable clarification questions when the contract is incomplete. Once definition-ready, generate and deterministically validate a sequential analyze → modify → validate → report Work Graph and start it automatically. Incorporate the PRD's requirement aggregation, graph revision, state-machine, and runtime-change rules.

## Ground Truth

- A user submitting an incomplete request sees the missing decisions and recommended answers instead of premature code execution.
- Answering the outstanding questions changes the task from waiting for clarification to ready for execution.
- A definition-ready task automatically publishes a visible plan and begins isolated work without an extra ceremonial approval.
- A new requirement received during execution creates a new plan revision without erasing the previous plan or its evidence.
- A plan that is cyclic, malformed, over-budget, or outside configured capabilities never starts.

## 完成信号

- [x] Missing goal, repository, acceptance conditions, or blocking ambiguity prevents execution.
- [x] Independent clarification questions are grouped while dependent questions wait for a later round.
- [x] A valid task creates an ordered, acyclic graph with supported node types and configured Agent identities.
- [x] A changed requirement creates a new immutable revision and classifies existing nodes as valid, revalidation-needed, or obsolete.
- [x] Invalid plans enter an observable planning failure state instead of being silently repaired by deleting constraints.

## Completion evidence

- Accepted Work Item events automatically create a durable snapshot and clarification frontier; structured answers revise that snapshot without dispatching a Provider.
- Readiness requires a confirmed goal, allowlisted absolute repository, observable acceptance evidence and zero blocking ambiguity. Dependency-aware questions expose at most three current decisions.
- Planner output starts as `unknown`, passes strict structural parsing, then deterministic checks for fixed node sequence, identity, dependency, acyclicity, scopes, commands and budgets.
- Schema v3 stores immutable snapshots/revisions, planning attempts, structured node contracts, a current-plan pointer, inactive superseded nodes, classification evidence and latest-card outbox supersession.
- Tests cover automatic event ingestion, clarification prerequisites, valid publication, malformed/cyclic/over-capability failure, immutable revision history, valid/revalidate/obsolete classification and stale-planner fencing.

## User stories addressed

- E2E-2: Display the structured problem and acceptance conditions.
- E2E-5: Add acceptance conditions during execution through a new plan revision.

## Background hints

Treat model output as an untrusted proposal and place all executable validation in deterministic code.
