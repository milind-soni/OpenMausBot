# Pilot acceptance report contract

The machine-readable JSON report is the sole source of truth. The Ticket 009 renderer deterministically creates the human-readable Markdown report from the validated JSON object and includes the SHA-256 digest of the exact JSON bytes. This document is a field guide, not a report to fill in by hand.

## Required sections

The JSON source must contain:

- report version, scope (`automated_fake` or `real_nonproduction`), and overall status;
- build SHA/dirty state, UTC start/end times, and Ledger schema version;
- SHA-256 references for the repository absolute path, Owner and non-Owner identities, conversation, and transport events;
- initial and final default-branch SHA plus index, status, and sentinel hashes;
- per-scenario Work Item, event, run, and audit IDs plus the primary snapshot and plan-revision IDs;
- each node's base/result SHA, managed local branch, relative changed paths, and test commands with exit code and evidence hash;
- a trusted command registry containing only command IDs and command-definition hashes;
- Owner and non-Owner control outcomes with exact action-level audit references;
- outbox retries and supersession, restart recovery, and audit IDs/chain hash;
- every fixed acceptance check, deviations, pending real checks, and one Owner sign-off object.

Every status is exactly one of `pass`, `fail`, `pending`, or `not_applicable`. E2E-6, E2E-9, deployment, default-branch merge, and multi-Agent execution are always `not_applicable` for the first milestone. An automated fake report and its sole Owner sign-off remain overall `pending`; real DingTalk credentials, project group, card clicks, service manager, reboot, privilege-separated cgroup, non-production repository, and human Owner sign-off also remain `pending`.

The SDK deviation must name the exact non-production pin `dingtalk-stream@2.1.6-beta.1`.

## Privacy and handling

Reports must not contain raw group text, credentials, Client Secrets, action tokens, session webhooks, authorization headers, environment dumps, external user/conversation/transport identifiers, or absolute paths. Changed paths are repository-relative. Evidence is referenced by `sha256:` digest.

Generate both artifacts into an Owner-only directory outside the source repository. Both outputs must remain mode `0600`. Never commit a real JSON/Markdown report or any supporting secret/raw evidence. Markdown is generated output and must not be manually edited.

Only the configured Owner signs the report. No additional manager, co-signer, or countersignature is valid for this milestone.
