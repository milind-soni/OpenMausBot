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

Browser clicks, tool selection and where work runs are listed as "Coming
soon" and have no switch yet.

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
  or `baseUrl`, and only for room routing and the key check (other jobs need
  a key of the person's own). Settings says **Included with Cloud Pro**, and
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
