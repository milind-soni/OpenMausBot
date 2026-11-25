# Team Board

A work layer over a Team Cloud's rooms. A room thread can carry one **board item**: a title, a state, what it waits
for, labels, and which bot may take it. Rooms and threads stay what they are; the item only says where the work in that
thread stands. Nothing new is shown to anyone: a person sees an item exactly when they can see its room thread.

It is off unless an Owner or Admin turns on **Board** in Settings → Features (`features.teamBoard` in `config.json`).
The switch exists only on a Team Cloud; anywhere else, and while it is off, the routes below answer 404.

The server hands each ready item to a free bot of its room and starts that bot's turn in the item's thread; the bot
settles it with its board tools. There is no Board page: items are read and changed through the routes below and the
bots' tools, and a room thread whose item waits on a person shows as waiting on you, as an open card does. Repeating
items come later.

## The item

`BoardItem` in `shared/board.ts`, one per room thread, keyed by its `threadId`:

| Field | |
|---|---|
| `title` | One line, at most 120 characters. |
| `state` | See below. |
| `needs` | Thread ids of other items in the same room that must be `done` first; at most 10, never a loop. |
| `labels` | At most 12; key of at most 32 of `a-z 0-9 _ -`, value of at most 80 characters. |
| `forBotId` | Only this member bot of the room may take it; otherwise any of them. |
| `holder` | The bot working on it, and since when (while `working` or `needs_person`). |
| `attempts` | Times a bot took it since it was made or reopened. |
| `question` | What its bot asked a person (while `needs_person`), and whom. |
| `later` | When its bot set it aside to look again, and its note (while `working`). |
| `laterCount` | Times its bot set it aside since it was made or reopened; at most 20. |
| `result` | What came of it, at most 2,000 characters. |
| `createdBy` | The person or bot who made it. |

A room holds at most 200 items that are not settled.

## States

`waiting` → `ready` → `working` → `done` | `failed` | `cancelled`, with `needs_person` beside `working`.

- A new item is `waiting` while any need is not `done`, else `ready`. A waiting item becomes ready by itself when its
  last need is done; a failed or cancelled need readies nothing.
- `ready` → `working`: the server gives it to a bot (see Dispatch).
- `working` → `done`, `failed`, `needs_person` (the bot asked someone) or back to `ready` (released, or the turn ended
  without settling it). `needs_person` → `working` when the person replies, `ready` when a person releases it, or
  `cancelled`.
- A person may cancel any open item, mark any open item done, release one waiting on a person, and reopen a settled
  one (its tries start again from 0, and it waits again if a need is not done). A bot may cancel an open item it made.
- An item that is removed, or whose thread or room is deleted, stops being needed: what waited only on it is ready.

Every other move is refused with 409 `board_bad_move`. The rules are `server/board/state.ts`.

## Dispatch

`server/board/dispatcher.ts`, wired in `server/board/wiring.ts`. It runs on a Team Cloud with the board on, whenever the
board changes, a bot's state changes, the runtime reports a turn's node changed, and on the shared due-timer.

- **Per bot.** A bot runs one room turn at a time and only when idle everywhere. For each `ready` item, oldest first,
  the dispatcher picks its `forBotId`, else the first member bot of the room that is free: not hidden, held, paused,
  awaiting an approval level, busy anywhere, its engine's account not being changed, and holding no other item it is
  working on (an item waiting on a person, or set aside, does not count). No free bot: the item stays ready.
- **Caps first.** Before a start it checks the monthly spend limit and the usage caps as unattended work (nobody
  waiting). A refusal pauses every dispatch until the cap resets; no attempt is counted.
