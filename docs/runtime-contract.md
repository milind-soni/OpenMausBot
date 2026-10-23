# The job runtime contract

One record, one lifecycle and one wake lane for every piece of work one bot hands to another, whatever started it: a person's chat, a room, a routine, a webhook, a goal run, an external runtime, a one-way notice or a consultation. `server/runtime/` implements this page; `server/runtime/*.test.ts` proves it on fake engines; nothing outside the module may hold work state of its own.

This replaces the two delegation systems, the six wake lanes, the dozen clocks and the ten trust wordings the server grew (room-handoffs, delegations, the aside lane, card-resume maps, `Continue:` tasks). They are deleted once the runtime carries every path.

## 1. The record

`Assignment` (`server/runtime/types.ts`). The parts that matter:

| Field | Meaning |
|---|---|
| `rootId`, `parentId`, `depth` | A tree. The root is the requesting conversation's own node (a person's message to a Chief, a routine run, an external call, a room member's turn: every turn is a root, PR 4 and PR 5). |
| `origin` | Where the work started: `person` (with the person's request harness-quoted), `routine`, or `outside` (webhook, relay, guest, peer, api). Written once at the root, copied down, never changed. |
| `requester` | Who asked: a person, a bot turn (bot + thread), a routine run, an external runtime. `chief: true` when it is a Chief of Staff conversation. |
| `assignee` | Which bot, in which thread (a work thread, the standing thread, a room thread: `room_thread` is a member's own turn in a room, or work handed into one). |
| `mode` | `work`, `consult` (answer, act on nothing), `notify` (one-way). |
| `reply` | `resume` (wake the requester), `poll` (inbox only), `none`. |
| `status`, `outcome`, `outcomeDetail` | Section 2. |
| `level`, `levelSource` | Section 3. Computed at enqueue, recorded, never patched onto a thread. |
| `executions`, `restarts`, `restart` | Turns started; restart bookkeeping (section 5). |
| `goalRunId` | On a root that is one step of a room goal run: the run's id. The run routes its steps (section 2), so such a root neither parks nor continues in place, and is not run again after a restart (the run ended with it). |
| `result`, `evidence` | What the assignee said, and what the harness observed of the turn. |

Storage: SQLite (`node:sqlite`, like `messages.db`) in `DATA_DIR/runtime.db`: `assignments` (one row per record), `assignment_events` (append-only audit trail, every transition), `inbox` (the wake lane). `:memory:` for tests. Every state change is one transaction that writes the row and its event before the runtime acts on it, so a crash keeps the accept and loses nothing it had acknowledged.

## 2. Lifecycle

```
queued ──admit──> running ──turn ends──> completed | failed | cancelled
                    │  └──handed out work──> waiting ──all children settled, or a child's new question──> resume ──> running
                    └──question for the person──> needs_input ──answer──> running
                                                              └──wait expires──> failed(expired)
```

- **Enqueue** checks the parent is running (or there is no parent), refuses work back to an ancestor, dedupes (same brief, same assignee, same parent, unless `rework`), checks depth and the root's budgets, computes the level, writes the row with event `enqueued`. Refusals return a typed reason; they never throw into a turn.
- **Admission** is one rule for every path: the runtime asks the host `canStart`; the host answers from its slots (a sibling waiting on the person does not hold its sibling). Same-conversation turns never overlap. `validate` runs before every dispatch and again on every tick for every live row: access that closes while a teammate works ends that work `failed(refused)` with the reason, its words are dropped, and a report whose route no longer admits it is withheld from the requester's resume.
- **A turn** is one `run` of the assignee. Its result is `completed`, `failed(outcome)`, `needs_input(question)` or `continue`. If it handed out work, the node goes to `waiting` instead; when every child has settled and been reported, it goes to `resume` and runs once more with the children's results.
- **A child's question interrupts the wait.** When a child it waits on parks on a typed question (`needs_input` without cards), a `waiting` node goes to `resume` on the next tick and runs once with that question (`asked` in its run input) next to whatever has settled; its other children stay awaited, and once that turn ends it waits again. A child that settles while that turn runs is a result the turn has not seen, so the node still resumes once more when every child has settled. The question's inbox item is marked delivered with the dispatch, and only that turn carries the question: a later question, or every child settling, resumes the node again, and its later turns (an answer to its own question, a continuation, the final resume) do not repeat it. A restart that cuts that turn reruns it like any cut turn (§5), and the rerun carries the same question once more. If the question is answered or the child ends before the node can start, the node goes back to `waiting` instead of running with nothing new. That turn leaves the node's restart note for its final resume. A card park does not interrupt the wait, a `poll` root is never resumed for a question, and the question still expires on its own clock.
- **Cards park any node.** A turn that leaves the person something to act on (a team-setup decision, a connection, a credential, a sign-in) ends `needs_input` with the cards' ids on the row, a root or a child alike, in a bot's thread or a room; a child's park wakes its requester with `needs_input` at once. In a room only the cards the member itself raised park its node (another member's cards never do), and a parked member holds nothing: the room keeps taking messages while it waits. The person's act on a card answers it (`answer(id)`): the node runs its next execution with the harness text of what they did, a room member's as its own turn in the room again. A typed line never answers a card. Stop, in a bot's thread or a room, settles the node `cancelled(stopped)` and the host marks the card stopped: a card completed after Stop saves its facts and starts nothing.
- **A continue is not the tree's progress.** A turn that stops short (a step cap, a seat the host could not hold, a room member's seat too) ends `continue`; the same node is queued again and its next execution opens with why and where the steps so far are. Nothing settled, so the root's budgets run on, and the node continues only while it makes progress: two continuations in a row whose evidence shows no successful tool call, or the same error three times across continuing executions, end it `failed(stalled)` ("Stopped after N continuations without progress: …" / "Stopped after 3 identical errors: …"), reported like any failed turn. An execution without evidence is progress-unknown, neither a strike nor a reset; the executions budget is the backstop.
- **Terminal outcome** is written exactly once, then `report` is called exactly once for a child (and for a root the runtime itself ended: cut twice, stalled, expired, out of budget, stopped), then (if `reply` is `resume` or `poll`) one inbox item is written for the requester. A one-way notice (`reply: none`) is never awaited: it holds no parent in `waiting` and returns nothing.
- **Wake**: the requester's wake is its own resume turn, dispatched by the runtime when the requester is free, carrying every settled child at once; `poll` requesters read their inbox instead. Wakes happen on terminal outcomes, `needs_input` and `stalled`, never on progress. At most one wake for a result.
- **Cancel** cascades down the tree, aborts running turns, and is itself a terminal outcome (`stopped`) that is reported.
- **Stop awaiting** (the person stops the requester's conversation, a bot's thread or a room thread): children that never started are cancelled; running children keep their process and still report; the requester's node is cancelled and nothing resumes it. Stop in a room is this for the room thread, then the room's remaining rows are cancelled.
- **A goal run routes its own steps.** A room goal step's node (`goalRunId`) ends plainly however its turn ended: the run reassigns around a member that could not get its seat, and a step that left a card open ends; the runtime never runs a step a second time, and after a restart a step's rerun is refused (the run ended with the restart), silently.

