

<parallel_dev_learnings>
<!-- Last updated: 2026-08-28 05:17 -->
<!-- Sources harvested from 4 worktree(s): -->
- `.parallel-dev/logs/codex%2F008-ops-packaging/branch-notes.md` (branch: codex/008-ops-packaging, phase: auto-detect)
- `.parallel-dev/logs/codex%2F008-runtime/branch-notes.md` (branch: codex/008-runtime, phase: auto-detect)
- `.parallel-dev/logs/codex%2F008-secure-headless/branch-notes.md` (branch: codex/008-secure-headless, phase: implementation)
- `.parallel-dev/logs/codex%2F009-nonproduction-pilot/branch-notes.md` (branch: codex/009-nonproduction-pilot, phase: auto-detect)

## Architecture Decisions

### Vendor Stream SDK is isolated and version reality is explicit
- Context: The planned exact `dingtalk-stream@2.1.6` does not exist in npm, while the package `latest` tag resolves to a prerelease.
- Choice: Pin registry-published `2.1.6-beta.1` exactly, isolate the only import in `stream-sdk.ts`, verify its installed declarations/source, disable debug, and rely on its built-in reconnect.
- Rejected alternatives: A nonexistent lock entry, dynamic `require`, guessed multi-version shims, and silent fallback to an older release were rejected because they make builds or runtime behavior unverifiable.
- Consequence: This adapter is limited to the non-production milestone until a stable version is evaluated; package API changes remain contained in one bridge.
  <!-- source: codex/007-dingtalk-stream -->

### Stream acknowledgement follows durable core commit
- Context: DingTalk redelivers callbacks when ACK is absent or late, while ACK-before-persist can lose task state.
- Choice: Normalize, invoke the collaboration/Owner sink, and ACK only after committed success or duplicate; parse and persistence failures remain unacknowledged.
- Rejected alternatives: ACK on callback receipt and coupling replies to ACK were rejected because both can lose authoritative state.
- Consequence: Internal idempotency converges redelivery and outbound replies/cards flow independently through delivery ports.
  <!-- source: codex/007-dingtalk-stream -->

### Ephemeral reply URLs never become collaboration data
- Context: `sessionWebhook` is short-lived and secret-bearing, whereas proactive conversation identity is durable and semantically distinct.
- Choice: Keep validated DingTalk HTTPS session URLs only in an in-memory TTL registry, disable redirects, and fall back solely to an explicit proactive target.
- Rejected alternatives: Persisting webhooks in the Ledger/outbox or deriving proactive IDs from inbound conversation IDs were rejected as secret leakage and routing ambiguity.
- Consequence: Restart intentionally drops session routes; delivery then uses configured proactive routing or reports `delivery_unroutable` without changing Work Item state.
<!-- Record every non-trivial design choice made in this worktree.
     Format: ### <decision title>
     - Context: why did this decision arise?
     - Choice: what was chosen?
     - Rejected alternatives: what else was considered and why rejected?
     - Consequence: what does this lock in or enable?
-->
  <!-- source: codex/007-dingtalk-stream -->

### Decision: Restored ledgers carry a durable fail-closed guard
- Context: Dead-lettering rows during restore was insufficient because new rows or dormant work could still be scheduled if the review database was opened by the normal runtime.
- Choice: Migration v8 adds a singleton `live | review_required` guard; ingress, planning, execution, Owner actions, scheduling, outbox, recovery, and retention enforce it at their authoritative boundaries. Only a local explicit hash-bound re-arm operation can clear it.
- Rejected alternatives: A manifest-only marker and one-time row rewrites were rejected because neither is authoritative inside SQLite nor covers newly inserted work.
- Consequence: A restored database reports degraded health and cannot send, execute, recover, or clean evidence until a local reviewer explicitly re-arms the exact backup hash.
  <!-- source: codex/008-secure-headless -->

### Decision: Strong containment means Linux cgroup v2 only
- Context: Process leaders and process groups do not prove that double-forked or `setsid` descendants have terminated.
- Choice: A trusted launcher verifies the expected PID in a populated run cgroup before signing a receipt bound to runtime identity plus run/worktree/instance fence; shutdown uses `cgroup.kill` and waits for `cgroup.events populated=0`.
- Rejected alternatives: PID and macOS process-group liveness were rejected as weak containment signals.
- Consequence: Shipped service units remain observe/plan only. Linux execution additionally requires a privilege-separated supervisor that denies Agent cgroupfs writes; unsupported platforms remain fail-closed.
  <!-- source: codex/008-secure-headless -->

