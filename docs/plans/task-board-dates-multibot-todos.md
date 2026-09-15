# Task board: dates, multi-bot cards, and a card checklist

**Status:** design for approval — nothing implemented yet.
**Branch:** `feat/task-board-ui` (continues the UI round already on that branch).

---

## 0. What can and cannot be built as asked

Three requests. Two map onto machinery that already exists; one does not exist at all
and I will not pretend otherwise.

| Request | Verdict |
|---|---|
| Pick a **date** for a card, integrate with automations | **Buildable.** Automations already have a one-off schedule (`{type:"once", at}`) and a routine→card projection. Nothing about "run once at date X" needs inventing. |
| Assign **several agents** to a card, integrate with group chat | **Buildable, and the integration is the honest one.** A room is already the multi-bot primitive. But a card currently starts a 1:1 turn, so this is a real change to how a card runs. |
| Add a **todolist** to cards, synced with the native todolist | **The premise is wrong.** There is no native todolist in this codebase. I checked before designing; details in §1. |

The third one is the important correction, so it comes first.

---

## 1. There is no native todolist — verified, not assumed

I searched for a todo/checklist subsystem before designing against it, because building a
"sync" with something that does not exist would be a fiction.

What exists:

- **No todo model.** No `TodoItem`, no `todo_write`/`todowrite`/`write_todos` agent tool.
  The reviewed agent-tool catalog (`server/agent-tool-policy.ts`) is a short read-only
  list — `list_bots`, `list_threads`, `check_delegation`, `session_read`, … — with no todo
  tool in it.
- **No todo storage.** Nothing persists checklist items. `~/.openmausbot/` holds
  `bots.json`, `groups.json`, `routines.json`, `work-items.json`, `messages.db`; none has a
  todo list.
- **No todo UI.** No component renders pending/in_progress/completed items.
- **No todo status union.** `"pending" | "in_progress" | "completed"` appears nowhere. The
  only nearby union is `WorkStatus` (`server/work-items.ts:25`) — the board's *column*
  names, which is a different thing that happens to contain the word "todo".

Two things get mistaken for it, and neither is a todo list:

1. **The `todo` board column.** A lane a card sits in.
2. **`VerifyCard`** (`src/components/VerifyCard.tsx`), which renders a bot's *run* as a
   checklist of commands (`src/lib/verify-steps.ts`). It is a derived, read-only view of a
   transcript — `"running" | "passed" | "failed"`, not editable, not persisted, not per-card.

**Consequence.** "Sync with the native todolist" has no referent. So there are two honest
options, and this is a decision for you rather than for me:

- **(A) Build the card checklist as its own thing** (§4). It lives on the card, persists
  with the card, and "all items done → card moves to Done" is a rule in the card model. No
  sync, because there is nothing to sync with. ~1 day.
- **(B) Build the todo list *first* as a real feature**, then sync cards to it. That is a
  bigger piece of work with its own questions: is it per bot, per thread, or global? Does
  the agent get a tool to write it? Does it survive a thread being closed? It is a
  feature in its own right, not a prerequisite for cards.

My recommendation is **(A) now, (B) later if you want it** — a card's steps are useful
immediately, and (B) is a decision worth making on its own terms rather than as a side
effect of the board. **This document designs (A)** and flags exactly where (B) would
attach later (§4.4) so nothing has to be undone.

If you actually meant an *external* list — a different tool, a file, GitHub issues — tell
me which and I will design against that instead.

---

## 2. Dates on cards

### 2.1 The gap

Cards have `createdAt`/`updatedAt`/`startedAt` but nothing that says *when this is meant
to happen*. Running is always manual: you press Start.

Meanwhile automations already own scheduling and already own a one-off:

```ts
export type RoutineSchedule =
  | { type: "once"; at: number }                        // server/routines.ts:41
  | { type: "daily"; time: string; weekdays: number[] }
  | { type: "cron"; expression: string; timeZone: string }
  | { type: "interval"; everyMinutes: number; anchorAt: number; … };
```

And there is already a link in the card, one-way by design:

> A card never CREATES a routine: a board column is not a schedule.
> — `server/work-items.ts`, on `routineId`

That comment is the constraint the design has to respect.

### 2.2 Design — two different things, deliberately not merged

A date on a card can mean two things, and collapsing them is how a board turns into an
unpredictable scheduler:

- **`dueAt` — a deadline.** "This should be finished by Friday." Changes *nothing* about
  execution. The card shows it, sorts by it, and goes red when it is past. No turn ever
  starts because of it.
- **`runAt` — a start time.** "Act on this at 09:00." This one *does* cause work, and
  therefore must not be a second scheduler running inside the board.

**`dueAt`** is a plain field on `WorkItem` (epoch ms, or absent). Display-only. Low risk.

**`runAt`** is implemented by **creating or updating a routine** (the existing
`{type:"once", at}`) and marking the card as its projection. Concretely:

