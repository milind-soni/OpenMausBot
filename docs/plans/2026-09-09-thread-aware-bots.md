# Thread-aware bots

A PM bot should be able to tell a QA bot "open a thread for each pull request
still waiting on QA", and each of those should become a real, visible,
independently running thread on the QA bot, with the PM bot able to see how
each one is going. Today a bot cannot create a thread at all, on itself or on
a teammate, and it does not know that it cannot.

## What happened

A user asked a bot to "create a new thread for each open PowerPM that is
waiting for your review". The bot opened three ticket comments instead, then,
when asked, explained correctly that it has no callable action to create
OpenMausBot threads and that those come from separate user prompts. It was
right about the code and wrong to guess; the gap is that nothing told it
either thing up front.

## Where the code is today (main 922715f, 0.1.69)

- **Threads exist and run independently.** #981 made Tasks the user-facing
  Threads: one bot runs up to three direct threads at once (Settings →
  General → Parallel threads, 1–10), each with its own model, approval
  preference, unread state, working directory and Stop. Extra messages queue
  above the composer until a slot frees. `docs/plans/2026-09-09-independent-threads.md`.
- **Only a person can open one.** `POST /api/bots/:id/tasks` (server/index.ts
  ~12309) takes a title and an optional folder, always activates the new
  thread for the caller, and is behind the owner session. There is no
  internal endpoint and no MCP tool for it.
- **Every peer message lands in the target's active thread.** `runDelegatedTurn`
  reads `store.bot(toBotId)?.threadId` (server/index.ts ~3816) and `ask_bot`
  dispatches to the same. Ten delegations to one bot are ten turns queued
  behind each other in whichever thread the person happens to be looking at,
  interleaved with their own conversation. The three-slot concurrency that
  #981 built is never used by bot-to-bot work.
- **The delegation ledger is per delegation, not per thread.** `check_delegation`
  and `wait_delegation` key on the delegation's task id; a delegating bot can
  ask about one hand-off but cannot list "the QA threads I opened yesterday"
  or see their unread and running state.
- **The bot's prompt never mentions threads.** The roster, the room prompt and
  the tool descriptions talk about bots, rooms and delegations. A bot that is
  asked about threads has nothing to reason from except the word.
- **Fan-out is already rate-limited elsewhere.** `MAX_CREATED_PER_TURN = 4`
  for `create_bot`, `MAX_ROOM_POSTS_PER_TURN = 3`, `MAX_QUEUED_PER_THREAD` for
  delegations, and the room post budget. Thread creation needs the same shape.
- **Thread titles are already capped** at 80 characters in `store.createTask`,
  and #983 cut created titles further at the HTTP edge. Bot-authored titles
  must go through the same flattening as names and titles do (`fitsOnOneLine`).

## What to build

Three tools on the agents proxy, one ledger extension, one prompt line, and
the UI attribution that makes it honest.

### 1. `list_threads`

Returns the calling bot's own threads and, for each reachable peer, that
peer's threads **that the caller opened** (see attribution below). Per row:
thread id, bot, title, state (`running | waiting-on-you | queued | idle`),
unread for the person, last activity, and the delegation id if one is
attached. Never a peer's private threads: the visibility rule is "you see the
threads you started, plus your own". Same section and allow-list checks as
`list_bots`.

### 2. `start_thread`

```
start_thread({ bot_id?, title, message, folder? })
```

- Omit `bot_id` to open a thread on yourself. Naming a peer is a delegation
  into a **fresh** thread on that peer: everything `delegate_bot` enforces
  applies unchanged (section, `peers` allow-list, `approvePeerComms` card,
  unattended inheritance, depth cap, `MAX_QUEUED_PER_THREAD`), and the reply
  comes back through the same ledger, so `check_delegation` and
  `wait_delegation` work on the returned id.
- The new thread is created with `activate = false`. #981's rule that
  selecting a thread never redirects running work also means a bot must never
  switch what the person is looking at. The thread appears beneath the bot in
  the sidebar as a new row; the person opens it if they want.
- The first message is the `message`, wrapped with the existing peer
  provenance note when the opener is another bot.
