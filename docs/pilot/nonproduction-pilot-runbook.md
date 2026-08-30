# Non-production collaboration pilot runbook

This runbook validates the first milestone without granting merge or deployment authority. It has exactly one active Owner. Contributors may add requirements and evidence, but there is no second manager, administrator, approver, or co-signer.

## Safety boundaries

- Use only a disposable fixture or explicitly approved non-production repository. Record its absolute path only as a SHA-256 digest in the report.
- Keep the target default branch, index, worktree status, and sentinel unchanged. The candidate must remain on the managed local branch.
- Do not push, merge, deploy, invoke E2E-6, or start multiple Developer Agents. These checks are `not_applicable` for this milestone.
- Supply DingTalk credentials only through the headless service's secure mode-`0600` credential file. Never put a Client Secret, action token, session webhook, authorization header, credential contents, or environment dump into commands, logs, fixtures, evidence, or reports.
- Hash stable DingTalk user identities, conversation identifiers, transport identifiers, and the repository absolute path before reporting them. Do not copy group message text into the report.
- Write reports outside the repository in an Owner-readable mode-`0700` directory. The generator writes its JSON and Markdown files mode `0600`.
- Never commit a real report, credential, captured webhook, raw log, restored Ledger, or non-production repository identifier. The Markdown is a view of the adjacent JSON source of truth and must not be edited by hand.

## Automated fake rehearsal

Run the automated pilot first. It injects fake DingTalk events and fake Provider/Agent ports into the production-isomorphic headless runtime and uses a temporary Git fixture, so no real credentials are required. Use the repository's Ticket 009 command to create the report in a fresh directory outside the checkout.

Inspect both generated files:

1. Confirm the JSON declares `scope: automated_fake` and contains only `pass`, `fail`, `pending`, or `not_applicable` statuses.
2. Recompute the SHA-256 digest of the exact JSON bytes and compare it with the digest printed in Markdown.
3. Confirm E2E-6, E2E-9, deployment, default-branch merge, and multi-Agent execution are `not_applicable`.
4. Confirm real DingTalk credentials, real project group, real card clicks, service manager, host reboot, privilege-separated cgroup, non-production repository, and human Owner sign-off remain `pending`.
5. Confirm the report records build SHA/dirty state, start/end time, Ledger schema, initial/final target invariants, per-scenario trace IDs, node/run/attempt/SHA/branch/path/test evidence, the trusted command ID-to-definition-digest registry, action-level control audit references, outbox retry/supersession, recovery, audit IDs/hash, and the SDK deviation.
6. Confirm the only SDK deviation is recorded exactly as `dingtalk-stream@2.1.6-beta.1`; the requested stable `2.1.6` is not registry-published.
7. Confirm the output files are mode `0600` and no atomic temporary file remains.

A passing fake rehearsal does not convert any real-environment check to `pass` and does not constitute human acceptance.

## Prepare the real non-production pilot

The sole Owner performs these steps locally on the always-on host:

1. Select one enterprise internal DingTalk application, one project group, and one non-production repository. Verify the host's secure credential reference rather than printing its contents.
2. Capture the application build SHA and dirty flag, Ledger schema version, UTC start time, and SHA-256 digests for the repository path, Owner identity, contributor identities, conversation, and transport events.
3. Capture the repository's default branch name and its initial default SHA. Hash the initial index, porcelain status, and a sentinel file or an explicit sentinel-absence observation.
4. Start the packaged headless service under the selected service manager. Confirm health without exposing configuration values.
5. Keep a separate, private evidence directory. Store only bounded observations needed to calculate evidence hashes. Do not use the project-group outbox for private operational alerts.

If credentials, the private operational alert target, containment, repository isolation, or Owner binding is invalid, stop. Record a safe failure code/hash and keep execution fail-closed.

## Exercise the real flow

Use a deliberately non-sensitive requirement. The report records its event IDs and evidence hashes, never its group text.

1. Send the admitted message twice with the same transport identity. Verify one accepted Work Item event and one Agent Run.
2. Add a requirement/acceptance change and verify an immutable snapshot and plan revision.
3. As a non-Owner, attempt every displayed control. Verify denial and no aggregate, node, run, token, or outbox state change.
4. As Owner, exercise pause and resume. Then exercise cancel on a replaceable attempt and verify interruption evidence cannot become a trusted candidate.
5. Exercise rejection with feedback, explicit retry, and final acceptance on the exact candidate SHA. Acceptance must not merge or deploy. Use deterministic text controls for status, pause, resume, retry, cancel, and approval refresh; every command must carry the exact Work Item ID. A retry must not create a second Work Item.
6. Replay a consumed action and submit a stale-version action. Verify neither creates a second transition. Let one approval code expire, request a refreshed approval code for the same candidate, and verify that no new Agent Run is created.
7. Inject one temporary outbound failure. Verify bounded retry and status-card supersession without duplicate progress cards.
8. Restart the service while work is recoverable. Verify the same Ledger reopens, recovery is fenced, and unresolved work is never silently treated as successful.
9. Inspect the candidate only through the controlled local view. Record its managed branch, base/result SHA, relative changed paths, allowlisted command IDs and definition hashes, exit codes, and evidence hashes; never copy raw shell text into the report.
10. Stop and restart through the service manager, perform the reboot observation, and validate the privilege-separated cgroup containment path on the real Linux host. macOS process groups are observation-only and are not strong containment.

Any failed safety invariant ends the pilot. Preserve the evidence, leave the default branch untouched, and do not broaden authority to recover progress.

## Final invariant and report review

Capture the final default SHA and hashes of the target index, status, and sentinel using the same canonical procedure as the initial capture. All four must match their initial observations unless the runbook explicitly records a failure.

Generate the `real_nonproduction` JSON report first, then generate Markdown only from that in-memory validated object. Review the JSON digest, trace completeness, every status, every deviation, and all remaining pending checks. Do not manually patch Markdown.

The one configured Owner may set the single `ownerSignOff` object to `pass` only after reviewing the candidate, test evidence, repository invariants, and audit trace. There is no co-signing step. Keep the signed report in the private evidence directory and do not commit it.

## Stop and preserve evidence

Stop through the service manager and wait for bounded drain. If drain times out, treat the result as failed and retain the recovery evidence. Preserve the encrypted Ledger backup and report according to the configured retention window. Never shorten retention or delete evidence early to clear low disk space.