- The card gains `scheduledRoutineId?: string`.
- Setting a start time on a card creates a routine whose `botId` is the card's owner, whose
  prompt is the card's brief, and whose schedule is `{type:"once", at: runAt}` — then stores
  its id on the card.
- The scheduler fires it as it already fires everything: `store.createTask` → `startTurn`
  (`server/routines.ts:1428-1472`), and `projectRoutineRunToBoard` moves the card, because
  that path already exists (`server/index.ts:5984`).

This buys real things for free: catch-up after the machine was off, `missed` runs recorded,
the run appearing in the calendar next to every other automation, cancel/enable, and the
existing tests. And it keeps the board honest — the board still does not schedule anything
itself; it edits a routine, which is what routines are for.

**What "integrate with automation" means here, precisely:** one start time on one card
becomes one one-off routine, visible in the Automations calendar, editable from either
side. Clearing the date on the card disables the routine. Changing it re-points the same
routine rather than piling up new ones.

### 2.3 Deliberately not doing

- No repeat/interval picker on cards. Recurrence is a routine's job; if you want a
  recurring card, make the routine and let it project the card (that already works).
- No "the board auto-runs everything due today". A date that silently starts N turns is a
  surprise with a cost attached. **A start time runs exactly one card's work, once.**
- Card moves by hand still work exactly as now: a card that ended up somewhere else is not
  yanked back by its routine (that skip already exists — `work-items.ts:414`).

---

## 3. Multi-bot cards and group chat

### 3.1 Why this is the right integration

A room is already the multi-bot conversation primitive:

- `GroupRecord.memberIds` (`server/store.ts:251`), persisted to `groups.json`.
- One message → `startGroupTurn` (`server/index.ts:7964`) → responders resolved by
  `roomResponders` (`server/store.ts:813`) → **sequential** turns on `groupQueues`, one
  speaker at a time, with one-hop chained `@mentions` (`MAX_GROUP_HOPS = 1`).

So "two agents on one card" and "group chat" are not two features to wire together — they
are the same feature seen twice. Assigning a second bot to a card *is* creating a room for
that card's work.

### 3.2 The model

`WorkItem.ownerBotId?: string` becomes:

```ts
ownerBotIds?: string[]        // 0, 1 or many
ownerBotId?: string           // kept, derived = ownerBotIds[0], for one release
```

`ownerBotId` stays readable so the existing UI, the routine projection
(`work-items.ts:397`) and the old tests keep working; it becomes a *view* of the first
element rather than a separate truth. That avoids a flag-day migration of
`work-items.json`.

When a card has:

- **0 bots** — as today, Start is off with a reason.
- **1 bot** — unchanged behaviour: a 1:1 turn, exactly the current path.
- **2+ bots** — a **room**: the card runs its turn through `startGroupTurn`.

### 3.3 The room behind a multi-bot card

The card gets `groupId?` and `threadId?` (already exists) pointing at a room created for
this work:

- Room created lazily **on first Start**, not on assignment — assigning two bots to a card
  must not litter the sidebar with empty rooms.
- `memberIds` = the card's bots; `defaultResponder` = `{kind:"mentions"}` so a card's brief
  does not accidentally address nobody, and the card's run supplies the prompt.
- Room name = the card's title, so it is recognisable in the sidebar.
- The room **is** the card's chat: "Open chat" on a multi-bot card opens the room. That is
  the integration you asked for, and it needs no new concept.

Two constraints I verified rather than assumed:

- `startGroupTurn` requires the thread to be a real room task:
  `ownsThread = group.dm ? … : Boolean(store.groupTaskByThread(group.id, threadId))`
  (`server/index.ts:7976-7981`). A user-created group already gets one task in
  `createGroup` (`store.ts:1206` — `group.tasks = [{threadId, …}]`), so a created room
  satisfies this — but a card that re-points at an existing room must adopt that room's
  task thread, not invent one.
- `roomSetupPending` (`server/index.ts:8219`) refuses the first send in a room whose setup
  wizard has not been completed, and `createGroup` sets
  `setupCompletedAt = setup?.completed ? createdAt : null` (`store.ts:1207`) — so the
  default is **null**, i.e. pending. A room made by a card must therefore pass
  `setup: { completed: true }`, or a card's Start would fail with "finish room setup" — a
  wizard nobody asked for appearing in the middle of pressing Start.

### 3.4 What a multi-bot card's turn actually does

Start on a multi-bot card sends the card's brief into the room via `startGroupTurn` with
`channelMode: "chat"`. The existing routing decides who speaks: `@everyone`/`@Bot` in the
brief if present, otherwise the room's default responder. I am **not** adding a second
orchestrator: rooms already have responder policy, chained mentions, the handoff tree
(`server/room-handoffs.ts`) and the post budget (`server/room-post-budget.ts`). A card
reuses them.

Stop maps to the room's interrupt (`POST /api/groups/:id/interrupt`, `index.ts:12907`),
mirroring how the card's Stop already delegates to the thread interrupt.

