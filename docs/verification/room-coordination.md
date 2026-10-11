# In-chat team coordination

Independent bot conversations now dispatch as soon as a handoff is accepted;
speakers in the same group chat still serialize. A Chief waiting for returned
results exposes `waitingForTeammates: true`, not a fake active `busy` turn.
The chat header shows **Teammates working**, leaves the composer usable and
retains Stop. Explicit command-line `wait` still waits for the whole result.
Accepted handoffs survive a failed source provider turn; explicit Stop,
deleted conversations and revoked routes keep their existing cancellation
behavior. This does not remove task capacity limits.

A restart (quit, update, Cloud rollout or crash) never ends a job silently.
At the next start (`reconcileRestart` in `server/room-handoffs.ts`):

- A teammate turn the restart cut runs again once, in place: the same request
  in its own conversation and retained native session, opening with a note to
  check what that turn already did (files, commits, messages, anything sent or
  started) before it continues. Its chat shows "Resumed after a restart", and
  the requester's chat shows "Mira was cut off by a restart; resumed".
- Never a second automatic run. A restart that cuts that rerun too ends it,
  failed: "Interrupted by another OpenMausBot restart after resuming once; not
  resumed again. Some of its steps may already have taken effect." The
  requester gets that result like any other; a Chief's own review ended that
  way says so in the Chief's conversation.
- A requester whose own turn was cut after it handed out work is not run
  again: it waits for that work and resumes once with it, told its turn was
  cut. A turn cut while reviewing results it already had runs that review
  again once, like any other cut turn.
- The requester's resume says what the restart did to each teammate it waited
  on: resumed once and told to check, could not be resumed (its result says
  why: a deleted conversation, a revoked route), or cut twice. It checks the
  results as usual and sends again, with `rework=true`, only what is still
  needed.
- No notification is added: a fan-out still sends its one "Results in from …",
  and the rerun of a review that already sent it sends nothing.
