# [005] Control and accept as Owner

**Type**: AFK  
**Status**: DONE
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/002-create-work-item-from-message.md`, `docs/issues/dingtalk-concurrent-ai-development/004-generate-trusted-isolated-candidate.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Implement the confirmed single-Owner product model across bootstrap, authorization, Work Item controls, and dynamic status-card actions. Other members may create and supplement work, while only the one active Owner may pause, resume, retry, cancel, accept, reject, or administer it. Separate engineering completion from business acceptance and preserve rejected candidates as evidence, following the PRD's identity, policy, status, and interaction sections as amended by the grilling decisions.

## Ground Truth

- The service machine can bind exactly one stable DingTalk identity as Owner through a one-time local bootstrap flow.
- A non-Owner sees task status but cannot perform any control action, even by replaying or forging an old button payload.
- The Owner can pause and safely resume running work without losing its recorded history.
- Accepting a completed candidate closes the business task without merging or deploying it.
- Rejecting a candidate requires a reason, preserves the old candidate, and creates a revised task; cancellation ends work without pretending it was rejected.

## 完成信号

- [x] At most one active Owner exists under concurrent bootstrap or recovery attempts.
- [x] Every control transition re-resolves current identity, authorization, aggregate version, and action token.
- [x] Pause stops new node acquisition and interrupts active execution without deleting evidence.
- [x] Acceptance is impossible before a valid candidate and its required evidence exist.
- [x] Rejection records a reason and produces a new revision while retaining prior artifacts.
- [x] Non-Owner control attempts are denied and audited without changing task state.

## Completion evidence

- Schema v5 adds append-preserving Owner binding history, a partial unique index permitting at most one active Owner, Work Item/node control state, Run interrupt requests, hashed versioned action tokens, immutable control events, and generalized control audit fields.
- `LocalOwnerRegistry` permits exactly one local bootstrap. Recovery atomically revokes the old binding and inserts a new stable `senderCorpId + senderStaffId` binding only when the expected generation is current; it never executes a business action.
- All six Work Item actions use one capability policy. The current DingTalk identity is resolved again for every click, and nickname, mutable sender ID, unresolved identity, old Owner generation, stale aggregate version, wrong candidate SHA, expired token, forged token, or replay cannot create a second transition. `system.admin` uses the same sole-Owner rule; no other administrator or co-signing role exists.
- Card actions receive 256-bit opaque tokens while SQLite stores only SHA-256 hashes, token version, exact Work Item version, candidate SHA where applicable, Owner generation, and expiry. A contributor denial does not burn the Owner token; an authorized stale/invalid decision consumes it once; replay returns the stored decision without re-executing.
- Pause and cancel atomically mark running Runs for interruption. The executor rechecks active control state inside its Run-start transaction, observes persisted interrupt requests, calls `AgentRunPort.interrupt`, stops accepting late events, and retains the Run, prior runtime events, candidate attempt, worktree, and audit trail. Resume makes interrupted nodes eligible for an explicit retry without deleting history.
- Accept requires the exact candidate on the current plan, `target_tests_passed`, and a passing evidence row for every configured validate command. It closes business acceptance only; it does not merge or deploy.
- Reject requires bounded non-empty feedback, retains the old Candidate/Run/TestEvidence, appends a new Work Item snapshot revision carrying that feedback, retires the old plan, and returns the task to collecting. Cancel records a distinct control event and does not create a rejection revision.
- State mutation, token consumption, immutable control event, and allow/deny audit are one SQLite transaction. A forced audit-write failure proves the entire transition and interrupt request roll back fail-closed.
- Focused verification passes 10 files / 53 tests, strict TypeScript passes for every changed and new 005 file, and `git diff --check` passes. Repository-wide server typecheck remains blocked only by the pre-existing minimal-environment React type errors in `src/lib/drafts.ts`.

## User stories addressed

- E2E-5: Revise a running task without erasing old state.
- E2E-8: Reject unauthorized control actions and record them.

## Background hints

Represent Owner powers as policy capabilities even though only one human may hold them in this product mode.