- **Model.** A bot whose engine is missing is passed over for 10 minutes.
- **The turn.** `take` (attempts + 1), then `startGroupTurn` in the item's thread with `@Bot` and the bot as the one
  mention, as unattended work (`trigger: { kind: "bot" }`, never the person's own request), from a sender named Board
  with no person behind it. The line carries the item's title, its thread's first line, what each need came to, and how
  to finish. A start the server refuses hands the item back (or fails it at the third attempt) and waits a minute.
- **The lease is the turn.** An item still `working`, not set aside, whose thread is idle 20 seconds or more after its
  bot took it, lost its turn: back to `ready`, or `failed` with "Stopped after 3 tries" at the third.
- **Restarts.** Nothing is started, and no lease is checked, in the first two minutes after the server starts: the
  runtime re-runs a room turn a restart cut. An item set aside keeps its time across a restart, and a sleeping Cloud
  wakes for it.
- **Maintenance and moves.** It stops with the other timers during maintenance and while the Cloud is moving.
- **Waiting on a person.** `ask` keeps the item's holder and frees the bot. The person's chat line in that thread is
  addressed to the holder (`@Bot ` is put in front unless it already names it), whoever the room's default responder
  is, and the item goes back to `working`. An answer from the person's inbox lands in the thread as the bot's relay line
  and starts no turn by itself: the item then goes back to `working` and the holder is started as soon as it is free,
  with that answer as its line.
- **Set aside.** `later` keeps the item `working` and its holder, frees the bot, and starts the same bot again at the
  time with its own note. It counts no attempt. The 21st `later` on one item fails it.

## Bot tools

Listed only on a Team Cloud with the board on (`OMB_TEAM_BOARD`), in chats and in rooms, deferred for Claude; each is
in the core tool group. The internal routes are `server/routes/board-tools.ts`; a confined turn (work from outside)
cannot reach them.

- `board_add` `{ room?, items: [{ key, title, brief?, needs?, labels?, for? }] }`: 1 to 15 items, each on a new thread of
  the room (default: the room of the turn), the bot's `brief` (or the title) as its first line, written as the bot's.
  `needs` are keys of the same call or item ids of the room; `for` is a bot's name in the room. Everything is checked
  before the first thread opens, so a bad entry leaves nothing behind. Only rooms the bot is a member of.
- `board_list` `{ room?, state? }`: the items of the bot's rooms, one line each, at most 60.
- `board_update` `{ item?, move?, text?, person?, minutes?, labels? }`: the item of this thread unless `item` is given.
  `done` and `failed` take `text` as the result; `ask` posts `text` as the bot's line in the thread and puts it in the
  inbox of `person` (a teammate's name or email), else of the person who made the item; `later` takes `minutes` (1 to
  1,440) and `text` as the note; `release` hands it back to ready. `labels` replaces them. Only the bot holding an item
  may settle, ask about or set it aside.

## Routes

For every member and admin who is signed in (`server/routes/board.ts`). Writing needs what writing in the room needs:
chat access to each of its bots.

- `GET /api/board[?groupId=]` → `{ items }`, the ones the caller can see, oldest first.
- `POST /api/board/items` `{ groupId, title, text?, needs?, labels?, forBotId?, threadId? }` → 201 `{ item }`. Without
  `threadId` it opens a new thread in the room, without making it the room's current one, whose first line is `text`
  (or the title), written as the caller's; no bot answers it. With `threadId`, that thread of the room becomes the item.
- `PATCH /api/board/items/:threadId` `{ move?: "cancel" | "reopen" | "release" | "done", title?, labels?, needs?,
  forBotId?, result? }` → `{ item }`. `labels` replaces them all; `needs` changes only before a bot takes the item;
  `forBotId: null` lets any member bot take it.
- `DELETE /api/board/items/:threadId` removes the item; its thread and everything said there stay.

Errors carry a `code`: `board_bad_input` (400), `board_not_found` (404, also for an item the caller cannot see),
`board_bad_move`, `board_exists`, `board_cycle`, `board_full` (409).

## Live frame

`{ kind: "board.item", groupId, threadId, item }` on every change (`item: null` when it is removed), sent only to people
who can see that room thread.

## Storage

`board.json` in the data folder, written whole and readable only by its owner: `{ version: 1, items, repeats }`. A new
file, so older versions simply do not read it. A file that does not parse is an empty board, and an item that does not
parse is left out.
