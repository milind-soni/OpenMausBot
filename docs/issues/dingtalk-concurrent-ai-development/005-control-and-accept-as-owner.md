# [005] Control and accept as Owner

**Type**: AFK  
**Status**: TODO  
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

- [ ] At most one active Owner exists under concurrent bootstrap or recovery attempts.
- [ ] Every control transition re-resolves current identity, authorization, aggregate version, and action token.
- [ ] Pause stops new node acquisition and interrupts active execution without deleting evidence.
- [ ] Acceptance is impossible before a valid candidate and its required evidence exist.
- [ ] Rejection records a reason and produces a new revision while retaining prior artifacts.
- [ ] Non-Owner control attempts are denied and audited without changing task state.

## User stories addressed

- E2E-5: Revise a running task without erasing old state.
- E2E-8: Reject unauthorized control actions and record them.

## Background hints

Represent Owner powers as policy capabilities even though only one human may hold them in this product mode.