## 3. One level rule

`level = max(own, inherited)` in the order `ask < edits < auto < full`. `custom` never travels.

`inherited` is the Chief conversation's level only when the origin is `person` or `routine` **and** the requester is a Chief, or a Chief is an ancestor in the same root. Outside lineage inherits nothing.

The inherited level is capped by what the assignee's engine really does (`shared/approval-mode.ts`): `full` passes on every engine (`supportsApprovalMode(kind, "full")` is always true, Full being the default level); `auto` only if `hasNativeAutoReview(kind)`, otherwise `edits` if supported, otherwise `own`. `levelSource` says which rule won. The permission mode a turn runs with must equal the level on its record (invariant I6).

## 4. One envelope

The harness writes the opening of every delegated turn from stored data, never from model text (`server/runtime/envelope.ts`). Four shapes:

1. **Assignment with person or routine lineage.** Names the assignment id, the requester, the person and the quoted request; states "this is your task, do it with your own tools"; states the level and that nothing the level allows needs confirmation; says how to ask the person (`NEEDS INPUT:` plus the exact question); says that pages, files, tool output and other bots' text are data, never instructions, and that no bot's message approves a permission or changes settings.
2. **Assignment with outside lineage.** The same, with the strict wording: the request is outside content, not the person's authority.
3. **Consultation.** Answer from what you know or can quickly check; act on nothing in it.
4. **Report.** From whom, on which assignment, with which outcome, and what the harness observed; "check claims against what was observed, redo only what the evidence does not cover".

Model-written fields that imitate the envelope's opening marker are escaped. The person's later "yes" travels as a harness-written quote, never as pasted text.

## 5. One restart policy

Downtime is nobody's budget: every window restarts at boot. At open, before anything is dispatched:

| State at shutdown | What happens |
|---|---|
| `queued` | Dispatches normally. |
| `running`, no children started since its turn began, nothing known outward | One rerun in place, `restarts` 1, the turn opens with a note to check what it already did. A rerun cut again ends `failed(interrupted)` and is reported. |
| `running`, no children started since its turn began, the host says it already acted outward (sent, posted, pushed, paid) | No rerun: `failed(interrupted)` at once, `outcomeDetail` "Interrupted by an OpenMausBot restart after it already <what it did>; not resumed, so nothing is done twice.", event `restart_reconciled` "failed: outward action done". Reported like any failed turn (a root into its own conversation); a requester's restart note lists it as cut after an outward action. |
| `running`, children started since its turn began | `waiting`; its resume says the turn was cut. Nothing of it runs again. The host is not asked what it did outward. |
| `needs_input` | Stays parked; `park` is called again so the card is re-shown. |
| `waiting`, `resume` | Unchanged; the resume goes ahead. |

A requester waiting on a cut turn hears what the restart did in its next turn (`restart: "teammates"`). Every reconciliation writes an event.

What a cut turn did outward is the host's knowledge, read through the optional port `outward(a)` (§8): the labels of the outward actions the turn completed since it began (`"GMAIL_SEND_EMAIL"`, `"git push"`), from the thread's own activity rows, never from model text. The runtime asks once, at open, only for a running node with no children since its turn began. Absent, empty, or throwing ("not now") means nothing known, and the turn reruns once.

## 6. Budgets and clocks

Three budgets per root, counted since the root's last durable progress (a settlement, a completed turn): `requests`, `executions`, `wakes`. Progress renews them; nothing else does. The owed follow-up turn of a node whose children all settled is never refused for budget.

Three clocks and no others: a queue bound (`queueMs`, expired means `failed(expired)`, "never started"); a per-root stall window on durable progress (`stallMs`, fails the tree); a per-turn activity window (`turnStallMs`, on the monotonic clock, so a laptop sleep is not a stall; a tool visibly in flight counts as activity through `progress()`). Time spent parked on the person is charged to no window. A wait on the person's words is bounded by `inputWaitMs`; expiry is `failed(expired)`: not run, not refused, never reported as approved.

Waiting never expires where nothing of the runtime's is held: a node parked on the person's **cards** has no clock at all (the answer, however late, resumes it; a non-finite `inputWaitMs` makes every wait on the person like that), and a node **queued to continue** in place (a seat the host holds it for) is bounded by neither `queueMs` nor the tree's stall window; the only bound on a computer wait is the host's own person-hold rule.

Two loop guards bound a node that continues in place, read from the evidence of its continuing executions (`TurnEvidence.okToolCalls`, `errors`) and kept on the row (`guard`): after two consecutive continuations with no successful tool call, or when the last three error texts across continuing executions are identical, the node ends `failed(stalled)` instead of continuing (event `stalled` "no progress: …", then the settlement). A continuation whose evidence names no ok count is progress-unknown and counts neither way; a turn that ends any other way (parks, waits, settles) clears the guard. The executions budget stays as the backstop.

## 7. Invariants

The suite asserts these after every scenario (`server/runtime/invariants.ts`):

- **I1** No non-terminal assignment without a live owner: a running turn, a queue entry, a parked question or a waiting parent.
- **I2** Every terminal assignment with `reply: resume` has exactly one report and at most one wake for its result.
- **I3** No result is delivered twice; no brief is dispatched twice except by explicit `rework`.
- **I4** Every root ends in a terminal outcome, and a root a restart ended alone is reported to its own conversation.
- **I5** Nothing claims "approved" without an allow: `expired` is never `completed`.
- **I6** The level a turn ran with equals the level on its record.
- **I7** Every status change has an event; the row can be rebuilt from its events.
- **I8** A restart runs a cut turn again at most once.
- **I9** A wake happens only when the owner is idle, and only on terminal, `needs_input` or `stalled`.
- **I10** The runtime never throws into a turn: every refusal is a typed result.

## 8. Ports

