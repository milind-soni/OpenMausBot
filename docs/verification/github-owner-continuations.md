# GitHub completions resume their registered owner

Ordinary GitHub deliveries remain outside work in their own conversations. A
local or self-hosted owner can register an exact completion with `wait_until`;
the receiver then wakes that original chat without passing event text into it.
The owner rechecks authoritative GitHub state and advances only existing
authorized work. A failed workflow also wakes the owner; completion never
means success or approval.

## Registration

From the person's original chat, or eligible person-origin handed work:

```json
{
  "label": "the release checks",
  "kind": "github_completion",
  "github": {
    "webhook_id": "an-enabled-run-receiver-owned-by-this-bot",
    "repository": "example/project",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "run_id": 42,
    "run_attempt": 1
  },
  "follow_up": "Recheck the release gates and advance the already authorized release."
}
```

For a submitted review, replace `run_id` and `run_attempt` with
`"pull_request": 774`. The reviewed commit must match `revision`. The
receiver must admit the corresponding standard GitHub `workflow_run` or
`pull_request_review` delivery. Existing authentication, filters, enabled
state and rate limits apply. Run now and connection tests do not fire it.

The destination comes from the active capability, never a request field or
incoming event. The follow-up comes from the original request, never a review
body. A resumed registered owner may register the next exact completion only
for the same receiver and repository. Generic waits, arbitrary event turns,
guests and unrelated repositories do not get that exception. Cloud homes
reject this kind because their wait follow-ups use separate result chats.

## Persistence and failure

- Duplicate registrations and repeated notifications coalesce. The wait ID
  is the native routine queue's durable delivery key.
- Busy chats retain the completion until they are free. Both registration
  and pending delivery survive restart.
- The last 500 normalized completion identities are retained for up to seven
  days. A completion arriving just before registration returns `already` so
  the currently running owner can verify it immediately. Raw event text is
  never retained in this cache.
- Queue acceptance precedes removing the wait. A queue failure retains it,
  reports the failure in the owner chat and retries with the same ID.
- GitHub registrations and completion identities live in `waits.json.github`,
  a separate optional file that older app versions leave alone. Existing
  wait conditions remain in `waits.json` with their unchanged format.
- The registration file, queue receipt, routine run and resulting owner transcript
  distinguish received, queued and actually completed work. Receiving an
  event alone is not task completion. Cancelling or expiring a registration
  does not schedule its follow-up.

This adds no access to foreign assignment trees. It also does not auto-subscribe
every existing task: an eligible owner must register the exact completion.
Existing automation configuration is unchanged.

## Verification

```sh
pnpm exec vitest run server/github-owner-waits.test.ts server/github-owner-waits.e2e.test.ts server/waits.test.ts server/routes/waits.test.ts server/wait-host.test.ts server/wait-notice-text.test.ts server/webhooks.test.ts server/drivers/agents-wait-tools.test.ts server/host/outside-lineage.test.ts server/handed-waits.e2e.test.ts server/system-prompt.test.ts
pnpm exec tsc -p tsconfig.server.json
```

The end-to-end test launches the published verification harness in a temporary
home with a fake engine. It creates an original owner assignment, registers a
workflow completion, restarts the app, then delivers authenticated completion
notifications carrying an attempted destination/instruction injection. It
checks that the original chat reads its retained assignment, registers a
deployment completion and finishes once. The independent event conversation
is refused that same assignment. Duplicate delivery IDs and fresh IDs for
the same result do not add another owner run.

Unit tests cover wrong bot/receiver/repository/revision/run/attempt, submitted
review commit matching, connection tests, early completion, busy delivery,
cancel/expiry, retry after failure, scope renewal and unchanged outside marks.

The fixture retains its log and owner transcript alongside the verification
evidence directory printed on failure. These checks do not establish a live
GitHub relay configuration, a released desktop build, Cloud-home support or
real-model behavior. Installing an app version containing this change and
registering the owner's next exact wait remain deployment steps.