- Work queued but never started, and a resume owed but not yet run, go ahead.
  Every time budget of a tree that outlived a restart starts again at boot
  (downtime is nobody's budget); request and execution counts carry on, and a
  rerun costs one execution. Stop on the requester leaves a rerun alone, like
  any teammate already mid-turn.
- On a quit or update, shutdown dispatches nothing more and leaves the turns
  it tears down cut for the next start, so a quit ends where a crash does,
  whatever the engine. Each conversation with a turn still running gets
  "error: turn interrupted — OpenMausBot restarted", as a provider reload's
  does, and nothing more (no unread mark, no notification). A person's own
  1:1 turn is not run again, so that line answers it. A crash, or Windows'
  `SIGTERM`, cannot write that line; the hand-off recovery above still runs.
  Running routines still fail at a restart.
- A workspace restore is not a restart (the source may still be running): it
  ends its copy of unsettled hand-offs, "Not resumed after workspace
  restore.", and runs none of them.

Regression checks (all use disposable fixtures):

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/room-handoffs-save.test.ts server/direct-coordination.e2e.test.ts server/room-coordination.e2e.test.ts
pnpm exec vitest run server/delta-context.e2e.test.ts -t "restart"
pnpm exec vitest run server/full-access-workflows.e2e.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

Gated fake-model turns prove a teammate starts before the Chief settles,
the Chief becomes available while results are pending, failure of the source
does not discard accepted work, and exactly one final answer returns to the
original thread. These tests verify orchestration, not live-model planning.

In an ordinary bot chat or group conversation, ask the lead to consult named
teammates or have them build and review a concrete artifact. No new dashboard,
incoming-route panel or mandatory discussion. The existing **Finish together** goal loop
remains unchanged and owns its own teammate turns; it does not run a competing
handoff loop inside those turns.

The tools are `list_room_targets` and `coordinate_bots`. Discovery includes
reachable bots as well as rooms. The latter addresses 1–4 existing bots in this
room (default), or — in ordinary direct chat without a room — the sender's one
thread with each recipient for that conversation. A Chief can reach additional teams only
after the owner grants that access in [team settings](team-access.md).
A multi-recipient room request posts its brief once, addressed to all accepted
recipients. Each recipient still has a separate execution and result. An
identical retry does not post again; different briefs remain separate. Requests
in direct conversations keep their individual messages.

Recipients run sequentially per room, with their own models, permissions and
working environments. Busy recipients queue. Once all requested results arrive,
the sender resumes in the original conversation. A lead can consult its own
specialists; it never inherits the parent Chief's cross-team access or permissions.
Advice is not a verification
receipt: the lead must ask the reviewer to run the requested checks.

Outside a room, a conversation has one thread with each recipient, titled
“@Clive · work”. The first request opens it; every later request from that
conversation — a follow-up, a change of plan, rework — goes into it, so the
recipient has the earlier work in its own history. If the recipient is still
working there, the request waits and runs next; the same work never runs twice
in parallel. A different conversation of the sender gets its own thread.
Successful reported work closes in the sidebar but remains readable, and
reopens when the next request arrives; failed or withheld work remains
visible. Each receipt names the thread the request went into. Within the
sending turn and the turns that resume it, the same text to the same
recipient and place is one request: a repeat while it is live is not sent
again, and a repeat after it finished or failed runs again only with
`rework=true`. Room requests continue to use their explicit destination
thread.

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

### Rooms containing a supervising Chief

A section bot can list and post to its room when an out-of-section Chief in
that room has an owner-reviewed `managedSections` grant for the bot's section.
This includes a Chief in General (no section). In that same conversation,
`list_room_targets` advertises the Chief and section peers, and `coordinate_bots`
can address them by ID. The exception does not grant direct-chat access or
access to the Chief in another room. Other cross-section members, unmanaged
Chiefs, and peer restrictions still block work. Revoking supervision before
queued work starts prevents dispatch.

```sh
pnpm exec vitest run server/peer-roster.test.ts server/post-to-room.test.ts server/room-coordination.e2e.test.ts server/direct-coordination.e2e.test.ts server/room-handoffs.test.ts server/peer-allowlist.e2e.test.ts
```

The coordination suites use `launchVerificationServer`, `control-omb`, and the
actual agents MCP proxy with a scripted provider and disposable HOME/data.
They assert discovered targets, accepted or refused tool calls, durable
handoff state, the destination conversation, and absence of dispatch after
revocation. They cover both named-section and sectionless Chiefs; the posting
suite independently checks room listing and transcript writes. These are
server workflow checks, not UI or live-model verification.

### Broader coordination checks

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/room-coordination.e2e.test.ts src/components/GroupView.test.ts src/lib/room-activity.test.ts --maxWorkers=2
pnpm exec vitest run server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/drivers/agents-proxy.test.ts --maxWorkers=2
pnpm exec vitest run server/room-recovery.e2e.test.ts server/testing/room-handoff-agent.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/turn-dispatch-guard.test.ts
pnpm exec vitest run server/comms.test.ts server/thread-aware-bots.e2e.test.ts server/routine-delegation.e2e.test.ts server/independent-threads-api.test.ts server/peer-allowlist.e2e.test.ts server/steer-queue.test.ts
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
checks that follow-ups from one conversation continue one recipient thread
(queued behind running work, never in parallel), that another conversation
gets its own thread, thread titles, work that closes itself and reopens, recipient model/permission
defaults, idempotency without extra tasks, capacity-bound queues, dispatch to a
spare recipient thread while unrelated work remains active, pinned parent
selection, steering a live coordination (including an automation turn
landing in the same conversation), conversation-scoped Stop, source
deletion, access revocation, and fresh transcript replay after
revocation. The UI test sends from the real
composer and clicks the existing handoff receipt into the exact recipient task,
with ordinary tool chips hidden. Screenshots and JSON are retained beside the
fixture's printed server log; all fixture processes and temporary data are closed.
The legacy routine `ask_bot` path is covered by `server/comms.test.ts`: a
gated peer outlives the production 15-second inline budget, the caller finishes
with an asynchronous receipt, and releasing the peer delivers its late reply
to the original conversation. This budget releases the caller, not the peer;
it does not impose a 15-second limit on delegated work.
Follow-up checks cover retained report context and withholding after peer access
is revoked, without mirroring a second visible transcript.
Addressing checks cover what a bot may put in a `bot_ids` slot: an id is always
an id; a name that means exactly one reachable teammate resolves to it and the
work runs as if the id had been sent; a name nobody has is refused with the
argument echoed and `list_bots` named (`No bot with id or name "…"`); a hidden
teammate's id is refused as no longer available; a name two reachable teammates
share is refused with the count and the way to the ids, never guessed. The same
resolution serves `ask_bot` and `delegate_bot`, and every roster line the Chief
and its peers read carries the teammate's `[id: …]`, so the tools can be called
straight from the prompt.
Unit checks cover bounded depth/fan-out, idempotent retry, original request
retention, automatic return, cancellation, restart recovery (one rerun in
place, a second cut ending it, the requester told, budgets restarted at boot,
nothing dispatched while shutting down), and the scoped stop: unstarted work cancelled, a running teammate left with its
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
is left alone and reports its result. A restart runs each teammate turn it
cut again once, in place and told to check what it already did, and tells its
requester (see the top of this page).
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
