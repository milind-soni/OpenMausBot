# Orgo isolated coding acceptance — 2026-09-27

The user selected Orgo and authorized up to $14/month additional capacity.
The account now permits two computers. Checkout showed $13.96 due today and
$43/month including the existing plan, but the account subsequently displayed
a complimentary plan and $0/month. Capacity was confirmed by successful
creation of the second computer; a charge was not independently confirmed.

## Real provider and model acceptance

Isolated backend: `/opt/nation-coding-staging-20260927`.
Evidence: `/tmp/nation-live-coding-tKp5Yy/evidence.json`.

- Two separate Orgo computers ran pinned Codex 0.157.1 using real OpenRouter
  `openai/gpt-5.4-mini` Responses through the public HTTPS capability gateway.
- The actual guest sandbox passed project-write, outside-write denial, and
  shell-network denial checks. Workspace-write remained enabled.
- Independent file inspections and Python tests passed for both accounts.
  A later task preserved Alice's project; Bob could not see Alice's files.
- Cancellation killed the remote process group, rejected the old capability,
  and retained files. Restarting the coding service also revoked its old
  capability and stopped the active process without losing the project.
- Model costs settled in the isolated ledger. Each account was charged only
  for its own work; no pending model calls remained.

## Real signed-in application acceptance

Evidence: `/tmp/nation-app-coding-kBVLx0/evidence.json`, saved account transcripts,
and server/workspace logs. This used a new temporary application home, two
verified fixture accounts, real workspace server children, normal agent tool
routing, real Orgo computers and real OpenRouter inference. Login emails were
written only to the fixture outbox; no external email was sent.

Both agents called the coding workflow to create separate `app-acceptance`
projects. Independent computer execution confirmed their distinct owner files,
passing Python unit tests and Codex event files. Cross-account computer access
was refused. Alice's fixture balance changed from $3 to $2.975953 while Bob's
stayed at $3. Bob's later task changed his balance to $2.976257 while Alice's
remained unchanged. These are fixture credits, not real member balances.

The signed-in run proves file edits, tests, routing and independent charging.
The provider/service run above separately proves cancellation and restart
revocation. This record does not claim a visual browser acceptance.

## Implementation and limits

Orgo GET computer responses use `project_id` for workspace ownership; creation
uses `workspace_id`. Conflicting or missing ownership is rejected. Provisioning
requests 4 GB RAM, 0.5 vCPU and 20 GB disk per new computer. The existing Alice
fixture has a 40 GB disk; Bob has 20 GB. Both use 0.5 vCPU.

The coding bootstrap installs checksum-verified Node 24.16.0 and pinned Codex
outside project homes. Orgo jobs have a four-minute deadline within its
five-minute synchronous command limit; Daytona retains ten minutes. The
32-request limit, sponsor billing, short-lived capabilities, remote supervisor
and durable mutation fences are shared. Backend keys never enter the guest.

Lint, TypeScript and the full build passed. The focused isolation suite is
recorded alongside release validation. Historical unrelated broad CI failures
are documented in the Daytona investigation; this is not a claim that every
repository-wide check is green.

Acceptance stops its owned computers and retains evidence. Production remains
disabled until the reviewed branch is merged and the backend release verified.
