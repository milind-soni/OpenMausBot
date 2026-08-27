# Worktree Branch Notes — codex/009-nonproduction-pilot
<!-- Auto-created by parallel-dev. Agents MUST update this file during development. -->
<!-- Stored at .parallel-dev/logs/<branch-slug>/branch-notes.md. -->
<!-- merge-learnings.py aggregates it into docs/parallel-dev-learnings.md by default. -->

## Meta
- **Branch:** codex/009-nonproduction-pilot
- **Phase:** auto-detect
- **Started:** 2026-08-28 04:02
- **Base commit:** 4e70942
- **Files:** `scripts/collaboration-pilot/**`, `docs/pilot/**`, `package.json`, `docs/issues/dingtalk-concurrent-ai-development/009-validate-nonproduction-pilot.md`

---

## Dependencies
<!-- Branches this worktree depends on. merge-and-learn.sh uses this for topological merge ordering.
     Format: one branch name per line (plain text, no markdown link).
     Leave empty if this worktree has no upstream dependencies.
     Example:
       - feature/phase1-models
       - feature/phase2-api
-->


---

## Architecture Decisions
<!-- Record every non-trivial design choice made in this worktree.
     Format: ### <decision title>
     - Context: why did this decision arise?
     - Choice: what was chosen?
     - Rejected alternatives: what else was considered and why rejected?
     - Consequence: what does this lock in or enable?
-->
### Decision: Rehearse through the production headless runtime and controllers
- Context: Ticket 009 needs deterministic automation without claiming that real DingTalk, host, or human checks passed.
- Choice: Use `CollaborationHeadlessRuntime` for lifecycle, ingress, execution, outbox, and restart, and production Owner/planning controllers against the same SQLite Ledger; inject only fake external ports and a disposable Git repository.
- Rejected alternatives: A standalone pilot state machine would duplicate domain behavior, while real credentials or deployment would exceed the authorized automated scope.
- Consequence: Automated reports use `scope: automated_fake`, keep real checks pending, and can detect regressions in the production-isomorphic path without external side effects.

### Decision: Make acceptance evidence closed and non-textual
- Context: A syntactically valid report could otherwise claim a fake overall pass, reference unrelated audits, or smuggle paths, prompts, or opaque credentials through free-text fields.
- Choice: Enforce cross-field pass/sign-off rules, per-scenario Work Item/event/run/audit references, action-level audit links, enum control/check codes, digests, repository-relative paths, and a report-local trusted command ID-to-definition-hash registry.
- Rejected alternatives: Regex-only secret scanning and a fake-only hard-coded command ID were rejected because they neither prove trace integrity nor support the later real repository pilot.
- Consequence: Automated fake reports remain pending and unsigned; real reports can pass only with complete evidence and one Owner signature, while raw command text and unregistered command IDs cannot enter artifacts.

---

## API Contracts
<!-- New endpoints introduced in this phase.
     Format: METHOD /path — one-line description
     Variables / request body schema (key fields only)
     Response: key fields
-->


---

## Business Rules Discovered
<!-- Rules that are NOT obvious from the original requirements but were found during impl.
     Format: - [RULE] <domain>: <statement>
     Example: - [RULE] Flowable: delegateTask() sets DelegationState=PENDING; resolveTask() clears it back to null
-->
- [RULE] Pilot reporting: an automated fake run cannot satisfy real DingTalk, service-manager, host-reboot, privilege-separated cgroup, real repository, or human Owner sign-off checks.
- [RULE] Ownership: the first milestone has exactly one active Owner and one sign-off object; there is no manager expansion or co-signing workflow.
- [RULE] Candidate execution: the injected Agent must not commit or push; the production CandidateExecutor validates the diff and creates the managed local candidate commit.

---

## Problems Encountered & Fixes
<!-- Concrete problems hit during this phase, with root cause and fix.
     Format:
     ### Problem: <short title>
     - Symptom: ...
     - Root cause: ...
     - Fix: ...
     - Lesson: (generalizable takeaway)
-->
### Problem: Manual clock invalidated the shared runtime lease after candidate execution
- Symptom: outbox drains returned no dispatch and runtime health reported `lease_failed` after a successful candidate run.
- Root cause: CandidateExecutor acquires the shared instance lease using wall-clock time, while the initial rehearsal clock started near the Unix epoch; execution correctly fenced the apparently expired lease and made the runtime's cached fence stale.
- Fix: Anchor the manual pilot clock to the current wall clock, then advance it deterministically for actions and retry backoff.
- Lesson: injected clocks that share a persisted lease with a component using wall time must begin in the same time domain.

---

## Code Patterns Established
<!-- Reusable patterns introduced in this worktree that other phases should follow.
     Include file:line references.
-->
- `scripts/collaboration-pilot/report-schema.ts`: validate a closed, privacy-safe report schema before either serialization or rendering.
- `scripts/collaboration-pilot/report.ts`: write JSON and derived Markdown through same-directory atomic temporary files and enforce mode `0600` after rename.
- `scripts/collaboration-pilot/scenario.ts`: hash external identities and absolute paths at the collection boundary; retain only repository-relative changed paths.

---

## Test Findings
<!-- What tests revealed, unexpected failures, coverage gaps. -->
- Focused pilot tests cover 18 assertions across report, fake ports, faults, CLI handling, and end-to-end rehearsal.
- Collaboration and DingTalk regression selection passes 156 tests across 35 files.
- Generated report JSON and Markdown validate as mode `0600`; the report contains no action token, credential, session webhook, or raw external path.

---

## Integration Notes
<!-- Things this branch depends on / exposes for other branches.
     Especially: shared entities modified, new DB columns, enum values added.
-->
- Adds `pnpm pilot:collaboration:fake -- --output <directory>`; output must be outside the repository and is intentionally overall `pending` until the sole Owner completes the real pilot.
- No collaboration schema, runtime, DingTalk adapter, default-branch merge, deployment, or remote-push behavior changes.

---

## Merge Checklist
<!-- Fill before merging to main. -->
- [x] Compilation clean
- [x] Tests pass
- [x] No leftover debug code or TODOs
- [x] Database schema remains backward compatible
- [x] API endpoints documented in this file
- [x] Architecture decisions recorded above
- [x] Problems/lessons recorded above
- [x] Dependencies section is accurate
