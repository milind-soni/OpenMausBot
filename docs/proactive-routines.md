# Proactive routines

The Chief of Staff keeps an eye on the person's day with one ordinary routine,
"Keep an eye on my day". It is made once, with no button, on a personal install
or Cloud that can reach connected apps, and it is built from four upgrades every
routine can use.
There is no second bot and no separate watcher: the routine engine
(`server/routines.ts`) runs it like any other routine, on the desktop, headless
and on a Cloud.

## What the person sees

- **The brief.** One card a day in a fixed chat of the Chief's, edited in
  place, built with no AI. It exists only once it has something for the person
  (something that needs them, an important email or a meeting today); an empty
  brief is never posted. It opens on the first open of the day and after three
  hours away. Any other moment, it never takes the screen from the chat in use.
  Its first appearance says what it does and that the person can tell the Chief
  to stop or change it. Sections:
  1. **Needs you**: emails waiting on a reply, failed or missed routines,
     meetings that clash, an app that can't be read ("Couldn't read Gmail ·
     Reconnect Gmail in Connected apps"), a signed-out AI, a usage limit, a
     question a bot is waiting on;
  2. **Your day**: today's meetings, with Join for an https meeting link;
  3. **Important emails**: what the watch picked, each with a one-line why,
     **Draft a reply**, **Open in Gmail** and **Dismiss**;
  4. **Routines**: other routines' results today.
- **Meeting prep**: a card in the same chat when a meeting with other people is
  within four hours.
- **The 10-minute reminder**: a card posted by the server, with no AI.
- One notification per update that adds something that needs the person.

Pausing or deleting the routine in Automations is the off switch: with it off
there is no brief at all. Its row says
"reads and drafts only" and "checked … , nothing new".

## The four routine upgrades

1. **Checks before the model.** A routine can name `checks`: `calendar` (the
   next 36 hours), `mail` (new inbox mail since the cursor) and `runs` (other
   routines' finished runs). They are plain code over one connected-apps
   session per tick, as the default account of each app, and only for apps the
   bot's own app switches let it read. Nothing new starts no turn and leaves no
   run, only "checked at". Reminders, clashes and Your day need no AI. Email
   triage and meeting prep go to **one** batched run, each item in a records
   block. The cursor moves only once that run's answer is kept, and items are
   deduplicated by id. A failed or misshapen read is never "nothing new": it
   keeps the cursor, backs off and shows its trouble.
2. **Nothing to report, structured.** A routine that delivers to the brief
   answers with one small JSON object: `{"quiet": true}`, or important emails
   and preps by item id. The server reads it. An answer it cannot read fails the
   run and is never posted, and its items wait for the next check. Every other
   routine keeps the NOTHING NEW convention in `server/automation-reports.ts`.
3. **Read-and-draft runs** (`access: "read-and-draft"`), in
   `server/read-and-draft.ts`. Everything is allow-only:
   - the run runs at Ask, and the server refuses every request in it outright,
     never as a card;
   - its OpenMausBot routes are conversation reads, its own results, the
     engine's hooks and the connected-apps relay;
   - through the relay it reads Gmail and Google Calendar, and may write one
     draft per thread, replying to that thread's sender, in a thread its checks
     handed it;
   - Gmail's and Calendar's answers reach it as records;
   - no web search, browser, computer, phone or other tools; no memory, recent
     work, team notes or skills in its prompt; nothing captured into memory;
   - its conversation stays out of recall, recent work, `list_threads` and Chief
     notices.

   The model work needs an engine whose every tool use reaches OpenMausBot's
   answerer (Claude today). On any other engine the watch sorts no email and
   prepares no meeting, says so in the brief, and still does what needs no AI.
4. **Deliver to the brief** (`deliver: "brief"`): results become brief rows,
   not chat lines of their own.

## Reliability, for every routine with checks

- **Overlap.** While a run works, checks still run (reminders stay on time), but
  hand the AI nothing until it ends.
- **Catch-up.** However late the computer wakes, missed checks merge into one,
  never a missed run.
- **Backoff.** After a failed run the next waits 15 minutes, doubled each time,
  at most 4 hours, with jitter. The owner hears once per failure streak.
- **Busy.** A run of checked items waits for a busy bot without a notice and
  never fails for being busy.
- **Throttle.** At most 24 AI runs in any 24 hours; then items wait.
- **Boot.** The first checks wait two minutes after start.
- **Wake.** Only the checks' next on-time job (a reminder, a prep) keeps the
  desktop awake or wakes a sleeping Cloud. Plain mail checks run whenever the
  machine is awake anyway.
- Every other routine keeps main's rules: one quick automatic retry, usage
  limits waited out, one notice per owner cause.

## State and privacy

- `routine-checks.json`: per routine, cursors, judged ids, meetings prepped and
  reminded, and the items a run holds. Ids and times only.
- `brief.json`: the brief's home chat and today's card, presence, the zone of
  record (from the person's device, so a Cloud is not stuck on UTC), the
  important rows by id, and recent dismissals with the sender's address. The
  senders and subjects it shows are read back from Gmail by id after a restart.
- `watch.json`: that the default routine was made, so it is never made again.
- A card the server built carries `serverCard`. A bot can't edit it, and it
  replays into a turn only as records. Dismiss works only for the owner or an
  admin, only on the brief, checks thread ownership before reading a widget, and
  starts no turn. Recent dismissals go into the next triage as records.
- A hosted team workspace or Team Cloud gets no watch and no brief. Presence is
  recorded for the owner only.
- An install that can't reach connected apps gets no watch, and so no brief,
  until it can. It checks once a minute, since a Cloud's access arrives after
  start. A scripted test install without the fake connected-apps service
  behaves as before.
- Routines carry `checks`, `access` and `deliver` through Cloud moves and team
  backups. The move freeze pauses the watch like any routine, so two homes never
  watch the same inbox.

## Not in v1

- More than one account per app.
- Phone push when the app is closed (there is no caller of the push relay yet).
- Quiet hours.
- A sweep of old run conversations.
- A run against a real Google account: the Composio slugs and answer shapes
  follow its documentation and the fixtures in `server/testing/fixtures/`.