- Concurrency is whatever the target bot's Parallel-threads setting allows.
  Ten PR threads on a bot set to three means three run and seven wait in the
  existing queue, in order, visibly. The tool result says so: "opened; 3
  running now, this one is 4th in line".
- Cap: `MAX_THREADS_PER_TURN = 5` on the proxy, same spirit as bots and room
  posts, with a refusal that tells the model not to retry and to say what it
  still wanted opened. A person asking for twelve gets twelve across three
  turns, or the bot says which nine it did not open.
- Title through `fitsOnOneLine` and the 80-character cap; folder must belong
  to the target bot.

### 3. `close_thread` (deliberately small)

Marks a thread the caller opened as done, which is the sidebar's idle state
plus a final activity chip in that thread. No deletion: deletion stays a
person's confirmed action. A PM bot that opened ten QA threads can tidy the
ones whose reply it has read.

### 4. Ledger: threads carry their opener

`TaskRecord` gains `openedBy?: { botId, name, delegationId?, at }`. Persisted
with the task, exported in the wire shape, shown in the sidebar row and on
iOS as a small "opened by Scout" label. This is what makes `list_threads`
scoping possible and what the person needs in order to trust a thread they
did not start. Backups copy it like `peerPost` and `peerAsk`.

### 5. The prompt tells a bot what a thread is

One paragraph, mounted with the agents tools:

> A thread is one conversation with its own history and its own run; a bot
> can have several running at once, and the person sees them as rows under
> that bot. Use `start_thread` to open one on yourself for separate work, or
> on a teammate to hand them a job that should run on its own. Use
> `list_threads` to see how the ones you opened are going. Do not use a
> ticket comment, a note, or a room post as a stand-in for a thread.

That last sentence is the fix for the screenshot.

### 6. Notifications and silence

A bot-opened thread is internal work until it needs a person, exactly like
#773's rule: no badge, no push on open; the peer's card, takeover or question
still breaks through, deep-linked to that thread; and completion is reported
once, by the opener's resumed turn, never twice. A thread the person has
opened in the sidebar behaves as any thread they read.

### 7. Threads are linkable from chat

When a bot writes a thread's title as `#Title` in a reply, the transcript
renders it as a link that opens that thread: select the bot, switch to the
thread, never redirect running work. Resolution mirrors @mentions: word
start, longest known title first, case-insensitive, only titles the person
can actually see, never `#123`-style numbers or markdown headings. The chip
a bot leaves when it opens a thread carries a structured `threadRef` and is
the same clickable pill the bot⇄bot exchange chips already are, visible even
with Tool calls hidden. Phones decode both fields, show the opener label, and
tap through to the thread by the switch route they already use.

## Sequence

1. `openedBy` on `TaskRecord`, wire, sidebar and iOS label, backup round trip.
2. `start_thread` on self, then on a peer through the delegation path; the
   ledger, gates and cap; proxy tests plus one end-to-end with the fake CLI
   opening three threads on a peer set to two slots and asserting one queues.
3. `list_threads` with the opener scoping rule and a privilege test that a
   peer's other threads never appear.
4. Prompt paragraph; a test that the words "start_thread" reach both the 1:1
   and the room system prompt.
5. `close_thread`.
6. `#Title` links and the `threadRef` chip on desktop and mobile.

## Risks and the answers

- **A runaway fan-out.** Same cap shape as `create_bot`; the per-bot slot
  limit bounds what can actually run; queued threads are visible and can be
  cancelled from the composer queue.
- **A peer seeing threads it should not.** Scoping is by opener, enforced in
  the query, tested with a negative case.
- **The person losing their place.** Never activate a bot-opened thread.
- **A bot-authored title used as an injection line.** Same flattening the
  roster and provenance note use; the title is a label, never prompt text.
- **Trust in a thread nobody remembers starting.** The opener label and the
  provenance note on the first message.

## Not in this plan

Cross-bot thread search, a board view of all open threads (the Hermes-style
kanban), moving a thread between bots, and independent execution of group
members. Each is a real follow-up; none is needed for the PM-to-QA case.
