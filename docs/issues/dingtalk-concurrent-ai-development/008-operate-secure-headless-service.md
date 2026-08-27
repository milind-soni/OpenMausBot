# [008] Operate secure headless service

**Type**: AFK  
**Status**: TODO  
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

- [ ] Supported service managers start, stop, restart, and detect failure of the headless process.
- [ ] Graceful shutdown stops acquisition and safely resolves or interrupts active work within a bounded period.
- [ ] Encrypted online backup and isolated restore preserve the ledger while excluding disposable worktrees and plaintext secrets.
- [ ] Restored pending external actions enter review and require current-state revalidation.
- [ ] Credential rotation and log-redaction tests show no secret material in observable outputs.
- [ ] Owner recovery atomically revokes the old identity and cannot directly accept, deploy, or merge work.

## User stories addressed

- E2E-10: Recover unfinished state after service or host restart.
- Completion definition: Operate with auditable recovery, rollback, and security controls.

## Background hints

Keep service-manager templates declarative and keep platform-specific behavior outside the collaboration domain.