`startGroupTurn` is currently module-local. It gets exported (or a thin queue-aware
wrapper is added), following the precedent of the routine host calling it directly at
`server/index.ts:6124`.

### 3.5 Honest limits to accept

- **Sequential, not parallel.** Bots speak one at a time — that is deliberate in this
  codebase ("one speaker at a time — the transcript and streaming bubble stay coherent").
  A card with three bots does not run three turns at once, and should not.
- **`busy` becomes ambiguous.** Today `agent.busy` is one bot. On a multi-bot card the card
  is "working" if *any* member is mid-turn; the card needs to say which bot is speaking
  (`GroupRecord.busyBotId` already exists).
- **Group execution is heavier** than a 1:1 turn and can cost several provider turns. The
  room's existing budgets apply; the card must not add its own retry loop on top.

---

## 4. Card checklist

### 4.1 Model

On `WorkItem`:

```ts
export interface CardTodo {
  id: string;
  text: string;
  done: boolean;
  order: number;
}
todos?: CardTodo[];
```

Deliberately minimal. No `status` triad, no priority, no assignee: an item is done or it is
not, which is what makes the "all done → Done" rule unambiguous. If you want
per-item owners/priorities later, that is a bigger model and belongs with (B) in §1.

### 4.2 The one automatic transition, and its guardrail

When every item is done and there is at least one item, the card moves to `done`. Rules,
because a silent auto-move is how boards lose trust:

- **Only fires on the last item becoming done**, never on a card that arrives already
  complete (e.g. a re-fetch), and never when the list is empty — an empty checklist is not
  a finished job.
- **Only from a working column.** A card in `backlog` whose todos are all ticked does not
  teleport to Done; it stays where the person put it. The rule is "the work finished", not
  "a list is ticked".
- **Never from `cancelled`**, and never resurrecting a card a person deliberately moved.
- **Un-ticking does not move it back.** Completion is a moment, not a mode; reversing it
  would fight whoever moved the card next.

This lives in `WorkItems.update` as a pure helper next to the existing `TERMINAL` handling,
so it is testable without a server.

### 4.3 UI

On the card: a compact `3/5` progress chip and an expandable list; ticking an item is a
`PATCH`. Same interaction in the card editor. Reuses the existing 4s board poll — note
there is **no `case "task-board"`** in the SSE reducer (`src/store.tsx:3133`), so board
updates ride polling today. If that ever becomes too slow, adding the reducer case is the
fix, and it is a separate change.

### 4.4 Where a real todo feature would attach later

If you want (B) in §1: a global/per-bot todo store would become another *source* for
`CardTodo` — a card would keep a `todoSourceId` instead of owning its items, and the same
"all done → Done" helper would read from that source. Nothing in §4.2's rules changes. I am
not building the mirror now, because building a sync against a nonexistent store is how you
get two half-features instead of one working one.

---

## 5. Files

| File | Change |
|---|---|
| `server/work-items.ts` | `dueAt`, `runAt`, `scheduledRoutineId`, `todos`, `ownerBotIds`, `groupId`; the all-done rule; validation |
| `server/work-items.test.ts` | the rule's guardrails, multi-owner derivation, todo validation |
| `server/index.ts` | card routes accept the new fields; run routes branch 1:1 vs room; `startGroupTurn` exported; date→routine bridge; `boardPayload` reports which bot is speaking |
| `server/task-board-api.test.ts` | new fields over HTTP, 403s unchanged, group-vs-1:1 run |
| `server/task-board-run.test.ts` | a 2-bot card runs in a room; setup-pending room does not block a card's first Start |
| `server/task-board-routines.test.ts` | a card's `runAt` fires through the routine path and moves the card |
| `src/lib/task-board.ts` | client mirrors + pure helpers (due state, todo progress, all-done) |
| `src/lib/task-board.test.ts` | same |
| `src/components/TaskBoardCard.tsx` | due chip, todo progress + list, multi-bot avatars, who-is-speaking |
| `src/components/CardEditorDialog.tsx` | date fields, multi-bot picker, todo editor |
| `src/components/BotSelect.tsx` | multi-select mode |
| `src/components/TaskBoardPage.tsx` | wire the above |
| `src/locales/*.json` | new strings, all 9 locales |

## 6. Sequencing

1. **Checklist** (§4) — self-contained, no new subsystem, immediately useful.
2. **Dates** (§2) — `dueAt` display, then the `runAt`→routine bridge.
3. **Multi-bot** (§3) — the largest: model, room creation, run/stop through the room,
   then the picker. Last because it is the one that can cost provider turns if wrong.

Each step lands green on its own. Tests come with the code, as the previous rounds did.

## 7. What I need from you

1. **§1**: build the card checklist as its own feature (A), or build a real todo list first
   (B)? Or did you mean an external/third-party list I should target instead?
2. **§3**: is "assigning 2+ bots creates a room for that card" the integration you had in
   mind, or did you expect a card's bots to work without a room appearing in the sidebar?
3. **§2**: should a start time be limited to one card's single run (my design), or do you
   want cards that repeat on a schedule?