### Decision: Secrets are references loaded from protected files
- Context: CLI flags, environment values, status, and logs are observable and unsuitable for DingTalk or backup secret material.
- Choice: Read absolute regular files through one `O_NOFOLLOW` descriptor, validate ownership/mode/size on the same descriptor, and reread on every credential-provider load.
- Rejected alternatives: Plaintext environment credentials and path-check-then-open reads were rejected because they leak or permit replacement races.
- Consequence: systemd `LoadCredential` and launchd 0600 file references can rotate secrets without exposing values through runtime health.
  <!-- source: codex/008-secure-headless -->

### Keep operational alerts structurally separate from group progress
- Context: operational failures may contain sensitive data and must reach only the single Owner.
- Choice: `PrivateOwnerAlertPort` accepts exactly a safe code, SHA-256 digest, and timestamp; a validating adapter rejects extra/raw-message fields and requires a configured private target.
- Rejected alternatives: reusing the project-group outbox or accepting free-form error text, because either can disclose secrets to a group.
- Consequence: runtime integration must inject an independent private sink and cannot silently fall back to group delivery.
  <!-- source: codex/008-ops-packaging -->

### Treat disk observation as a fenced gate, not evidence cleanup
- Context: low space must stop new work without shortening retention or deleting evidence.
- Choice: the disk monitor updates only `CollaborationDegradationController.setLowDisk()` under the active instance fence, emits one transition alert, and rejects restored review ledgers before probing or mutation.
- Rejected alternatives: invoking retention cleanup or bypassing the durable restore guard.
- Consequence: runtime maintenance can call `check()` deterministically while retention remains governed by its existing policy.
  <!-- source: codex/008-ops-packaging -->

### Scope Linux containment and keep macOS execute-disabled
- Context: cgroup v2 requires writable control files, while granting the full hierarchy would be excessive; macOS process groups are not strong containment.
- Choice: templates reference `/sys/fs/cgroup/openmausbot`, a real boot-id source, and stable verifier/backup keys through systemd `LoadCredential`; launchd sets observe/plan-only and execution disabled.
- Rejected alternatives: `/sys/fs/cgroup` root access and process-group containment claims.
- Consequence: operators must provision/delegate the scoped subtree and verify it on a real host before execute mode.
  <!-- source: codex/008-ops-packaging -->

### Decision: Operational alerts have a private durable retry ledger
- Context: A low-disk flag can persist before an external alert succeeds, so transition-only in-memory notification can permanently lose the Owner warning.
- Choice: Persist safe alert code/digest/timestamp and attempts in `collaboration_private_alert_state`, retry only through the current Owner's protected private relay until acknowledged, and discard pending operational alerts during restore review.
- Rejected alternatives: Project-group outbox fallback and one-shot transition alerts were rejected because they disclose operational data or lose warnings.
- Consequence: Low disk blocks new ingress/execution immediately while alert delivery retries independently without shortening retention or deleting evidence.
  <!-- source: codex/008-secure-headless -->

### Decision: Automated pilots rehearse production paths without claiming live acceptance
- Context: Ticket 009 needs deterministic coverage before real DingTalk, host, repository, and human-signoff inputs exist.
- Choice: Run the production headless runtime and controllers against real SQLite and a disposable Git repository while injecting only fake external ports; mark the report `automated_fake`, overall `pending`, and unsigned.
- Rejected alternatives: A duplicate pilot-only state machine and treating fake evidence as a live pilot pass were rejected because they bypass production behavior or create a false acceptance claim.
- Consequence: Automation can detect end-to-end regressions without external side effects, while every real-environment check remains explicitly pending for the sole Owner.
  <!-- source: codex/009-nonproduction-pilot -->

### Decision: Acceptance evidence is closed, structured, and trace-linked
- Context: Free-form report fields could smuggle secrets or paths, and unrelated scenario IDs could be assembled into an apparently complete trace.
- Choice: Validate enum codes, SHA-256 digests, repository-relative paths, trusted command IDs plus definition hashes, and per-scenario Work Item/event/run/audit relationships before writing JSON or derived Markdown.
- Rejected alternatives: Regex-only secret scanning and unlinked free-text evidence were rejected because they cannot prevent opaque token leakage or false trace closure.
- Consequence: A real report can pass only with complete applicable evidence and one Owner signature; automated reports cannot be promoted to pass by editing a status field.
  <!-- source: codex/009-nonproduction-pilot -->

