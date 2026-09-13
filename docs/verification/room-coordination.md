# In-chat team coordination

In an ordinary bot chat or group conversation, ask the lead to consult named
teammates or have them build and review a concrete artifact. No new dashboard,
incoming-route panel or mandatory discussion. The existing **Finish together** goal loop
remains unchanged and owns its own teammate turns; it does not run a competing
handoff loop inside those turns.

The tools are `list_room_targets` and `coordinate_bots`. Discovery includes
reachable bots as well as rooms. The latter addresses 1–4 existing bots in this
room (default), another allowed room, or separate recipient tasks when used in
ordinary direct chat without a room. A Chief can reach additional teams only
after the owner grants that access in [team settings](team-access.md).
Recipients run sequentially per room, with their own models, permissions and
working environments. Busy recipients queue. Once all requested results arrive,
the sender resumes in the original conversation. A lead can consult its own
specialists; it never inherits the parent Chief's cross-team access or permissions.
Advice is not a verification
receipt: the lead must ask the reviewer to run the requested checks.

The chat shows an avatar and “Sent to Eli · Delivery”; clicking opens the
receiving conversation. Same-room receipts have no unnecessary navigation.
Receipts remain visible when tool calls are hidden. Files are not copied between
computers: briefs must include accessible absolute paths or the required content.
Returned reports stay available to subsequent model turns behind the compact
receipt, subject to the bounded retention and fresh peer/section access checks.
Direct-chat receipts use the existing avatar/thread pill, opening the exact
recipient task without changing other tasks. Stop cancels that conversation's
tree; a new message supersedes its pending coordination. Deleting a waiting
source never recreates it. Provider work and waiting-on-teammate status stay
separate internally, so waiting does not hold a provider session or block another
independent conversation.

## Repeatable checks

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/room-coordination.e2e.test.ts src/components/GroupView.test.ts src/lib/room-activity.test.ts --maxWorkers=2
pnpm exec vitest run server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/drivers/agents-proxy.test.ts --maxWorkers=2
pnpm exec vitest run server/room-recovery.e2e.test.ts server/testing/room-handoff-agent.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/turn-dispatch-guard.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

The integration suite launches the disposable control fixture and drives the
actual injected agents MCP proxy with a scripted provider. It checks same-room
multi-recipient consultation, cross-room work and return, busy peers, cancellation,
provider failure, thread pinning, section changes, peer revocation, explicit
approvals and validation. Multiple required approvals are presented together;
no recipient starts until all are allowed. It does not claim model judgment or artifact correctness.
The direct-chat suite exercises Clive → lead → specialist → lead → Clive with
the real MCP proxy, no room, and no changes to unrelated conversations. It also
checks recipient model/permission defaults, idempotency without extra tasks,
busy queues, pinned parent selection, Stop, source deletion, access revocation,
and fresh transcript replay after revocation. The UI test sends from the real
composer and clicks the existing handoff receipt into the exact recipient task,
with ordinary tool chips hidden. Screenshots and JSON are retained beside the
fixture's printed server log; all fixture processes and temporary data are closed.
Follow-up checks cover retained report context and withholding after peer access
is revoked, without mirroring a second visible transcript.
Unit checks cover bounded depth/fan-out, idempotent retry, original request
retention, automatic return, cancellation and restart without replay.
Turn-correlation checks cover completion before the provider's dispatch ACK,
late completion after Stop and a replacement turn, cross-thread isolation, and
bounded single-use early receipts. Coordination uses the exact provider turn's
reply, never the latest reply or generation of a reused conversation.
The real fake-Claude subprocess checks transient retry and rejected-cursor
recovery through a nested coordinated task. Driver regressions also prove that
retrying a later turn in a retained session preserves that turn's prompt and
acknowledged identity, not the session's first request.
The recovery fixture restarts the same disposable server with an interrupted
routine and verifies its source-room card and error-free recovery broadcasts.
The subprocess fixture checks malformed output, unexpected exit and bounded
cleanup so an agent-process failure cannot silently pass or hang these tests.

## Real-model and UI checks

Use an isolated home and data directory, never the running app. Create Maya,
Eli (developer) and Nora (reviewer), set an explicit shared working folder, and
create Launch and Delivery rooms through `control-omb`. Send through
`send-channel`, wait on the source channel, and retain `messages` plus the
actual files and executed tool evidence. Follow [channels](channels.md) and
[chat UI](chat-ui.md) for the common launch/control paths.

Ask Maya to have Eli implement a Python CSV export and Nora independently run
tests before reporting. Check both transcripts, inspect actual tool executions,
and independently run held-out CSV cases: empty input, boundary dates,
paid/zero exclusions, quoting and sorted output. Also try a pure consultation
where each bot holds different requirements. Do not supply special tool
instructions in the user prompt.

Open the disposable preview, inspect both avatar receipts with tool calls hidden,
click a receipt and verify the actual receiving conversation. Stop all owned
preview/server processes afterward; retain evidence without credentials.

## Limits and safety

Existing peer allow-lists/approvals and every room reader's section still apply.
Ordinary chats replace competing ask/delegate/start-thread execution paths with
one bounded coordination tool. Direct routines, webhooks and legacy peer delivery
retain their existing lifecycle: their completion is not claimed early by this
new loop. Finish together remains separate too. Cancellation
stops descendants; restart records interruption without replaying side effects.
Limits: four cross-room edges, 24 child requests, 48 executions, 30 minutes per
root. Failures return to the sender, not a false success. Model quality and
provider availability still matter; this is not a guarantee of autonomous
correctness or permission to bypass approvals.

## Live-model evidence — 2026-09-13

The final main-based integration, including exact-turn correlation and Claude
retry compatibility, repeated the nested trial with real Sol. Clive → Patch →
Nora → Patch → Clive completed in approximately three minutes; all three durable
nodes were completed and reported. Nora actually executed the tests. The exact
CSV output, a rerun of the generated test, and two independent held-out cases
all passed. The actual renderer also passed receipt navigation and Chief grant
checks. Evidence (fixture and temporary auth copy removed):
`/tmp/omb-live-team-0913.MwRY2k/nested-gpt-5.6-sol-1789255210986/result.json`
and `independent-checks.json` beside it.

Two isolated `gpt-5.6-sol` trials used temporary work folders and real tools:

- Delivery: Clive consulted Mira, assigned Patch, requested Nora's independent
  checks and then Quill's launch copy. The actual CSV exporter and tests passed;
  no deployment or publishing was requested. Evidence:
  `/tmp/omb-live-team-0913.MwRY2k/delivery-gpt-5.6-sol-1789253057867/result.json`
  and `transcripts.json` beside it.
- Nested: Clive could reach only Patch; Patch could reach only Nora. The durable
  tree was Clive → Patch → Nora, all completed and reported. Nora executed the
  unittest suite, exact export command and schema/email checks. Patch then
  resumed, followed by Clive, in about 146 seconds. Evidence:
  `/tmp/omb-live-team-0913.MwRY2k/nested-gpt-5.6-sol-1789253398198/result.json`.

The first run also exposed a model-quality limitation: Patch claimed Nora had
verified its work without a corresponding OMB handoff. Clive correctly treated
that claim as insufficient and requested an actual independent check. Prompts
now explicitly require real coordination receipts for named-bot participation;
this is guidance, not a guarantee that every model report is truthful. The
explicit nested run proves actual recipient execution, not merely a plausible
final summary. These live results do not establish every provider's quality.
