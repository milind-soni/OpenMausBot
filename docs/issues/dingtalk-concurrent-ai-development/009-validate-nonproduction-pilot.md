# [009] Validate non-production pilot

**Type**: HITL  
**Status**: IN PROGRESS (`automated_fake` complete; real non-production pilot pending)
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/007-connect-real-dingtalk-stream.md`, `docs/issues/dingtalk-concurrent-ai-development/008-operate-secure-headless-service.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Configure and execute the first real, non-production pilot using an enterprise internal DingTalk application, one active Owner, one project group, an always-on host, and a disposable or non-production repository. Exercise the complete first-milestone journey and capture an acceptance report. This ticket validates the PRD's end-to-end scenario only through local candidate generation; deployment, default-branch merge, multi-Agent concurrency, and the full console remain out of scope.

## Ground Truth

- Real group participants can contribute to a single Work Item while only the configured Owner can control or accept it.
- A clear requirement travels from DingTalk through planning and isolated code execution to a local candidate with test evidence.
- The Owner can pause, resume, reject with feedback, retry, cancel, and finally accept a valid candidate from the status card.
- Duplicate messages, stale card actions, a service restart, and a temporary outbound failure do not corrupt or duplicate the task.
- The default branch, production systems, and unrelated repositories remain unchanged throughout the pilot.
- The Owner can trace the final outcome back to its group events, plan revision, run, base SHA, candidate SHA, tests, and audit events.

## 完成信号

- [ ] A real Stream message completes the full first-milestone flow on a non-production repository.
- [ ] Duplicate delivery creates one Work Item event and one Agent Run.
- [ ] Every non-Owner control attempt is rejected without changing state.
- [ ] Pause, cancellation, rejection, restart recovery, and stale-action scenarios produce the expected observable state.
- [ ] Candidate code exists only on its managed local branch and carries deterministic test evidence.
- [ ] The acceptance report records all pass/fail observations and any deviations from the confirmed PRD.

Manual fallback: the Owner performs the flow in the configured pilot group, observes each status-card transition, inspects the candidate and evidence through the controlled view, and signs the resulting acceptance report.

## Automated fake rehearsal delivered

- [x] `pnpm pilot:collaboration:fake -- --output <owner-only-directory>` runs a production-isomorphic rehearsal against real SQLite and a disposable Git repository.
- [x] The rehearsal covers duplicate ingress, outbound retry/supersession, one Owner and non-Owner denial, pause/resume/retry/reject/stale action/final accept, and a separate cancel scenario.
- [x] Restart uses the same data directory; low disk and mandatory audit-write failure remain fail-closed.
- [x] The candidate exists only on a managed local branch; the original default branch, index, status, and sentinel remain unchanged; no remote push is attempted.
- [x] One validated JSON source of truth and its generated Markdown view are written atomically with mode `0600`, using hashed external identities and paths and excluding action tokens, credentials, and session webhooks.
- [x] The report records the explicit `dingtalk-stream@2.1.6-beta.1` prerelease deviation.

The automated report is intentionally `scope: automated_fake` and overall `status: pending`. It is not evidence that a real DingTalk or host pilot passed. The original completion signals above remain unchecked until the sole Owner executes and signs the real non-production pilot; no manager, co-signer, or countersignature is part of that process.

## User stories addressed

- E2E-1 through E2E-10 as applicable to the confirmed first milestone.
- First-milestone completion definition agreed during grilling.

## Background hints

Use real credentials only through the host's secure credential mechanism; never place them in fixtures or repository files.
