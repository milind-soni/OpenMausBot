# In-chat team coordination

In an ordinary bot chat or group conversation, ask the lead to consult named
teammates or have them build and review a concrete artifact. No new dashboard,
incoming-route panel or mandatory discussion. The existing **Finish together** goal loop
remains unchanged and owns its own teammate turns; it does not run a competing
handoff loop inside those turns.

The tools are `list_room_targets` and `coordinate_bots`. Discovery includes
reachable bots as well as rooms. The latter addresses 1–4 existing bots in this
room (default), or — in ordinary direct chat without a room — the sender's one
standing conversation with each recipient. A Chief can reach additional teams only
after the owner grants that access in [team settings](team-access.md).
From a room, `coordinate_bots` also accepts `direct: true` to explicitly use
those standing bot-to-bot conversations. Omit `group_id` in that case; combining
the two is rejected. Leaving `direct` out (or setting it to false) keeps the
existing room default. This never posts into the user's private DM with the
recipient. Peer, team and approval checks still apply, and results return to
the originating room. `list_room_targets` describes both destination choices.
Recipients run sequentially per room, with their own models, permissions and
working environments. Busy recipients queue. Once all requested results arrive,
the sender resumes in the original conversation. A lead can consult its own
specialists; it never inherits the parent Chief's cross-team access or permissions.
Advice is not a verification
receipt: the lead must ask the reviewer to run the requested checks.

Outside a room there is exactly one conversation per pair of bots, titled after
the sender (“@Clive”), reused by every later assignment from that sender so the
recipient still has the earlier context, and never closed automatically. A
recipient still carrying one thread per assignment from an older version has its
most recently active one adopted as that conversation rather than gaining
another row; nothing is deleted or closed. A second assignment that arrives
while the first is still running gets its own thread beside it, named by the
optional `label` (otherwise “@Clive · parallel work”), and that thread closes
itself once its result has been reported. `request_key` is only a within-turn
idempotency token; it never selects a conversation.

The chat shows an avatar and “Sent to Eli · Delivery”; clicking opens the
receiving conversation. Same-room receipts have no unnecessary navigation.
Receipts remain visible when tool calls are hidden. Files are not copied between
computers: briefs must include accessible absolute paths or the required content.
Returned reports stay available to subsequent model turns behind the compact
receipt, subject to the bounded retention and fresh peer/section access checks.
Direct-chat receipts use the existing avatar/thread pill, opening the exact
recipient task without changing other tasks.

Steering is not cancelling. A message sent while teammates are still working
runs straight away — it is not queued behind them — and the assignments stay
out: they keep running and each result still returns to this conversation and
resumes it. That turn's context names what is still outstanding, so the bot
answers the new instruction without assuming its fan-out died or sending the
same work again.

Direct-chat parking is a per-bot opt-in. When it is on, a message that arrives
while teammates are still working waits in the composer queue — the same
pending chip a busy thread shows — and runs as its own follow-up turn once
every outstanding assignment has settled and the resumed coordination has
finished. Steering stays the default; Stop keeps its conversation-scoped
behavior either way.

Stop is scoped to the conversation it was pressed in. It ends that bot's turn
and stops the conversation awaiting its teammates, so nothing resumes into a
stopped chat. An assignment that had not started yet is cancelled, since
nothing is lost. A teammate already mid-turn keeps its own provider process:
it finishes, and its result is still recorded and reported back here as the
usual receipt. Each teammate Stop leaves running gets its own pill in the
transcript — "Stopped here — Eli is still working; open to stop it too" —
which survives Tool calls being hidden and opens that teammate's conversation,
where Stop reaches its turn for real. Deleting a waiting source still cancels
its whole tree, and never recreates the conversation.

Provider work and waiting-on-teammate status stay separate internally, so
waiting does not hold a provider session or block another independent
conversation.

