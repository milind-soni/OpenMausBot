# [006] Recover and degrade safely

**Type**: AFK  
**Status**: TODO  
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/004-generate-trusted-isolated-candidate.md`, `docs/issues/dingtalk-concurrent-ai-development/005-control-and-accept-as-owner.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Make the vertical loop durable under duplicate input, process restart, Provider interruption, stale card actions, outbound failure, and storage or audit failure. Add a single-active-scheduler lease with fencing, bounded retries and Provider circuit breaking, recoverable node inspection, versioned outbox delivery, safe worktree retention, and fail-closed behavior described in the PRD's recovery, reliability, and rollout sections.

## Ground Truth

- Restarting the service does not duplicate a candidate, lose a pending task, or falsely report a stopped Agent as running.
- A completed candidate found after restart proceeds to validation instead of being generated again.
- A stale status-card button cannot overwrite newer task state.
- Temporary DingTalk delivery failure delays notification without rolling back valid internal work.
- When the ledger or audit trail cannot be written, users see a degraded state and no new code-writing action begins.

## 完成信号

- [ ] Replayed inbound events and actions remain exactly-once at the business-state level.
- [ ] A stale scheduler cannot commit results after a newer scheduler acquires the instance lease.
- [ ] Recovery distinguishes resumable, candidate-produced, interrupted, and unsafe-to-retry work.
- [ ] Outbound retries suppress obsolete card versions and eventually deliver the newest state.
- [ ] Repeated Provider failure opens a bounded circuit and stops new dispatch to that Provider.
- [ ] Worktrees and evidence remain available through their configured retention period after failure or cancellation.

## User stories addressed

- E2E-5: Preserve revision history through execution changes.
- E2E-10: Recover pending work, execution, and user interaction after service restart.

## Background hints

Use durable uniqueness and optimistic transitions rather than in-memory promises or SDK deduplication.

