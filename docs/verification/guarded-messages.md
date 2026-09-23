# Guarded external messages

External interfaces can submit a pinned task message through
`POST /api/bots/:botId/messages/guarded`. Check the authenticated
`GET /api/health` response for `capabilities.guardedMessages: 1` first. An older
runtime must not receive a fallback request to the ordinary send route.

The guarded request includes `text`, `threadId`, a stable `sendId`, and the
`expectedActiveLeafId` from the task's current message page. An empty task uses
`null`; a newly created bot may already have a greeting and a non-null leaf.
The runtime admits new work only while the task is idle, has a free slot, uses
the exact expected approval mode, and still has that leaf. Omitted
`expectedApprovalMode` means Ask without automatic or remembered approvals.
It returns the original receipt for an already accepted matching send.

`capabilities.guardedFullAccess: 1` additionally accepts
`expectedApprovalMode: "full"` for a task that **already has** Full access.
It does not grant or change permissions. The exact task, not its bot default,
must match; Ask callers never silently become Full. Retry receipts continue
to return the original accepted action before rechecking admission conditions.

Run the permanent isolated HTTP checks:

```sh
pnpm exec vitest run server/guarded-messages-api.test.ts
```

Each case launches the prescribed `control-omb` verification server in a fresh
home and uses only its gated fake provider. The test records the exact HTTP
requests, `control:omb` commands, bounded transcripts and wait results next to
the server log in a `.log.guarded-messages.json` receipt. Temporary homes and
their child processes are closed by each fixture.

The checks cover strict input and authentication, foreign task refusal, lost
response recovery, changed-leaf rejection, Ask/automatic/remembered approval
settings, busy/capacity refusal without enqueueing or steering, concurrent
guarded admissions, and duplicate receipt identity. A running ordinary turn
remains unchanged when a guarded send is refused. Ordinary composer sends
retain their existing behavior; this endpoint does not prohibit a later human
message from steering or queueing through the ordinary route.

The coordination case gates one real fake-provider teammate after the source
provider has settled. A no-op Ask settings update proves the source's raw busy
flag and dispatch reservation have both cleared; the guarded send still gets
`guarded_busy` because that conversation parks messages behind its teammate.
The transcript and queue stay unchanged, and releasing the gate completes the
original request. Its bounded commands and results are retained beside the
fixture log in a `.log.guarded-coordination.json` receipt.

## Following and stopping one request

`capabilities.guardedRequests: 1` advertises two additional loopback/admin
routes. They do not grant a new paired-client permission or weaken Ask mode.

- `GET /api/bots/:botId/requests/:sendId?threadId=...` returns
  `messageId`, `activeLeafId`, `phase`, `activeTurnId`, `executionId`, and
  `messages`. The phase is `working`, `waiting`, `settled`, or `untracked`;
  both execution identifiers are explicitly nullable. Messages contain only
  the exact acknowledged user message through the selected active leaf,
  limited to 500 messages and 1 MiB, with screenshot pixels omitted.
- `POST /api/bots/:botId/requests/:sendId/interrupt` requires the snapshot's
  `threadId`, `messageId`, `expectedActiveLeafId`, `expectedTurnId`, and
  `expectedExecutionId`. Persist these before sending: a retry must not bind
  to a newer execution. Success is `{ "ok": true, "outcome": "stopped" }`.

A changed branch, competing sibling, newer user message, or stale execution
returns `409 guarded_request_changed`. Unproven stop ownership returns
`409 guarded_request_untracked`; an oversized snapshot returns 413. An older
server returns 404. None permits falling back to the ordinary interrupt route.
The execution ID fences even the setup interval when the provider turn ID is
still null. A settled request is not reported as stopped, and an uncertain or
replayed stop is not reported as successful.

Provider messages carry server-authored `requestMessageId`. Chief coordination
returns inherit the original coordinator generation; reviewed team-setup
returns bind to the original card's user ancestor, not the latest human turn.
Unknown continuation paths remain `untracked`. A final requires the latest
provider execution's successful terminal reply, never an earlier delegation
acknowledgment. `turnSucceeded` persists that distinction; `requestCancelled`
on the original user message prevents a restart reviving an old result.
The original message's durable `requestPending` fence is cleared only after a
successful final and all request dependencies settle. A process that died
while awaiting teammates, or a failed coordination root that never resumed,
cannot reinterpret its old handoff as completion.
Display-only activity receipts need not carry provider provenance.

Pending permission, question, connection, credential, or team-setup cards and
outstanding coordination report `waiting`, including while the provider itself
is idle. This is not a full approval-data API: tool summaries may be incomplete,
and authoritative review still belongs in the workspace. Stop cancels future
returns to this conversation and unstarted teammate work. Already-running
teammates can finish; it is not a recursive rollback or a promise to stop their
tools.

Run the isolated request/continuation checks:

```sh
pnpm exec vitest run server/guarded-requests.test.ts server/guarded-messages-api.test.ts server/direct-coordination.e2e.test.ts server/team-setup.e2e.test.ts server/turn-dispatch-guard.test.ts server/request-auth.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

These checks include immutable Stop targets, the null-provider-ID setup race,
detached final/card ancestry, foreign human turns, real gated Chief delegation,
reviewed bot creation and continuation, and refusal to reuse an initial handoff
after a failed resumed turn or failed coordination root. All providers are
isolated fakes.

## Dedicated shared-workspace operator policy

An operator who explicitly authorizes Full access in a dedicated company
workspace can provision `OMB_SHARED_WORKSPACE_FULL_ACCESS=1` at server startup.
It is active only with a fully validated HTTPS `OMB_ADMIN_URL`,
`OMB_PUBLIC_URL`, workspace slug `OMB_ADMIN_WORKSPACE`,
`OMB_ADMIN_MEMBERSHIP=portal`, a loaded hosted-access hook and a live `admin`
entitlement. `OMB_DESKTOP_PARENT=1` disallows it. HTTP settings cannot toggle it.

Only while that policy is active does authenticated health advertise
`capabilities.sharedWorkspaceFullAccess: 1`. A trusted loopback caller may then
create **a new task** with `POST /api/bots/:botId/tasks` and
`approvalMode: "full"`, provided its provider supports Full. Remote sessions,
including administrators, cannot use this grant route. This policy trusts
local processes in that dedicated workspace; it must not be enabled on a
personal desktop or a workspace where local tools must not create Full tasks.

Explicit `approvalMode: "ask"` creates a fresh Ask task with no automatic or
remembered grants even when the bot default is elevated. Both explicit modes
clear those inherited grants in the task's first durable write. Existing
tasks, bot defaults and the desktop confirmation path are unchanged. Removing
the operator flag prevents new HTTP Full grants; it does not silently downgrade
already-authorized tasks. Use a new thread when changing an external request's
permission policy, never upgrade an old queued request or silently patch a
shared task.

Run the operator-policy and Full/Ask workflow checks:

```sh
pnpm exec vitest run server/enterprise.test.ts server/hosted-access.test.ts server/full-access-workflows.e2e.test.ts server/store.test.ts
```

The hosted-access tests exercise the real hosted authorization route with an
isolated portal/license fixture. The Full workflow exercises exact Full/Ask
guarded sends, bot creation, delegated continuations, and restart while awaiting
a teammate, using only fake providers. Neither contacts a real portal or model.

The request and operator-policy fixtures were developed against public `main`
at `12ee67e7` on 2026-09-21 and verified with real isolated runtime processes.
These fixtures do not qualify real providers, Slack delivery, production
deployment, or a worker connected to a customer workspace.
