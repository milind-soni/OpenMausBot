# [004] Generate trusted isolated candidate

**Type**: AFK  
**Status**: DONE
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

- [x] The default branch and original working directory remain unchanged after candidate generation.
- [x] Candidate metadata links the immutable base and every execution aggregate needed for an audit trace.
- [x] Only configured commands can produce trusted test evidence.
- [x] Target-test success is never represented as full-gate success.
- [x] Denied-path or out-of-claim modifications invalidate the candidate and produce an observable reason.
- [x] Time, attempt, command, and resource limits stop runaway execution.

## Completion evidence

- Schema v4 persists fenced Runs, filtered runtime events, immutable Candidate attempts, immutable TestEvidence and fail-closed execution audit records.
- The executor requires an exact allowlisted repository and full configured base SHA, generates its own branch/worktree, passes a deny-network sandbox contract to the injected Agent, rejects Agent-created commits and rechecks the current plan before trusting a candidate.
- Git inspection uses argv-only processes and NUL-delimited path output, including tracked deletion/rename endpoints, untracked files and ignored secret files. Deny paths, out-of-claim paths, symlinks and Git metadata mutation stop before commit.
- Commits disable hooks/signing, use the fixed `OpenMausBot <bot@local.invalid>` identity, include Work Item/plan/node/run/base trailers, and must have exactly the locked base as their sole parent.
- Target commands are selected by configured ID and literal argv. Network/install commands, escaping cwd, timeouts, output floods, Agent timeouts and stale plans fail closed.
- Automated Git fixtures prove original HEAD/index/status/sentinel content remain unchanged, accurate target/full-gate wording, late-event filtering, candidate traceability and retained invalid worktrees.

## User stories addressed

- E2E-3: Produce implementation and test work from a structured plan.
- E2E-4: Use an independent worktree for each writing node.
- E2E-7: Report partial and complete quality states accurately.

## Background hints

Keep Git and command execution deterministic; the Agent expresses intent but does not own lifecycle operations.