## Business Rules Discovered

- [RULE] ACK: A Stream callback is acknowledged only after the authoritative sink commits or reports a durable duplicate.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Identity: Message and card actions authorize only by stable DingTalk corp/staff identity; `isAdmin`, nickname, sender ID and card privilege claims are untrusted display/input data.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Secrets: Client Secret remains in the credential provider; session webhook and opaque action token may exist only at their immediate transport boundary and never in logs, fixtures, Agent input or persisted integration outcomes.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Identifiers: Business message ID, transport message ID, callback event ID, inbound conversation ID and proactive open-conversation ID are separate namespaces.
<!-- Rules that are NOT obvious from the original requirements but were found during impl.
     Format: - [RULE] <domain>: <statement>
     Example: - [RULE] Flowable: delegateTask() sets DelegationState=PENDING; resolveTask() clears it back to null
-->
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Restore review: local Owner binding reads and recovery remain available, but no business action, outbound send, run recovery, or evidence cleanup may occur while `review_required`.
  <!-- source: codex/008-secure-headless -->

- [RULE] Ownership: the system has exactly one active Owner and no co-signing or secondary manager workflow.
  <!-- source: codex/008-secure-headless -->

- [RULE] Restore review: maintenance entry points must fail closed before making even otherwise-safe runtime-state mutations.
  <!-- source: codex/008-ops-packaging -->

- [RULE] Operational alerts: a missing private Owner target is a delivery failure, never a reason to fall back to the project group.
  <!-- source: codex/008-ops-packaging -->

- [RULE] Pilot reporting: an automated fake run cannot satisfy real DingTalk, service-manager, host-reboot, privilege-separated cgroup, real repository, or human Owner sign-off checks.
  <!-- source: codex/009-nonproduction-pilot -->

- [RULE] Candidate execution: the injected Agent may neither commit nor push; the production CandidateExecutor validates the diff and creates the managed local candidate commit.
  <!-- source: codex/009-nonproduction-pilot -->

## Problems Encountered & Fixes

### Problem: Restore row rewrites did not block future execution
- Symptom: A restored database could receive a newly inserted outbox row or expose an existing dormant node to normal schedulers.
- Root cause: Restore safety was represented only by rewritten row states and a JSON manifest.
- Fix: Added schema v8 durable restore guard, authoritative entry-point checks, isolated review layout, manifest/hash validation, and explicit local re-arm.
- Lesson: Safety state that must survive process restart belongs in the authoritative ledger and must be checked at every side-effect boundary.
  <!-- source: codex/008-secure-headless -->

### Problem: Credential path validation had a replacement race
- Symptom: File metadata was checked by path and then the path was reopened for reading.
- Root cause: The check and use operated on different filesystem lookups.
- Fix: Open once with `O_NOFOLLOW`, validate and read the same descriptor, then validate descriptor identity and size again.
- Lesson: Security-sensitive file validation must bind metadata checks to the exact opened object.
  <!-- source: codex/008-secure-headless -->

### Problem: Review databases retained original worktree paths
- Symptom: Retention or recovery invoked against a review database could inspect or remove evidence at an original absolute path.
- Root cause: Recovery and retention originally trusted only a valid instance fence, not the restore guard.
- Fix: Both entry points now assert the ledger is armed before inspecting containment, candidates, or cleanup paths.
- Lesson: Read/write operational jobs are side-effect boundaries too and need the same restore-state policy as interactive business methods.
  <!-- source: codex/008-secure-headless -->

### Problem: Shutdown could release a lease before containment was empty
- Symptom: An interrupt-ignoring or synchronously throwing adapter could leave Agent work running while a replacement instance acquired the lease.
- Root cause: Shutdown quarantined database state but did not verify containment termination before release, and callbacks were evaluated before Promise wrapping.
- Fix: Wrap callbacks into promises, run cleanup in `finally`, kill and verify each unresolved bound containment, and retain the lease until expiry whenever empty cannot be proven.
- Lesson: Bounded shutdown is a containment protocol, not only a lifecycle timeout.
  <!-- source: codex/008-secure-headless -->

