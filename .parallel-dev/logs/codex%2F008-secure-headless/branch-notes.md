# Worktree Branch Notes — codex/008-secure-headless

## Meta
- **Branch:** codex/008-secure-headless
- **Phase:** implementation
- **Started:** 2026-08-28 02:28
- **Base commit:** 6efa207
- **Files:** Ticket 008 secure headless runtime, operations, packaging, tests, and documentation

---

## Dependencies

- codex/008-runtime
- codex/008-ops-packaging

---

## Architecture Decisions

### Decision: Restored ledgers carry a durable fail-closed guard
- Context: Dead-lettering rows during restore was insufficient because new rows or dormant work could still be scheduled if the review database was opened by the normal runtime.
- Choice: Migration v8 adds a singleton `live | review_required` guard; ingress, planning, execution, Owner actions, scheduling, outbox, recovery, and retention enforce it at their authoritative boundaries. Only a local explicit hash-bound re-arm operation can clear it.
- Rejected alternatives: A manifest-only marker and one-time row rewrites were rejected because neither is authoritative inside SQLite nor covers newly inserted work.
- Consequence: A restored database reports degraded health and cannot send, execute, recover, or clean evidence until a local reviewer explicitly re-arms the exact backup hash.

### Decision: Strong containment means Linux cgroup v2 only
- Context: Process leaders and process groups do not prove that double-forked or `setsid` descendants have terminated.
- Choice: A trusted launcher verifies the expected PID in a populated run cgroup before signing a receipt bound to runtime identity plus run/worktree/instance fence; shutdown uses `cgroup.kill` and waits for `cgroup.events populated=0`.
- Rejected alternatives: PID and macOS process-group liveness were rejected as weak containment signals.
- Consequence: Shipped service units remain observe/plan only. Linux execution additionally requires a privilege-separated supervisor that denies Agent cgroupfs writes; unsupported platforms remain fail-closed.

### Decision: Operational alerts have a private durable retry ledger
- Context: A low-disk flag can persist before an external alert succeeds, so transition-only in-memory notification can permanently lose the Owner warning.
- Choice: Persist safe alert code/digest/timestamp and attempts in `collaboration_private_alert_state`, retry only through the current Owner's protected private relay until acknowledged, and discard pending operational alerts during restore review.
- Rejected alternatives: Project-group outbox fallback and one-shot transition alerts were rejected because they disclose operational data or lose warnings.
- Consequence: Low disk blocks new ingress/execution immediately while alert delivery retries independently without shortening retention or deleting evidence.

### Decision: Secrets are references loaded from protected files
- Context: CLI flags, environment values, status, and logs are observable and unsuitable for DingTalk or backup secret material.
- Choice: Read absolute regular files through one `O_NOFOLLOW` descriptor, validate ownership/mode/size on the same descriptor, and reread on every credential-provider load.
- Rejected alternatives: Plaintext environment credentials and path-check-then-open reads were rejected because they leak or permit replacement races.
- Consequence: systemd `LoadCredential` and launchd 0600 file references can rotate secrets without exposing values through runtime health.

---

## API Contracts

---

## Business Rules Discovered

- [RULE] Restore review: local Owner binding reads and recovery remain available, but no business action, outbound send, run recovery, or evidence cleanup may occur while `review_required`.
- [RULE] Ownership: the system has exactly one active Owner and no co-signing or secondary manager workflow.

---

## Problems Encountered & Fixes

### Problem: Restore row rewrites did not block future execution
- Symptom: A restored database could receive a newly inserted outbox row or expose an existing dormant node to normal schedulers.
- Root cause: Restore safety was represented only by rewritten row states and a JSON manifest.
- Fix: Added schema v8 durable restore guard, authoritative entry-point checks, isolated review layout, manifest/hash validation, and explicit local re-arm.
- Lesson: Safety state that must survive process restart belongs in the authoritative ledger and must be checked at every side-effect boundary.

### Problem: Credential path validation had a replacement race
- Symptom: File metadata was checked by path and then the path was reopened for reading.
- Root cause: The check and use operated on different filesystem lookups.
- Fix: Open once with `O_NOFOLLOW`, validate and read the same descriptor, then validate descriptor identity and size again.
- Lesson: Security-sensitive file validation must bind metadata checks to the exact opened object.

### Problem: Review databases retained original worktree paths
- Symptom: Retention or recovery invoked against a review database could inspect or remove evidence at an original absolute path.
- Root cause: Recovery and retention originally trusted only a valid instance fence, not the restore guard.
- Fix: Both entry points now assert the ledger is armed before inspecting containment, candidates, or cleanup paths.
- Lesson: Read/write operational jobs are side-effect boundaries too and need the same restore-state policy as interactive business methods.

### Problem: Shutdown could release a lease before containment was empty
- Symptom: An interrupt-ignoring or synchronously throwing adapter could leave Agent work running while a replacement instance acquired the lease.
- Root cause: Shutdown quarantined database state but did not verify containment termination before release, and callbacks were evaluated before Promise wrapping.
- Fix: Wrap callbacks into promises, run cleanup in `finally`, kill and verify each unresolved bound containment, and retain the lease until expiry whenever empty cannot be proven.
- Lesson: Bounded shutdown is a containment protocol, not only a lifecycle timeout.

---

## Code Patterns Established

- `server/collaboration/restore-guard.ts:11`: central durable guard read/assert/transition functions used inside authoritative transactions.
- `server/collaboration/operations/credentials.ts:20`: descriptor-bound secure-file read pattern for secret references.
- `server/collaboration/operations/containment-supervisor.ts:90`: trusted-launcher PID membership check and cryptographic containment receipt bound to cgroup identity and scheduler fence.
- `server/collaboration/operations/backup.ts:97`: isolated restore returns its review paths, gated row counts, and source hash; `server/collaboration/operations/backup.ts:224` re-arms only the matching reviewed ledger.
- `server/collaboration/operations/disk-monitor.ts:49`: fenced low-disk gate with private-only durable retry state.
- `server/collaboration/operations/runtime.ts:631`: unresolved-run containment termination controls whether the instance lease may be released.

---

## Test Findings

- Foundation focused suite: 7 files and 22 tests passed for credentials, backup/restore, containment, ledger, service, scheduler, and outbox.
- Full pre-runtime collaboration and DingTalk suite: 29 files and 117 tests passed.
- Final integrated collaboration, operations, DingTalk, message DB, and packaging suite: 33 files and 143 tests passed; strict focused TypeScript and packaged no-`node_modules` health/SIGTERM smoke passed.
- Review-guard regression tests prove health is degraded and delivery, scheduling, ingress, planning, execution, Owner actions, recovery, and cleanup fail before invoking side-effect ports.

---

## Integration Notes

- Collaboration schema version is 8; all consumers must expect eight applied migrations.
- Runtime composition must use a stable verifier key and real host boot generation for Linux cgroup proofs; ephemeral verifier material is test-only.
- Ticket 009 owns real DingTalk, cgroup, systemd, launchd, and host-reboot validation; Ticket 008 automated checks must not claim those real-environment results.

---

## Merge Checklist

- [x] Compilation clean
- [x] Tests pass
- [x] No leftover debug code or TODOs
- [x] Database schema remains backward compatible
- [x] API endpoints documented in this file
- [x] Architecture decisions recorded above
- [x] Problems/lessons recorded above
- [x] Dependencies section is accurate
