# Decision model

OpenMausBot can use a fast decision model to pick things for your bots. It
answers in a few hundred milliseconds for a fraction of a cent. It never does
the work: the chosen bot still runs its own turn on its own engine. The first
supported model is TypeSafe's [Jev](https://typesafe.ai).

Everything is in **Settings → Decision model**: one master switch, the Jev key
with **Save** and **Test**, and one switch per job it can do.

## What it decides today

**Who answers in rooms.** A room whose responder is set to **Auto (Jev)** asks
Jev who should answer each message that @mentions nobody. The question offers
the room's active bots, each described by name, title and description, plus
"several members". The state it reads is the room's name, its people, the last
room lines (the same window room turns use, clipped in size) and the new
message.

- If one bot comes back with a probability of at least 0.6, only that bot
  answers.
- If "several members" comes back at 0.6 or above, every member answers.
- Anything less sure goes to the room's fallback: the lead it had before it
  became Auto, or else its first member. That is what a lead-mode room does
  today.

@mentions, `@everyone`, team goals and the other responder modes never ask
Jev. The message is appended and the send returns straight away; the answer
is awaited only when the room's turn starts, within 1.5 seconds.

A reply whose speaker Jev picked shows a small line under it: *Picked by
Jev · 94%*.

New rooms start on Auto while the decider and its room job are on. Existing
rooms keep their mode. With Jev off, an Auto room shows a one-line hint and
answers like lead mode.

**Which memories come back** (on by default). Before a turn, automatic recall
finds passages from the bot's memory files and, in a 1:1 chat, its other
conversations by keyword. With this job on, Jev reads the message and every
candidate (up to 24, in one request) and says, for each, how likely it is to
help answer the message.

- The likeliest passages come first, and any below 0.15 are left out: an
  unrelated note in front of a message is noise. The usual caps (four notes,
  four conversation passages) then apply as before.
- A memory topic the message names directly is always kept and never asked
  about.
- When the bot calls `session_search` itself, Jev only reorders the results;
  nothing is dropped, because the bot asked.
- No answer within 1.2 seconds, or any failure: the keyword order, exactly as
  without Jev.

**Which skills fit** (off by default). With this job on, the system prompt
lists the bot's enabled skills by name only, the same text every turn so the
engine's prompt cache keeps working. Jev reads the message and each skill's
name and description and says which could help. The full entries (description
and `SKILL.md` path) of the skills at 0.3 or above, at most eight, likeliest
first, go in front of the message, where recalled passages go. The bot can
still use any listed skill by name. If Jev does not answer within 1.2 seconds
or fails, the full skills index goes in front of the message instead, so the
bot never has less than it had before. With the job off, the system prompt
carries the full index exactly as before.

**Did a routine really finish.** On by default. When a routine's turn ends
without an error, Jev reads the routine's name and instructions (clipped to
about 1,500 characters) and the bot's final reply (the last 6,000
characters, where the conclusion is) and says whether the reply reports the
task done, not done, or nothing to do. The "finished" notification waits for
the answer, at most 5 seconds.

- If "not done" comes back with a probability of at least 0.75, the
  notification says the routine **needs attention** instead of "finished",
  and the run shows **Needs attention** in the routine's history and on its
  card in the results thread.
- The run still counts as completed: it is not retried, not marked failed and
  does not add to the routine's failure streak.
- Anything else, a lower probability or no answer in time sends the usual
  "finished" notification.

**Correction or new request.** Off until switched on. When you send a
message while a bot is busy, Jev reads the thread's title with the message
that started the running turn (about 1,500 characters) and your new message
(about 2,000 characters) and says whether the new message is about the
running task or a separate request. It has 800 ms, because you are waiting
on the send.

- If "separate" comes back with a probability of at least 0.8, the message
  is not steered into the running turn. It waits above the composer as
  *Queued as a separate request* and runs as its own turn when the current
  one finishes. It never merges with the messages queued before or after it.
- Anything else, and any failure, steers or queues the message exactly as
  before.
- Messages to one busy thread are decided one at a time, so they keep the
  order you sent them in.

**Risky actions under Full access** (switch: **Check risky actions**, on by default).
Before Full access approves a permission request for you, Jev scores how
risky it is to run unchecked: Low, Medium or High. It reads the tool, its
one-line summary, the exact command and the tool's input (each clipped to
about 2,000 characters) and the conversation's title.

- If High comes back at 0.6 or above, the approval is not sent. The card
  stays open for you with the note *Held for you: this looks risky, so Full
  access did not approve it automatically*, you get the usual approval
  notification, and the decision log records the card with source
  `decider-risk`.
- Anything less sure, any failure, and a timeout (1.5 seconds) approve
  exactly as Full access always has.

