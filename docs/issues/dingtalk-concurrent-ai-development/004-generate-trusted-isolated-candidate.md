# [004] Generate trusted isolated candidate

**Type**: AFK  
**Status**: TODO  
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/003-clarify-and-publish-plan.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Execute the sequential graph against a disposable Git repository. Lock a committed base SHA, create a managed worktree and AI branch, run one configured Developer Agent, compare the actual diff with declared write boundaries, create a traceable local candidate commit, and collect target-test evidence through a deterministic command executor. Render precise completion language as required by the PRD's Git, quality, security, and evidence sections.

## Ground Truth

- A definition-ready task modifies only an isolated worktree and never the user's default working directory.
- The resulting candidate identifies its base, Work Item, plan, node, and run without impersonating a human author.
- A user can distinguish “modified,” “target tests passed,” “full gate passed,” “failed,” and “not verified.”
- A change outside its declared scope is rejected as a candidate and remains inspectable in isolation.
- A request requiring unconfigured network access or dependency installation stops for configuration instead of silently changing the machine.

## 完成信号

- [ ] The default branch and original working directory remain unchanged after candidate generation.
- [ ] Candidate metadata links the immutable base and every execution aggregate needed for an audit trace.
- [ ] Only configured commands can produce trusted test evidence.
- [ ] Target-test success is never represented as full-gate success.
- [ ] Denied-path or out-of-claim modifications invalidate the candidate and produce an observable reason.
- [ ] Time, attempt, command, and resource limits stop runaway execution.

## User stories addressed

- E2E-3: Produce implementation and test work from a structured plan.
- E2E-4: Use an independent worktree for each writing node.
- E2E-7: Report partial and complete quality states accurately.

## Background hints

Keep Git and command execution deterministic; the Agent expresses intent but does not own lifecycle operations.

