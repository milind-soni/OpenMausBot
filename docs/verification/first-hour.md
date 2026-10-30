# A new Cloud's first hour

What a new personal Cloud's Chief does in its first hour and day
(`server/host/first-hour.ts`), and how to see it without a real Google account,
a model or the Electron app.

## The end-to-end scenario

```sh
pnpm exec vitest run server/first-hour.e2e.test.ts
```

It starts a real Cloud home (`OMB_CLOUD_ROLE=home`) in a temporary home with
the fake Claude CLI, and the connected-apps service from
`server/testing/broker-fake.ts`, which the Cloud registers with by itself as
its plan includes it. The fake CLI answers by a marker in its prompt
(`FAKE_CLAUDE_MARKER_REPLIES`) and makes the Composio calls written in a file
(`FAKE_CLAUDE_TOOL_CALLS_FILE`). Nothing reaches Google, Composio or a model.

Expected:

- The Chief's chat is the first thing: one message, "Hi Sam! I'm MausBot, your
  Chief of Staff. … What do you want off your plate?", the Cloud's welcome steps
  recorded as done (`cloud-welcome-done`) and MausBot's own welcome card off.
- After the first answer, the Chief says why ("So I can see what needs you
  today, connect Gmail and Google Calendar…") and two connection cards follow.
  Its system prompt says it is the person's first day and never to ask for
  Gmail or Calendar itself.
- Gmail connected (the card's own status check): the first look runs as the
  Chief's turn in its chat, its prompt never stored as the person's message.
  Through the relay it reads and writes one reply draft; its send and delete
  are refused, never reach the service, and are in the decision log
  (`read-and-draft`). The card shows Connected, continuing.
- Then, once each: "Every morning at 8 I'll send you a brief of what needs
  you.", and the phone card, whose button opens the app's own pairing
  (`open_phone_pairing`). "Your first look is ready" is in the notifications.
- The brief is on (the one watch routine), and the signed power read never
  lets the home sleep past 7:50 in the person's zone.
- The signed health read carries `firstHour` (each milestone's time since the
  first boot, the apps, `look: delivered`) and `value` (one draft, five
  minutes), and no name, address or subject.

## The pieces

```sh
pnpm exec vitest run server/host/first-hour.test.ts server/host/brief-morning.test.ts server/host/first-hour-words.test.ts server/host/value-ledger.test.ts server/read-and-draft.test.ts
```

- `server/host/first-hour.test.ts`: the greeting in the person's language and by name only
  while unanswered; the offer once, after the first answer or unasked after 90
  seconds; the first look, then the brief line and the phone, each once; a
  decline carries on to the phone with no brief line; a first look that could
  not run says so; the first look's three-draft fence; the push to a phone
  paired after the first look; the day-two recap ("So far I've sorted 40
  emails, drafted 6 replies and prepped 4 meetings: about 2 hours back.") only
  after 8:00 on day two, once, and never when nothing was done.
- `server/host/brief-morning.test.ts`: the brief posted and pushed at 8:00 in the person's
  zone and not a minute before, once a day; its first line from the counts since
  the person was last here, left out when they just were; a running watch run
  waited for up to 20 minutes; the wake ten minutes early, through a clock
  change; nothing where no morning time is set.
- `server/read-and-draft.test.ts`: the first look's relay fence.
