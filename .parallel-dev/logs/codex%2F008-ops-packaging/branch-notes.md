# Worktree Branch Notes — codex/008-ops-packaging
<!-- Auto-created by parallel-dev. Agents MUST update this file during development. -->
<!-- Stored at .parallel-dev/logs/<branch-slug>/branch-notes.md. -->
<!-- merge-learnings.py aggregates it into docs/parallel-dev-learnings.md by default. -->

## Meta
- **Branch:** codex/008-ops-packaging
- **Phase:** auto-detect
- **Started:** 2026-08-28 02:46
- **Base commit:** 1f44d46
- **Files:** (not specified)

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
### Keep operational alerts structurally separate from group progress
- Context: operational failures may contain sensitive data and must reach only the single Owner.
- Choice: `PrivateOwnerAlertPort` accepts exactly a safe code, SHA-256 digest, and timestamp; a validating adapter rejects extra/raw-message fields and requires a configured private target.
- Rejected alternatives: reusing the project-group outbox or accepting free-form error text, because either can disclose secrets to a group.
- Consequence: runtime integration must inject an independent private sink and cannot silently fall back to group delivery.

### Treat disk observation as a fenced gate with private durable retry
- Context: low space must stop new work without shortening retention or deleting evidence.
- Choice: the disk monitor updates only `CollaborationDegradationController.setLowDisk()` under the active instance fence, persists private alert attempts independently from group outbox, retries until acknowledged, and rejects restored review ledgers before probing or mutation.
- Rejected alternatives: invoking retention cleanup or bypassing the durable restore guard.
- Consequence: runtime maintenance can call `check()` deterministically while retention remains governed by its existing policy.

### Keep shipped service units execute-disabled until containment is privilege-separated
- Context: delegating writable cgroup control to the same identity that launches untrusted Agent descendants permits a child to migrate after registration; macOS process groups are also not strong containment.
- Choice: systemd and launchd templates are observe/plan-only, deny cgroupfs writes, and use service-level control-group shutdown. Linux execute requires a separately privileged supervisor with a dedicated subtree and stable verifier material.
- Rejected alternatives: same-UID `Delegate=yes`, `/sys/fs/cgroup` write access, and process-group containment claims.
- Consequence: Ticket 009 must prove real host privilege separation and post-registration non-migration before a separate execute unit is enabled.


---

## API Contracts
<!-- New endpoints introduced in this phase.
     Format: METHOD /path — one-line description
     Variables / request body schema (key fields only)
     Response: key fields
-->


---

## Business Rules Discovered
- [RULE] Restore review: maintenance entry points must fail closed before making even otherwise-safe runtime-state mutations.
- [RULE] Operational alerts: a missing private Owner target is a delivery failure, never a reason to fall back to the project group.


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


---

## Code Patterns Established
<!-- Reusable patterns introduced in this worktree that other phases should follow.
     Include file:line references.
-->


---

## Test Findings
<!-- What tests revealed, unexpected failures, coverage gaps. -->

- Focused Vitest verification passed: 3 files, 12 tests (`private-alert`, `disk-monitor`, service templates).
- Packaged smoke passed after copying the bundle outside the repository: health emitted secret-free JSON, disabled Stream remained live, and SIGTERM exited with code 0.
- On macOS, temporary paths must be canonicalized before invoking the bundled entry because `/var` resolves to `/private/var` and the CLI has a direct-execution URL guard.
- Focused strict TypeScript verification passed for all new TypeScript modules and tests.


---

## Integration Notes
<!-- Things this branch depends on / exposes for other branches.
     Especially: shared entities modified, new DB columns, enum values added.
-->

- Final integration constructs `CollaborationDiskMonitor` through the runtime maintenance factory and routes durable operational retries only through the current ledger Owner's private relay.
- `scripts/smoke-collaboration-headless.mjs` assumes the final CLI retains `--health`, `--data-dir`, long-running disabled-Stream startup, and clean SIGTERM semantics.
- The headless server bundle now includes `server/collaboration-headless.ts`; no lockfile changes are included.


---

## Merge Checklist
<!-- Fill before merging to main. -->
- [x] Compilation clean
- [x] Tests pass
- [x] No leftover debug code or TODOs
- [x] Database schema remains backward compatible
- [x] API endpoints documented in this file (none introduced)
- [x] Architecture decisions recorded above
- [x] Problems/lessons recorded above
- [x] Dependencies section is accurate