It can only turn an automatic approval into a question for you. It never
approves anything, never touches a card you would have been asked about
anyway, and never second-guesses a command you saved as always allowed. The
built-in read-only team tools (listing bots, rooms, threads and the like)
are never asked about.

**Is the bot stuck?** (switch: **Spot stuck bots**, on by default). When a bot
repeats the same call five times in one turn, the chat already shows a
"Same call repeated" line. The first time that happens in a turn, Jev is
asked whether the bot is actually going in circles, reading what you last
asked and the bot's last 12 tool steps (each clipped to 300 characters).

- If yes comes back at 0.8 or above, a plainer line follows (*Scout looks
  stuck: repeating the same steps. Stop it or give it a hint.*) and a "looks
  stuck" notification goes out, once per turn at most.
- Anything less sure, any failure, and a timeout (5 seconds) leave only the
  usual repeat line.

It only reports. The turn keeps running until you stop it or send a hint.

**Quiet "finished" notifications** (switch: **Quiet notifications**, on by
default). Before a "finished" or "resumed with results" notification goes
out, Jev is asked whether you need to see it soon. It reads the
notification's kind, bot, title and body (clipped to 1,000 characters).

- If "later" comes back at 0.7 or above, the notification still arrives,
  but without a sound, on the desktop app, iPhone and Android.
- Anything less sure, any failure, and a timeout (1.5 seconds) send it as
  today. The notification waits at most that long.

Approvals, questions, take-over requests, failures, spend notices and "looks
stuck" are never asked about and always arrive as before. Nothing here makes
a notification louder: a computer with notification sounds turned off stays
silent.

Browser clicks, tool selection and where work runs are listed as "Coming
soon" and have no switch yet.

The three jobs below change what a bot sees or does, so each starts off
until someone switches it on in **Settings → Decision model**. With the
switch off they cost nothing: no request is built.

**Fewer connected-app tools.** On the API engines that list their own tools
(Grok, Mistral, MiniMax and OpenAI-compatible), a turn whose connected-app
and custom MCP tools number more than 20 asks Jev, once per tool, whether
the message might need it. Each tool is described as "name: description"
(about 200 characters) beside the message (about 1,500).

- A tool is kept at a probability of at least 0.2, and the 5 most likely
  are always kept. The rest are not offered this turn, and a call to one is
  refused like any unknown tool.
- OpenMausBot's own tools (teammates, the computer, the browser, questions
  to you) and Composio's search, execute and connection tools are never
  asked about and never withheld.
- Past 120 tools (the most one request may carry), the first 120 are asked
  about and the rest are kept.
- Claude, Codex, ACP and Pi engines are not trimmed: they reach connected
  apps through Composio's search-and-execute tools rather than one tool per
  action, and listing the per-app tools there would cost a network round
  trip before every turn.

The question waits for the tool list, so it runs when the engine has
started its tool servers, within 1.5 seconds. Any failure keeps every tool.

**Where work runs.** For a bot whose Works on is Auto, in a conversation
that is not pinned to a place, a message you send asks Jev which place
fits it, choosing only among the places Auto could reach right now: this
computer, a Local VM this bot already has, and the cloud computer (a Boat
or VPS that is set up). It is asked only when at least two of them are
there. The state is the message (about 1,500 characters) and the bot's
name and description (about 400).

- At a probability of at least 0.7, that place is tried first this turn,
  through the same Auto mount as always, so its first screen use pins the
  conversation just as an Auto turn does today. A place that does not
  attach leaves the usual order to run.