## Repeatable checks

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/room-coordination.e2e.test.ts src/components/GroupView.test.ts src/lib/room-activity.test.ts --maxWorkers=2
pnpm exec vitest run server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/drivers/agents-proxy.test.ts --maxWorkers=2
pnpm exec vitest run server/room-recovery.e2e.test.ts server/testing/room-handoff-agent.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/turn-dispatch-guard.test.ts
pnpm exec vitest run server/comms.test.ts server/thread-aware-bots.e2e.test.ts server/routine-delegation.e2e.test.ts server/independent-threads-api.test.ts server/peer-allowlist.e2e.test.ts server/steer-queue.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

### Explicit room-to-direct routing (MOCA-135)

```sh
pnpm exec vitest run server/room-coordination.e2e.test.ts -t 'direct'
```

The disposable fixture drives the real injected agents MCP proxy from a room
turn to a same-team bot outside that room. It checks a completed reply in a
separate bot-to-bot thread, a result receipt and resumed sender in the source
room, repeated work reusing the standing conversation, and an unchanged private
DM and active task. Negative cases cover conflicting destinations, disallowed
peers, team boundaries and denied approval; the omitted flag still routes in
the room. The provider's tool calls/replies are scripted, so this establishes
routing and authorization behavior, not real-model tool-choice quality.

Recorded locally on 2026-09-16 against base `0101f1c2`: the two new routing
regressions failed before the fix, then all nine direct-routing cases passed.
A separate disposable control fixture also sent a synthetic review from
Planning to an outside teammate's pair conversation and returned it to
Planning. The reply was present in the resumed sender's actual prompt; the
recipient's private DM and active task were unchanged. The retained local
wait/transcript evidence is `.omb-scratch/workflow.log` in the MOCA-135 worktree;
the fixture log is `server-1789531369023-7146.log` in the platform temporary
`openmausbot-verification-evidence` directory. The owned server and temporary
fixture data were cleaned up. No live account or provider was used.

The integration suite launches the disposable control fixture and drives the
actual injected agents MCP proxy with a scripted provider. It checks same-room
multi-recipient consultation, cross-room work and return, busy peers, cancellation,
provider failure, thread pinning, section changes, peer revocation, explicit
approvals and validation. Multiple required approvals are presented together;
no recipient starts until all are allowed. It does not claim model judgment or artifact correctness.
The direct-chat suite exercises Clive → lead → specialist → lead → Clive with
the real MCP proxy, no room, and no changes to unrelated conversations. It also
checks one conversation per bot pair across separate user turns, its title,
labelled concurrent work that closes itself, recipient model/permission
defaults, idempotency without extra tasks, busy queues, pinned parent
selection, steering a live coordination (including an automation turn
landing in the same conversation), conversation-scoped Stop, source
deletion, access revocation, and fresh transcript replay after
revocation. The UI test sends from the real
composer and clicks the existing handoff receipt into the exact recipient task,
with ordinary tool chips hidden. Screenshots and JSON are retained beside the
fixture's printed server log; all fixture processes and temporary data are closed.
Follow-up checks cover retained report context and withholding after peer access
is revoked, without mirroring a second visible transcript.
Unit checks cover bounded depth/fan-out, idempotent retry, original request
retention, automatic return, cancellation and restart without replay, and the
scoped stop: unstarted work cancelled, a running teammate left with its
process, its result still reported, and no resume of the stopped conversation.
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
Legacy comms checks enter through real routine execution, where ask/delegate
remain supported. Ordinary-chat checks assert that calling a replaced tool is
an explicit protocol error, never an empty successful reply. Thread checks also
cover self-owned jobs, queued provenance and the transition from a completed
routine back to a normal user conversation.

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
Ordinary chats use one bounded coordination tool for teammate work instead of
the competing ask/delegate/peer-thread execution paths. A top-level direct turn
can still use `start_thread` to open separate work on itself, without moving the
person's selected conversation. That tool is not an alternative way to dispatch
teammates or recursively fan out from model-opened threads and coordinated children.
Direct routines, webhooks and legacy peer delivery
retain their existing lifecycle: their completion is not claimed early by this
new loop, and a turn of theirs that lands in a conversation cancels no
coordination there. Finish together remains separate too. Cancelling a request
stops the descendants it is still waiting on, except a teammate whose turn had
already started when the person stopped the conversation above it: that process
is left alone and reports its result. Restart records interruption without
replaying side effects.
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
