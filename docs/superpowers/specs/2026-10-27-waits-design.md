# Waits: "tell me when…" that costs nothing while it waits

Date: 2026-10-27 · Branch: `feat/bot-waits` · Idea source: Atticus "Watch for me" (SaarthurR/atticus-mac, MIT). We take the idea, not the code.

## Why

"Tell me when the build finishes", "watch this page until it says shipped",
"let me know when Coder is done". Today a bot can only do this by staying in a
turn (burning tokens) or by a routine that wakes the AI every 5 minutes or more.
The AI should be needed twice: once to set the wait up, once (optionally) to
act when it fires. In between, plain code checks.

## Goals

- Three bot tools: `wait_until`, `list_waits`, `cancel_wait`.
- A server loop checks each wait's condition with no AI.
- When it fires: a message in the chat where it was asked, an unread badge, a
  notification. If the bot was given a follow-up, the bot continues in that
  same chat with it.
- Waits expire (default 24 h, at most 7 days) and say so when they do.

## Non-goals (v1)

- Arbitrary shell commands as conditions (they would run unattended every few
  seconds).
- Reading windows on the person's screen (needs a computer claim outside a
  turn, which the control gate refuses by design).
- A waits list in the UI. People ask the bot ("what are you waiting for?").
- Phone push (the harness side does not exist yet); phones get the normal
  notification frame and feed.

## Anti-goals

- Any model call between set-up and firing.
- Hammering a website: URL checks are at least 60 s apart, with backoff.
- Reaching private network addresses through URL checks.
- A wait that outlives its bot.

## Naming

"Watch" is taken (`watch.json` is the proactive brief; "Keep an eye on my day"
and the Watcher bot exist). Everything here is "wait".

## Conditions (`kind`)

| kind | fields | check | every |
|---|---|---|---|
| `url_contains` / `url_missing` | `url`, `text` | GET, tags stripped, case-insensitive substring | 60 s, backoff to 15 min on errors |
| `file_exists` / `file_missing` | `path` | stat | 5 s |
| `file_changed` | `path` | size or mtime differs from creation | 5 s |
| `process_running` / `process_gone` | `process` (name, case-insensitive exact; or pid) | process list | 5 s |
| `bot_idle` | `bot` (name or id of another bot) | that bot has no running turn | 5 s |

URL checks: http(s) only. `addressClass` classifies an IP, not a name, so the
check resolves the host itself, refuses private and loopback answers, and
connects to the address it checked (no second lookup). 15 s timeout, 2 MB cap,
no cookies, no redirects to a refused address. Paths accept `~`.

File and process checks look at the machine the server runs on. They are
offered only when that is the bot's own computer: refused for bots working in a
Local VM, VPS or Cloud Boat, in Cloud homes and for Cloud guests. URL and
`bot_idle` work everywhere (my call).

`bot_idle` fires the next time that bot goes from working to idle in any chat
after the wait was made. If it is idle when asked, the wait waits for it to
start and then finish (my call; avoids "already done" before a hand-off
starts).
If a condition is already true when asked, `wait_until` creates nothing and
says so, so the bot answers right away.

## Tools (agents catalog)

`wait_until {label, kind, url?, text?, path?, process?, bot?, then?, hours?}`
(flat schema). `label` is the person's words for it ("the build finishes").
`then` is an optional request the bot runs when it fires. `hours` defaults to
24, max 168. Limits: 10 active waits per bot, 50 total; over the limit the tool
says which waits exist.

`list_waits {}` (read-only): this bot's active waits with label, condition,
created and expiry.

`cancel_wait {id}`: only the bot's own waits.

Listing (after #3773 and #3786, which made the agents tool list smaller): every
turn outside a room lists `wait_until`, with a short description (the kinds,
no AI while waiting, `follow_up`, 1 to 168 hours) and compact schema; its
result explains the rest. `list_waits` and `cancel_wait` act only on the
chat's own waits, so they are listed only while the bot has a wait in this
chat that has not ended (`OMB_ACTIVE_WAITS`, from
`WaitManager.count(botId, threadId)`): the next turn in that chat sees them,
and a wait in another chat lists nothing here. Without one they still answer
a call, directly or through `use_tool`. A room's turn is never listed
`wait_until` or `cancel_wait`, which rooms refuse; since no wait is made in a
room, it is not listed `list_waits` either.

The handler takes bot and chat from the internal capability token (never from
arguments) and stores those, never the token. Waits can be made only from a
direct chat turn the person started, with the same guest and outside-driven
checks `create_trigger` runs; rooms, routine runs and peer asks are refused (my
call).

A wait with `then` is a one-off automation the bot wrote, so it is treated like
one (my call): creating it posts the same kind of visible card a new routine
gets, with Cancel; and the follow-up runs as an automation (outside
provenance, like a routine run) that joins the source chat, the way
`limit_reset` runs continue where the person asked. A prompt-injected `then`
never runs with the person's own authority. Tools sit beside the trigger
tools with the same availability as `create_trigger`. One sentence in the
system prompt's trigger paragraph tells bots to use `wait_until` instead of
staying busy or making a short-interval routine.

## Firing (`server/waits.ts`)

`WaitManager` on the `CalendarCallManager` pattern: `DATA_DIR/waits.json`, mode
0600, zod schema, atomic writes with rollback, a 5 s tick, per-kind intervals,
paused with the other automations during workspace maintenance, removed with
its bot through `bot-automations.ts`. Probes are pure functions in
`server/wait-probes.ts`.

When a wait fires:

1. `appendMessage(sourceThread, {role:"bot", kind:"text", text:"<label>: done.
   <detail>", wait:{id, status:"fired"}})`, `patchTask(unread)`, and
   `notify(buildNotification("wait", …))` (new `NotifyKind`).
2. If `then` is set: queue it as an automation run with event source `wait`
   (`routines.enqueueWebhook`, widened), joining the source chat, with
   `"[Wait finished: <label>] <then>"` as the prompt. Retries, deferral when the
   chat is busy and failure notices come with it.

On expiry: a quiet message "Stopped waiting for <label> after N hours." and no
follow-up.

## Testing

- Probes: each kind against temp files, a spawned process, a local HTTP server
  (with the egress check injected so tests can reach it), a fake bot registry.
- Manager: create/limit/expire/cancel; fire posts once and only once; restart
  keeps waits; bot deletion removes them; URL backoff; maintenance pause.
- Tools: catalog goldens and budgets regenerated; token-scoped ownership
  (another bot cannot cancel); "already true" returns without creating.
- Fixture: the fake engine calls `wait_until file_exists`; touch the file; the
  chat gets the message and the follow-up turn starts.

## Left to the builder

Message and notification copy, the exact process-list command per platform,
route module layout, whether `bot_idle` reads running turns from the event bus
or the turn registry.
