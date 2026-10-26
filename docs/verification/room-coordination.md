# In-chat team coordination

Independent bot conversations now dispatch as soon as a handoff is accepted;
speakers in the same group chat still serialize (and say so; with parallel room jobs on, several room jobs run side by side, see below). A Chief waiting for returned
results exposes `waitingForTeammates: true`, not a fake active `busy` turn.
The chat header shows **Teammates working**, leaves the composer usable and
retains Stop. Explicit command-line `wait` still waits for the whole result.
Accepted handoffs survive a failed source provider turn; explicit Stop,
deleted conversations and revoked routes keep their existing cancellation
behavior. This does not remove task capacity limits.

A restart (quit, update, Cloud rollout or crash) never ends a job silently.
At the next start (the runtime's restart policy, `server/runtime/runtime.ts` `open()`, docs/runtime-contract.md §5):

- A teammate turn the restart cut runs again once, in place: the same request
  in its own conversation and retained native session, opening with a note to
  check what that turn already did (files, commits, messages, anything sent or
  started) before it continues. Its chat shows "Resuming after a restart" (a
  cut review, "Resumed with … results after a restart, reviewing"), and a
  direct requester's chat shows "Mira was cut off by a restart; resuming".
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
  on: resumed once and told to check (its rerun completed), set to resume but
  ended before finishing (never started, start refused, stopped or expired;
  its result says how, and it may be partly done), or cut twice. It checks the
  results as usual.
- No notification is added: a fan-out still sends its one "Results in from …",
  and the rerun of a review that already sent it sends nothing.
- Work queued but never started, and a resume owed but not yet run, go ahead.
  Every time budget of a tree that outlived a restart starts again at boot
  (downtime is nobody's budget); request and execution counts carry on, and a
  rerun costs one execution. Stop on the requester cancels a rerun not yet
  started, "Stopped before it resumed", since nothing of it is running; a
  rerun already running is left alone like any teammate mid-turn, and so is
  one the person left working by a Stop before the restart.
- A routine run still going at a restart fails, as before, and its
  teammates' work ends with it, "OpenMausBot restarted while this routine was
  running": none of it runs again, so no result lands after the person was
  told the routine failed.
- On a quit or update, shutdown dispatches nothing more and leaves the turns
  it tears down cut for the next start, so a quit ends where a crash does,
  whatever the engine. Each conversation with a turn still running gets
  "error: turn interrupted — OpenMausBot restarted", as a provider reload's
  does, and nothing more (no unread mark, no notification), unless the next
  start goes on with that turn: a cut teammate turn, or a requester's turn
  that had sent work, says what happened when it resumes instead (a failed
  line there would offer Retry and start the job twice). Any other turn, such
  as a person's own 1:1 turn with nothing sent out, is not run again, so that
  line answers it. A crash, or Windows' `SIGTERM`, cannot write that line;
  the hand-off recovery above still runs.
- A workspace restore carries the runtime's record (`runtime.db`) as a
  database snapshot, like `messages.db`, and rewrites nothing in it. At the
  next start the restart policy above applies to what the restore brought: a
  cut teammate turn runs again once, told to check what it already did; a
  requester cut after handing out work waits for that work; queued work and
  owed resumes go ahead.

Regression checks (all use disposable fixtures):

```sh
pnpm exec vitest run server/runtime/ server/runtime-coordinator.test.ts server/direct-coordination.e2e.test.ts server/room-coordination.e2e.test.ts
pnpm exec vitest run server/delta-context.e2e.test.ts -t "restart"
pnpm exec vitest run server/full-access-workflows.e2e.test.ts server/room-recovery.e2e.test.ts
pnpm exec vitest run server/room-roots.e2e.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/direct-coordination-ui.e2e.test.ts
```

The long-running Chief suite plays one Chief of Staff job per scenario through
the real harness with fake engines, and checks what the person, the Chief and
each teammate are shown: a consult-and-implement job through a step cap,
approvals allowed, denied and left unanswered, a quit and a crash mid-job, a
provider save that changes nothing, a stalled turn, two jobs sharing a
teammate behind a card, two jobs sharing a busy computer, and what a teammate
is told for the person's own job and for a routine's run:

```sh
pnpm exec vitest run server/long-running-chief.e2e.test.ts
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
thread with each recipient for that conversation. Every bot can reach every
other bot, in any department; a Chief's authority over other departments is a
separate grant ([Chief authority](team-access.md)).
A multi-recipient room request posts its brief once, addressed to all accepted
recipients. Each recipient still has a separate execution and result. An
identical retry does not post again; different briefs remain separate. Requests
in direct conversations keep their individual messages.

Recipients run sequentially per room, with their own models, permissions and
working environments. Busy recipients queue. Once all requested results arrive,
the sender resumes in the original conversation. A lead can consult its own
specialists; it never inherits the parent Chief's authority or permissions.
Advice is not a verification
receipt: the lead must ask the reviewer to run the requested checks.

Every room member's turn is a root of the runtime, as a person's turn in a
direct chat is (docs/runtime-contract.md §1, §10 PR 5): a chat-round
responder, a chained @mention, a goal step and a card continuation alike. Its
hand-offs (`coordinate_bots` from the member) are that root's children; a room
turn with no hand-offs leaves one row and nothing under it. A member's card (a
credential, a connection, a team-setup decision, a sign-in) parks that
member's root and no other member's; the room keeps accepting messages while
it waits; the person's act on the card runs the member again with the lane's
line, as in a direct chat. Stop in the room settles a parked member's cards as
stopped: a card completed afterwards saves its facts and starts nothing. The
computer wait ceiling queues the member's root to continue when the seat
frees, as it does a direct root ([computer-wait](computer-wait.md)); a goal
step parked that way is routed around by its run and never run a second time.
A restart reruns a member's cut turn once in place (the room shows "Resuming
after a restart" from the member and no interrupted line), never one that
already acted outward, and never a goal step whose run ended with the restart.
`server/room-roots.e2e.test.ts` proves each of these on the real server with
the scripted engine; `server/room-coordination.e2e.test.ts` reads the same
rows for every hand-off it checks (a refused call leaves no hand-off row; a
restart leaves the sender's root resumed once, never rerun).

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
receipt, subject to the bounded retention and a fresh reach check (peers list,
archived bots, audiences).
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

### Same-room jobs take turns, and say so

Work handed to several members of one room runs in that room's thread one
member at a time. Nothing hides that any more:

- Each `coordinate_bots` receipt that has to wait carries
  `queue: { position, of, waitingFor }` and a detail such as "queued 2 of 3
  in this room: room jobs run one at a time, so it starts in turn, after
  First". When anything the call sent waits behind other room work, the
  message opens with "These run one at a time in this room, not in
  parallel: …" and tells the requester not to report them as under way.
- The room payload carries `queue` (`WireGroup.queue`,
  `server/room-queue.ts`): every waiting member of each room thread with its
  place in line and whom it waits on, for jobs and for a round of
  @mentioned responders alike. The room shows "Second: Queued · waiting for
  First (2 of 3)" under the transcript and on the member's avatar; the
  sidebar row reads "First is working… · 2 queued".

```sh
pnpm exec vitest run server/room-queue.test.ts src/lib/room-threads.test.ts src/components/GroupView.queue.test.ts
pnpm exec vitest run server/room-queue.e2e.test.ts -t "run in turn"
```

The e2e test launches the isolated scripted fixture, has a Lead hand three
members work in one room, holds the first on a gate, and checks the Lead's
receipts and the room's `group` frames (2 of 3 and 3 of 3, both waiting on
the first), then that the line clears once all three settle.

### Parallel room jobs (opt-in)

With `features.parallelRoomJobs` on (`PATCH /api/config` with
`{"features": {"parallelRoomJobs": true}}`, or `config.json`), a
`coordinate_bots` call that sends work to two or more members of a room, or
into a room whose members already have jobs out, does not queue them in the
room's thread. Each job runs in a thread of its own on its member, opened by
the requester from the room (titled "<room> · <brief>", in the room's
working folder), so the members work side by side:

- The room shows "Sent to <member>" with a link to that thread, then one
  result card per job as it finishes (`roomRequest.phase: "result"`, the
  report's text and the thread link). The requester resumes once, in the
  room, with every result, and a finished job's thread folds away.
- One member's jobs from the same conversation share its thread and run
  there in turn: a member never runs two of them at once, and a member busy
  speaking in a room is not started beside it.
- A member who leaves the room stops its job ("no longer a member of this
  room"). Stop in the room drops the jobs that have not started; one already
  running keeps its process and reports, as any teammate's thread does.
- Receipts say "runs in its own thread … in parallel with the other room
  jobs", and the message says the results post back into the room.

A single job into a quiet room, a one-way notice, and every room with the
flag off keep running in the room's thread, in turn.

```sh
pnpm exec vitest run server/room-queue.e2e.test.ts -t "parallel room jobs"
```

The e2e test turns the flag on in the isolated fixture, has a Lead send two
members a job and then a second job to the first, holds both first jobs on
gates and checks they are running at the same moment, each in its own thread,
with the second job queued in the first member's thread. After release it
checks three result cards and three "Sent to" lines in the room, the
first member's two turns in one thread, and one resume of the Lead.

### Rooms that mix departments

A room's members can come from any department, a Chief that manages none of
them included: they list each other with `list_room_targets` and hand each
other work with `coordinate_bots` like any room. A bot's own peers list still
narrows what it can address, and a revoked peer is refused before queued work
starts. On a Team Cloud, nothing from a member's private chat is handed into a
room or posted in one.

```sh
pnpm exec vitest run server/peer-roster.test.ts server/post-to-room.test.ts server/room-coordination.e2e.test.ts server/direct-coordination.e2e.test.ts server/runtime-coordinator.test.ts server/peer-allowlist.e2e.test.ts server/cloud-team-open-reach.e2e.test.ts
```

The coordination suites use `launchVerificationServer`, `control-omb`, and the
actual agents MCP proxy with a scripted provider and disposable HOME/data.
They assert discovered targets, accepted or refused tool calls, durable
handoff state, the destination conversation, and absence of dispatch after
revocation. They cover both named-section and sectionless Chiefs; the posting
suite independently checks room listing and transcript writes. These are
server workflow checks, not UI or live-model verification.

### Parallel threads in one room

A room's threads run side by side; turns stay serial within a thread, and a
member works one thread at a time (`server/room-member-lock.ts`): a member
asked in several threads finishes one, then takes the next, and no waiting
thread is skipped because they all woke on the same release. Stop reaches only
its own thread.

```sh
pnpm exec vitest run server/room-member-lock.test.ts server/room-parallel-threads.e2e.test.ts src/lib/room-threads.test.ts
```

The e2e holds every fake-Claude reply behind a gate file and asserts each
thread's own `working` and `busyBotId` on the wire. It is a server workflow
check with the fake engine, not a UI or live-model check.

### Broader coordination checks

```sh
pnpm exec vitest run server/runtime-coordinator.test.ts server/room-coordination.e2e.test.ts src/components/GroupView.test.ts src/lib/room-activity.test.ts --maxWorkers=2
pnpm exec vitest run server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/drivers/agents-proxy.test.ts --maxWorkers=2
pnpm exec vitest run server/room-recovery.e2e.test.ts server/testing/room-handoff-agent.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/turn-dispatch-guard.test.ts
pnpm exec vitest run server/comms.test.ts server/thread-aware-bots.e2e.test.ts server/routine-delegation.e2e.test.ts server/independent-threads-api.test.ts server/peer-allowlist.e2e.test.ts server/steer-queue.test.ts
pnpm exec vitest run server/runtime-paths.e2e.test.ts server/notification-routing.e2e.test.ts server/post-to-room.test.ts
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
A consultation (`coordinate_bots` with `consult: true`) is covered by
`server/comms.test.ts` and `server/runtime-paths.e2e.test.ts`:
there is no inline wait; the asker finishes its turn with a receipt and the
teammate's answer resumes it, in a work thread of the asker's conversation
(docs/runtime-contract.md §9).
Follow-up checks cover retained report context and withholding after peer access
is revoked, without mirroring a second visible transcript.
Addressing checks cover what a bot may put in a `bot_ids` slot: an id is always
an id; a name that means exactly one reachable teammate resolves to it and the
work runs as if the id had been sent; a name nobody has is refused with the
argument echoed and `list_bots` named (`No bot with id or name "…"`); a hidden
teammate's id is refused as no longer available; a name two reachable teammates
share is refused with the count and the way to the ids, never guessed. Every
roster line the Chief and its peers read carries the teammate's `[id: …]`, so
the tools can be called straight from the prompt.
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
Routine checks enter through real routine execution, where `coordinate_bots`
hands work on; the run's root names the run as its requester
(docs/runtime-contract.md §9).
Thread checks also cover self-owned jobs, queued provenance and the transition
from a completed routine back to a normal user conversation.

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

Peer lists and peer approvals still apply; departments never limit who works with whom.
Every turn — a chat, a room, a routine run, a webhook run, a goal run, a Cloud
guest's turn, a standing external runtime — hands teammate work on with the
one `coordinate_bots` tool (work, a question with `consult`, a one-way notice
with `reply: "none"`, a fresh thread with `thread: "new"`) and reads it with
`assignment_status` (docs/runtime-contract.md §9). Any turn can still use
`start_thread` to open
separate work on itself, without moving the person's selected conversation;
the runtime's depth limit bounds the tree. A teammate's hand-off to a bot
runs in that bot's work thread for the sender, never in a conversation a
coordination lives in, so it cancels no coordination there. Finish together
remains separate too. Cancelling a request
stops the descendants it is still waiting on, except a teammate whose turn had
already started when the person stopped the conversation above it: that process
is left alone and reports its result. A restart runs each teammate turn it
cut again once, in place and told to check what it already did, and tells its
requester (see the top of this page).
Limits (docs/runtime-contract.md §6; `DEFAULT_LIMITS` in `server/runtime/types.ts`
and the coordinator's overrides): depth 4; per root, 24 requests, 48 executions
and 48 wakes since its last durable progress; a queued assignment that never
started within 24 hours expires; four hours without durable progress fails the
tree; a turn with no activity for 24 hours is stalled; a question to the person
waits 30 minutes, then the assignment expires, never approved. Failures return
to the sender, not a false success. Model quality and
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
