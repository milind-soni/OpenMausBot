# Pausing a bot or a department

**Pause bot** (a bot's menu in the sidebar, under More) and **Pause department** (a department's menu) stop
everything that bot or department is doing and keep it from starting anything new, until you choose **Resume**.
It is the one switch for "stop all effort for now", for example to save what is left of a plan's usage.

## What pausing does

Right away, for every bot it pauses:

- every conversation that is working stops, as Stop does, including the work it handed to other bots and its turn in a room;
- a routine run in progress is cancelled.

Until it is resumed, a paused bot takes no new work:

- a message to it is refused with a line saying it is paused and how to resume it;
- its routines and webhooks don't run: each run that comes due is let go quietly, with the same line in its run log,
  so nothing lands under To review; the routine's card says its bot is paused. A run started by hand fails with the line;
- another bot that tries to hand it work is told it is paused, and not to route around it;
- in a room it is skipped, and the room goes on with its other members;
- the bot API and the headless CLI get `409` with code `bot_held`.

Its conversations, memory, settings and routines are all kept: **Resume** picks up where it left off. A paused bot
shows **Paused** under its name in the sidebar.

A bot is paused by itself, or with its department. One paused with its department is resumed from the department's
menu. A department keeps its pause when it is renamed; a bot moved into a paused department is paused with it.

## Who can pause

The owner of the server, or an admin on a Team Cloud. Each pause and resume is recorded in the admin activity log
(`bot.pause`, `bot.resume`, `department.pause`, `department.resume`).

This is separate from the Starter plan keeping only some bots awake: a bot can be paused for either reason, and is
resumed for each in its own place.

## API

- `GET /api/paused`: `{ bots, departments, heldBots }`, what is paused and every bot that is held because of it.
- `POST /api/paused` with `{ "kind": "bot" | "department", "id": "<bot id or department name>", "paused": true | false }`:
  answers with the new state and `stopped`, how many conversations it stopped.
