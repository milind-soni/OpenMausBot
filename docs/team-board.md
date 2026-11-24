# Team Board

A work layer over a Team Cloud's rooms. A room thread can carry one **board item**: a title, a state, what it waits
for, labels, and which bot may take it. Rooms and threads stay what they are; the item only says where the work in that
thread stands. Nothing new is shown to anyone: a person sees an item exactly when they can see its room thread.

It is off unless an Owner or Admin turns on **Board** in Settings → Features (`features.teamBoard` in `config.json`).
The switch exists only on a Team Cloud; anywhere else, and while it is off, the routes below answer 404.

This release has the items, their states, the routes and the live frame. Bots taking items, the bot tools, the Board
page and repeating items come later.

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
| `question` | What its bot asked a person (while `needs_person`). |
| `result` | What came of it, at most 2,000 characters. |
| `createdBy` | The person or bot who made it. |

A room holds at most 200 items that are not settled.

## States

`waiting` → `ready` → `working` → `done` | `failed` | `cancelled`, with `needs_person` beside `working`.

- A new item is `waiting` while any need is not `done`, else `ready`. A waiting item becomes ready by itself when its
  last need is done; a failed or cancelled need readies nothing.
- `ready` → `working`: the server gives it to a bot (later releases).
- `working` → `done`, `failed`, `needs_person` (the bot asked someone) or back to `ready` (released, or the turn ended
  without settling it). `needs_person` → `working` when the person replies, `ready` when a person releases it, or
  `cancelled`.
- A person may cancel any open item, mark any open item done, release one waiting on a person, and reopen a settled
  one (its tries start again from 0, and it waits again if a need is not done). A bot may cancel an open item it made.
- An item that is removed, or whose thread or room is deleted, stops being needed: what waited only on it is ready.

Every other move is refused with 409 `board_bad_move`. The rules are `server/board/state.ts`.

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