- Anything less sure keeps the usual Auto order.
- A pin (yours or an earlier Auto turn's), a bot's own Works on, a team
  computer, rooms, routines, webhooks and messages from other bots never
  ask.

The question starts with the turn and is awaited just before the computer
is mounted, within 1.2 seconds.

**Lighter model for easy messages.** In a bot's own conversation, a message
asks Jev how much work it needs: Light, Moderate or Heavy. The state is the
message (about 2,000 characters) and the last four lines before it (about
300 each). It is asked only where the engine has a lighter model and can
switch models within a conversation:

| Engine | Lighter model | Moved off |
| --- | --- | --- |
| Claude | Claude Haiku 4.5 | Fable, Opus and Sonnet models |
| Grok (API) | Grok 4 Fast | Grok 4.7, Grok 4 |
| Mistral | Mistral Small | Mistral Large |

The lighter model must be in that engine's model list, the bot must be on
one of the listed models (a custom, local or managed model is never
swapped), and the conversation must fill at most half the lighter model's
window.

- If Light comes back at 0.8 or above, that one turn runs on the lighter
  model with the engine's default effort. The bot's saved model does not
  change, and the conversation carries on (Claude resumes the same
  session). The reply shows *Light model · easy message*.
- Anything less sure, and any failure, runs the bot's own model.
- Codex and ACP engines cannot switch models inside a conversation and are
  never asked. Rooms, routines and webhooks are not asked either.

The question starts with the turn and is awaited just before the engine is
called, within a second, so it overlaps the rest of the turn's setup.

**Click by description.** With **Click by description** switched on (it
starts off), bots using the built-in browser get one more tool,
`agent_browser_click_text`. A bot names what to click in words ("the blue
Sign in button", "the Remember me checkbox") instead of reading a snapshot
and picking a ref. The tool takes a snapshot of the page, offers Jev up to
255 of its clickable elements (buttons, links, fields, checkboxes and so on,
each described by its role, label and the section it sits in), and sends
only the words and the page's address and title as the state.

Jev is also offered "none of these": a target that matches nothing on
the page, or is too vague to tell ("the thing"), clicks nothing however sure
Jev is, and the bot gets the likeliest candidates instead.

- If one element comes back with a probability of at least 0.6, it is
  clicked, and the bot is told what: *Clicked button "Sign in" (Jev 92%)*.
- Anything less sure, and any failure at all, clicks nothing. The bot gets a
  short list of the closest elements with their refs and clicks one itself,
  as it would without Jev.

With the switch off, or no key, the tool is not offered at all. A person
taking over the browser while Jev decides stops the click.

Tool selection and where work runs are not wired yet.

## It fails open

The decision model never blocks or delays a turn beyond its short budget.
With no key, the switch off, the job off, a timeout, a network error, an HTTP
error (401, 429, 529, 5xx), or an answer that does not check out (a choice
that was not offered, a probability that is not a number), the room does
exactly what it would have done without it. Every answer is validated before
it is used.

## What is logged

Each call that reaches the model adds one row to
`~/.openmausbot/decider-log/YYYY-MM.ndjson` (mode 0600). This is separate
from the approvals log in `decisions/`.

```json
{"at":"…","seam":"roomRouting","provider":"jev","ok":true,"choice":"<bot id>","pTop":0.94,"margin":0.9,"latencyMs":341,"inputTokens":712,"stateHash":"3f1c…"}
```

A row never holds the message text, the bots' descriptions or the key; a
16-character hash of the state is enough to spot repeats. Failed calls record
the reason (`timeout`, `overloaded`, …) and the HTTP status. Month files are
kept for the approvals log's retention window (180 days by default).
The log stays on this machine: workspace backups leave it out.

## Where the key lives

- **Desktop app:** in the operating system's encrypted store
  (`credentials.bin`), like the other workspace keys. The server receives it
  as `OMB_JEV_API_KEY` at start-up; `config.json` keeps only an empty
  placeholder.
- **Server or browser use:** in the server's own `config.json` (mode 0600),
  under `decider.key`. `OMB_JEV_API_KEY` overrides it.
- **Cloud Pro:** decisions are included, with no key to paste. With no key of
  the person's own, the Cloud home uses its relay token
  (`OMB_CLOUD_DECIDER_TOKEN`), sent only to the Admin's relay, never to Jev
  or `baseUrl`, and only for requests that match a job's fixed contract
  (room routing, the key check, and each job in `server/decider/jobs.ts`). Settings says **Included with Cloud Pro**, and
  the master switch is on until someone switches it off. A key saved here
  always wins; clearing it falls back to the included decisions. See
  [cloud-pro.md](cloud-pro.md), "Included Boat computers, voice and
  decisions".

The key is write-only: `GET /api/config` reports only whether one is saved
and which switches are on. Engines never inherit it, and diagnostics exports
mask it. Saving a key makes one tiny test call; a key Jev rejects is not
saved. The **Test** button makes the same call on demand. A room decision
costs about $0.00003; the test call costs less.

## Turning it off

Switch off **Use Jev for fast decisions**, or clear the key (on Cloud Pro,
clearing a key falls back to the included decisions: switch off to stop
them). To keep Jev on but stop room routing, switch off **Who answers in
rooms**. To stop one room asking, set its responder to a lead, **Everyone
responds** or **Only when mentioned**.

## Configuration reference

```json
"decider": {
  "enabled": true,
  "provider": "jev",
  "key": "",
  "baseUrl": "https://api.typesafe.ai",
  "jobs": { "roomRouting": true }
}
```

`baseUrl` points at a Jev-compatible server instead of TypeSafe's. It has no
Settings UI. It must be https, or http to this machine only. Requests go to
`{baseUrl}/v1/systemone` with model `jev-latest`.

## Measuring it

`server/decider/room-routing.eval.test.ts` replays 53 labelled room messages
(`server/decider/fixtures/room-routing.json`) against the live model. It is
skipped unless `OMB_JEV_LIVE_EVAL=1` is set with a key, and costs about
$0.002 per run.