### Problem: A manual pilot clock invalidated the shared runtime lease
- Symptom: Outbox draining stopped and health reported `lease_failed` after candidate execution.
- Root cause: The rehearsal clock began near the Unix epoch while CandidateExecutor used wall-clock time, making the cached lease appear expired.
- Fix: Anchor the manual clock to current wall time and advance it deterministically for actions and retry backoff.
- Lesson: Injected clocks that share a persisted lease with wall-clock components must begin in the same time domain.
  <!-- source: codex/009-nonproduction-pilot -->

## Code Patterns Established

- `server/collaboration/restore-guard.ts:11`: central durable guard read/assert/transition functions used inside authoritative transactions.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/credentials.ts:20`: descriptor-bound secure-file read pattern for secret references.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/containment-supervisor.ts:57`: cryptographic containment receipt bound to cgroup identity and scheduler fence.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/backup.ts:97`: isolated restore returns its review paths, gated row counts, and source hash; `server/collaboration/operations/backup.ts:224` re-arms only the matching reviewed ledger.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/containment-supervisor.ts:90`: trusted-launcher PID membership check and cryptographic containment receipt bound to cgroup identity and scheduler fence.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/disk-monitor.ts:49`: fenced low-disk gate with private-only durable retry state.
  <!-- source: codex/008-secure-headless -->

- `server/collaboration/operations/runtime.ts:631`: unresolved-run containment termination controls whether the instance lease may be released.
  <!-- source: codex/008-secure-headless -->

## Test Findings

- 11 focused files / 37 tests pass, covering recorded text/rich/unsupported/card fixtures, duplicate delivery, delayed ACK, reconnect registration, stable identity, card claim stripping, durable transport dedupe, session expiry/fallback, SSRF/redirect rejection, config fail-closed and exact SDK topic/version contracts.
- Focused strict TypeScript and `git diff --check` pass. Lockfile-only frozen offline validation passes; full workspace installation remains blocked by DNS for unrelated existing Next.js/workerd tarballs.
<!-- What tests revealed, unexpected failures, coverage gaps. -->
  <!-- source: codex/007-dingtalk-stream -->

- Foundation focused suite: 7 files and 22 tests passed for credentials, backup/restore, containment, ledger, service, scheduler, and outbox.
- Full pre-runtime collaboration and DingTalk suite: 29 files and 117 tests passed.
- Final integrated collaboration, operations, DingTalk, message DB, and packaging suite: 33 files and 143 tests passed; strict focused TypeScript and packaged no-`node_modules` health/SIGTERM smoke passed.
- Review-guard regression tests prove health is degraded and delivery, scheduling, ingress, planning, execution, Owner actions, recovery, and cleanup fail before invoking side-effect ports.
  <!-- source: codex/008-secure-headless -->

- Focused pilot tests cover report validation, fake ports, fault injection, CLI safety, and the production-isomorphic rehearsal.
- The generated JSON and Markdown are mode `0600`; sensitive-content scans find no action token, credential, session webhook, group text, or absolute external path.
- The automated report stays `pending` and unsigned while its fake-scope checks carry trace-linked evidence.
  <!-- source: codex/009-nonproduction-pilot -->

## Integration Notes

- Ticket 006 should call the exported `DingTalkDeliveryPort` through its transport-neutral outbox dispatcher. The adapter never claims, retries or marks an outbox row itself.
- Ticket 008 should instantiate `RealDingTalkStreamSdk`, `DingTalkStreamAdapter`, `DingTalkCardActionLedger`, the collaboration service sinks and the configured proactive sender. It must refuse enabled startup when credentials are missing.
- Credentialed Stream/group/card smoke remains Ticket 009 HITL. The checked-in smoke is receive-only by default and does not enable external send from a flag alone.
<!-- Things this branch depends on / exposes for other branches.
     Especially: shared entities modified, new DB columns, enum values added.
-->
  <!-- source: codex/007-dingtalk-stream -->

- Collaboration schema version is 8; all consumers must expect eight applied migrations.
- Runtime composition must use a stable verifier key and real host boot generation for Linux cgroup proofs; ephemeral verifier material is test-only.
- Ticket 009 owns real DingTalk, cgroup, systemd, launchd, and host-reboot validation; Ticket 008 automated checks must not claim those real-environment results.
  <!-- source: codex/008-secure-headless -->

- `pnpm pilot:collaboration:fake -- --output <directory>` writes outside the repository and intentionally remains overall `pending` until the sole Owner completes the live pilot.
- Ticket 009 changes no collaboration schema, deployment, default-branch merge, remote-push, or multi-Owner behavior.
  <!-- source: codex/009-nonproduction-pilot -->

</parallel_dev_learnings>