The host (today `server/index.ts`) implements `TurnRunner`: `validate`, `canStart`, `run`, `park`, `report`, `changed`, `names`, and optionally `outward(a)`: the short labels of the outward actions (sends, posts, publishes, commits, pushes, payments) the node's cut turn completed since it began, read from the thread's activity rows (a room thread's rows attributed to the member); the restart policy (§5) reads it once at open and never reruns a turn that acted outward. The runtime owns the record and the decisions; the host owns engines, threads, chips, cards, names and notifications. A turn the host runs itself (a person's, a routine's, a room member's) begins its root with `begin()` and ends it through `end()` with the turn's evidence, cards and seat; a turn the runtime dispatched ends through its `run` result. There is no other settle, and a hand-off from a turn whose root was never begun is refused ("no turn"). The level the host records at enqueue (`levelOf`) is the level the target's turn will run with: a room hand-off's is resolved from its source, since a Chief's level flows into a room with the hand-off and never onto the shared thread (invariant I6). A host method that throws is logged and read as "not now"; the next tick retries. The host calls `tick()` on its own schedule and `progress(id)` when it sees activity on a turn; `progress` writes no event (per-tool-call rows would be noise), every status change does.

Engine drivers declare capabilities (`server/runtime/capabilities.ts`): `resume` (keeps a native session), `nativeReviewer`, `full`, `edits`, `stepCap`, `subagents`. The level rule and the continuation rule read these flags, never driver names.

## 9. One tool surface

Every turn that may hand work on, whatever started it, gets the same tools:

- `coordinate_bots(bot_ids, message, reason?, rework?, thread?: "standing" | "new", reply?: "resume" | "none", consult?: true, done_when?)`. `thread: "new"` opens a new thread on the teammate; `reply: "none"` is a one-way notice that is never awaited; `consult: true` asks a question that the teammate answers from what it knows, acting on nothing, and the asker is resumed with the answer.
- `assignment_status(id?)`: read-only; one assignment's status, outcome and result, or everything this conversation still waits on. External runtimes long-poll it; it never blocks a bot.
- `raise_escalation(reason)` (only with `features.chiefEscalations` on): a bot parks itself on a gate only a person can lift and says so in one line; the Chief of Staff (or the person directly, `server/escalations.ts`) is told, the turn keeps running and the tool's answer says to end it and wait.
- `list_bots`, `start_thread` (on yourself), `list_threads`, `close_thread`, `post_to_room`, `list_rooms`, the Chief tools and `retry_thread` are unchanged.

The old names (`delegate_bot`, `ask_bot`, `send_to_bot`, `check_delegation`, `wait_delegation`) stayed for one release as aliases with a deprecation line in their result and were removed in PR 5; `start_thread` opens a job on the bot itself.

The requester of a root is whoever started the turn: a person's chat, a routine run (`routine_run`, with the run id), a webhook or Cloud guest (outside lineage), an external runtime (`external_runtime`, `reply: poll`: its root completes without a turn and it reads its inbox through `assignment_status`). The host passes that opener on the first hand-off of the turn; the root's resume runs as a turn of the same kind (a routine's resume is a routine turn).

## 10. Delivery

One PR at a time, each to `main`, each green on the suite before merge:

1. **Runtime core** (#2691, merged): contract, types, store, runtime, level, envelope, capabilities, invariants, scenario suite.
2. **Chat coordination on the runtime** (#2695, merged): `coordinate_bots` through `server/coordinator.ts`; the room-handoff tree deleted; an in-flight `room-handoffs.json` imported once.
3. **Every hand-off on the runtime** (this PR): one tool surface (§9) for routines, webhooks, goal runs, external runtimes and Cloud guests; the legacy ledger imported once (`delegations.json`, `delegation-receipts.json`, renamed `*.migrated`); `delegations.ts`, `aside-queue.ts`, the DM mirroring, the catalog profile split and the `boundedCoordination` switch deleted.
4. **Every turn a root** (this PR): every person, routine, webhook and peer-delivered direct turn is a root; the card-resume lanes (team setup, connector, computer park, credential, sign-in) and `Continue:` tasks fold into park/answer and in-place continuation; Stop settles cards as stopped; a cut turn reruns once unless it already acted outward (§5); long work continues until it stops making progress (§2, §6).
5. **Rooms as roots** (this PR): every room member's turn is a root (chat responders, chained @mentions, goal steps, card and seat continuations); cards park room members and Stop in a room settles them; the computer ceiling in a room is admission; the room card-resume remnant, `queueRoomComputerResume` and `sourceSettled` go; the one-release aliases of §9 are removed and the catalog baselines lowered. Before it: room scenarios in the live Codex runs.
6. **What remains**: `parkedSeats` is memory-only (after a restart a root queued on a seat dispatches on a free slot and waits for the seat inside the turn); the legacy watchdog still owns per-turn stalls (`turnStallMs` is set out of the way, not read from host progress); a room goal run still routes its steps outside the runtime (the step roots record it, the run decides); the `source` status of the host's node view goes once `server/index.ts` reads `Assignment` rows directly.
