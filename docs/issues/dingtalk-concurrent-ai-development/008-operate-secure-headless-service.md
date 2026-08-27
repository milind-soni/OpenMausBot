# [008] Operate secure headless service

**Type**: AFK  
**Status**: DONE
**Blocked by**: `docs/issues/dingtalk-concurrent-ai-development/006-recover-and-degrade-safely.md`, `docs/issues/dingtalk-concurrent-ai-development/007-connect-real-dingtalk-stream.md`  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Package the proven vertical loop as a continuously running single-instance service. Provide platform service definitions, secure credential references, graceful shutdown, encrypted online ledger backup, restore-to-review behavior, disk and retention controls, private Owner alerts, and a local Owner recovery command that cannot execute business actions. Apply the PRD's configuration, security, observability, backup, and rollback requirements.

## Ground Truth

- An operator installs the service on a supported always-on host and it automatically returns after a machine reboot.
- The service shuts down without accepting new work, losing current evidence, or leaving a false active lease.
- Secrets can be configured and rotated without appearing in the repository, status API, logs, task messages, or Agent environment.
- The Owner receives private operational alerts while ordinary task progress remains in the project group.
- Restoring a backup never automatically repeats an old deployment, merge, approval, or outbound action.
- If the Owner identity is lost, local machine access can replace it without creating a second Owner or bypassing normal task controls.

## 完成信号

- [x] Supported service-manager templates and packaged lifecycle smoke cover start, graceful stop, restart-on-failure configuration, and failure detection contracts.
- [x] Graceful shutdown stops acquisition and safely resolves or interrupts active work within a bounded period.
- [x] Encrypted online backup and isolated restore preserve the ledger while excluding disposable worktrees and plaintext secrets.
- [x] Restored pending external actions enter durable review and require explicit local, hash-bound re-arm and current-state revalidation.
- [x] Credential rotation and observable-output tests show no secret material in health, status, or operational alerts.
- [x] Owner recovery atomically revokes the old identity and cannot directly accept, deploy, or merge work.

## User stories addressed

- E2E-10: Recover unfinished state after service or host restart.
- Completion definition: Operate with auditable recovery, rollback, and security controls.

## Background hints

Keep service-manager templates declarative and keep platform-specific behavior outside the collaboration domain.

## Delivered implementation

- Awaitable, injectable Headless runtime with single-instance fencing, startup recovery, deterministic one-row outbox drain, health probes without leasing or business recovery, and bounded shared shutdown.
- Async CLI with SIGINT/SIGTERM ownership, disabled-Stream operation, secure DingTalk credential references, sanitized health, and local single-Owner recovery from stdin or an absolute protected file only.
- Schema v8 durable restore guard enforced by ingress, planning, execution, Owner actions, scheduling, outbox, recovery, retention, and disk maintenance.
- AES-256-GCM online SQLite backup, isolated review restore, dead-letter/quarantine transitions, tamper detection, and explicit `REARM_REVIEWED_LEDGER` flow bound to the encrypted artifact hash.
- Linux cgroup v2 containment supervisor requiring trusted-launcher PID membership before HMAC-bound proof, plus `cgroup.kill`/`cgroup.events` shutdown verification; shipped units remain observe/plan only until a privilege-separated supervisor is verified.
- Independent validating private Owner alert relay, durable private-only retry state, fenced low-disk ingress/execution gate, system/user systemd units, macOS launchd template, bundled Headless artifact, and packaged health/SIGTERM smoke.

## Automated evidence

- Collaboration, operations, DingTalk, message DB, and packaging templates: 33 test files, 143 tests passed.
- Strict focused TypeScript check passed for the complete Ticket 008 surface.
- Packaged artifact ran without `node_modules`, emitted secret-free health, stayed live with Stream disabled, and exited code 0 on SIGTERM.
- Parallel-development branch notes pass strict lint and were harvested into `docs/parallel-dev-learnings.md`.

## Real-environment boundary

Ticket 009 remains responsible for verification against a real non-production DingTalk tenant, real systemd/launchd hosts, actual host reboot/restart behavior, and a real privilege-separated Linux cgroup v2 supervisor/subtree where Agent descendants cannot write cgroupfs or migrate after registration. These pending environment checks do not weaken Ticket 008's automated fail-closed contracts and must not be reported as already executed.
