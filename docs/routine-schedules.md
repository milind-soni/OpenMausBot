# Routine schedules

Ask a bot in ordinary language, for example:

> Prepare a report at 9 am on the first of every month, in Asia/Kolkata.

The bot turns calendar timing into a cron expression, and OpenMausBot validates
it. The change applies at once; its card shows the rule, its timezone and the
next three dates, with Edit, Pause and Undo. The scheduler wakes the bot at the
matching time; no model runs in the background to check the date.

A routine can also name **checks** (calendar, mail, other routines' runs): plain
code that runs on each tick before any AI turn, so a quiet tick costs nothing.
See [Proactive routines](proactive-routines.md).

In **Automations → Schedule**, choose **Monthly**, **Yearly**, or **Custom cron
(advanced)** in the existing routine editor. Monthly offers days 1–31 and
**Last day**. The timezone defaults to your browser's zone for a new preset and
can be changed. Saved cron routines retain their own zone even on another
computer. Editing just a title or instructions preserves the exact schedule.

## Check back later

For "check CI in 5 minutes", "check the payroll export reached the bank at 4 pm"
or "chase the client Friday if they haven't replied", a bot uses `check_back`
instead of a routine. It takes `when` ("in 2 hours", "Friday 9am",
"tomorrow 16:00" in the person's zone, or an exact time with its offset),
`note` (what to check) and an optional `if`. A day and a time are read in the
person's zone: the computer's on a desktop, the one the person's app gave on a
Cloud. A Team Cloud has one zone for everyone (the one its owner's app gave),
so a member elsewhere is best served by a span or a time with its offset; the
bot's answer names the zone and the exact time it set. At that time the same bot takes an
ordinary turn in the same conversation with the note, checks, and carries on.
It counts as a normal turn for usage. Nobody is asked to approve anything:
the conversation shows one quiet line ("Will check back Fri 9:00 · Cancel"),
which becomes "Checked back Fri 9:00" once it runs. Cancel is optional.

- **Who may set one:** a turn the person's own request started in their
  one-to-one chat with the bot, or a check-back's own turn (so it can look again
  later). A room, work another bot handed on, a routine, an outside event and a
  Cloud guest get a one-line refusal, and the bot finishes in its turn.
- **Limits:** at least a minute and at most 90 days ahead; 10 waiting per
  conversation and 50 per bot. Over a limit the bot is told why in one line.
- **Reliable:** each check-back is kept in `check-backs.json`. The desktop runs
  them only while OpenMausBot is running; a check-back that came due while the
  computer slept or the app was closed runs once, late, when it is back, and
  its turn says it is late. A Cloud wakes for the next one. One that was being
  started when the server stopped is closed with a line, never started twice.
  A paused bot is waited out; any other refused start is tried again each
  minute for an hour, then its line says it couldn't check back.
- **Gone with what it belongs to:** a check-back whose conversation or bot is
  deleted is dropped. On a Team Cloud it belongs to the conversation's audience:
  one set in a member's private chat runs for that member's request (the asker
  owns the run) and stays in that chat; when they leave the team their private
  chats, and so their check-backs, go.

## Off, on, and done

The switch on **Automations** pauses a schedule or a webhook and turns it back
on; a schedule comes back with its next time. If the server refuses, the reason
shows beside the switch. A one-time schedule whose time has passed reads
**Done** and has no switch: turning it on would have nothing to do, so the
server refuses it ("Its time has passed. Edit it to pick a new time."). Saving
it with a new time turns it back on.

Deleting a bot deletes its schedules and webhooks too, and their runs. A
webhook's address stops working at once. Automations left behind by a bot
deleted in an earlier version are removed the next time OpenMausBot starts, and
never run meanwhile.

## Advanced cron

Cron uses five fields: **minute hour day-of-month month day-of-week**.
An explicit IANA timezone such as `America/New_York`, `Asia/Kolkata`, or `UTC`
is required. Examples:

| Timing | Expression |
| --- | --- |
| First of each month at 09:00 | `0 9 1 * *` |
| Last day of each month at 09:00 | `0 9 L * *` |
| Second Monday of each month at 09:00 | `0 9 * * MON#2` |
| January 1 at 09:00 each year | `0 9 1 1 *` |
| Weekdays at 09:00 and 17:00 | `0 9,17 * * MON-FRI` |
| Every 15 minutes during weekday working hours | `*/15 9-16 * * MON-FRI` |

The app uses [Croner](https://github.com/Hexagon/croner) to calculate dates,
shared by the server and preview. It does not create a second timer service.
Lists, ranges, steps, `L`, `W`, and `#` follow that library's calendar semantics.
As with standard cron, restricting both day-of-month and day-of-week means
**either** field may match; leave one as `*` when you intend just the other.
Seconds, year fields, macros such as `@reboot`, shell commands, and arbitrary
code are not accepted. The finest resolution is one minute.

For elapsed-time repetition such as **every 90 minutes**, use the existing
interval schedule. Cron fields describe calendar positions: `*/90` in the
minutes field does not mean every 90 elapsed minutes. Holidays, external events,
and conditions such as "after a payment arrives" are not calendar expressions;
use an appropriate event/webhook workflow instead of a fake weekly schedule.

## Dates, clock changes and downtime

- Dates that do not exist are skipped: the 31st skips shorter months and
  February 29 runs in leap years. **Last day** handles every month.
- Daylight-saving gaps move the chosen wall-clock time forward through the
  gap. During a repeated hour, a matching clock time runs once, at its first
  occurrence. The preview uses the same calculation as execution.
- Routine execution defaults to **Bot’s current setup**: its selected model and
  configured computer, including a self-hosted VPS. No Boat key is needed for
  that VPS. **Boat cloud computer** is a separate, explicit choice: the bot's
  own model works on its Boat. The agent tools call these `run_on: "maus"` and
  `run_on: "box"`; legacy stored `runOn: "cloud"` still means Boat and is not
  migrated to a different runner.
- OpenMausBot must be running to dispatch routines, including cloud-targeted
  routines. There is no external always-on scheduling service: the schedule
  runs inside the app on your computer — it is not Grok's or anyone's cloud —
  so a sleeping computer or a quit app runs nothing, and the app cannot wake
  a sleeping Mac. The desktop app does the one thing it can: while plugged
  in, it keeps the computer from idle-sleeping for the hour before a due
  routine and while one runs (Automations → *Keep this computer awake for
  routines*, on by default; a closed lid still sleeps). For true 24/7, run
  OpenMausBot on a VPS — see [deploy-vps.md](deploy-vps.md).
- Catching up after downtime (the app closed, the computer asleep, a Cloud
  home off or restarting): for each routine, the newest occurrence that came
  due meanwhile runs late, if it is no more than 12 hours past its time, and
  the ones before it close on one **Missed** row that counts them and says why
  ("Missed 3 scheduled runs because this computer was asleep or OpenMausBot
  was not running"; on a Cloud, "because this Cloud was asleep or
  restarting"). That row is shown as already seen: the newest one is running,
  so it asks nothing of you. When even the newest is more than 12 hours old,
  nothing runs: all of them close on one Missed row that you are told about.
  The next date advances without replaying every missed minute. Routines found
  late in the same pass start 15 seconds apart (at most 40 steps, then again
  from the first), so a long downtime does not start them all in one second.
  A "when my limit resets" routine runs however late it is found. When the
  scheduler itself got to a routine late because it was waiting on another
  run's start (a pass ended after the run came due), the row says that
  instead ("…because the scheduler was held up starting another run") and the
  occurrences passed over are not counted as missed in the health report.
  Queued/running/waiting work for the same cron routine does not accumulate
  overlapping copies (a run is waiting while teammates still owe it results on
  the job runtime, docs/runtime-contract.md §9).
- **The occurrence ledger.** Beside `routines.json` the scheduler keeps
  `routines.ledger.jsonl`: one record per scheduled occurrence of each routine,
  keyed by the routine's id and the scheduled-for time. A record says how the
  occurrence ended (`ran`, `failed`, `missed` or `skipped`, or that it is
  `queued` or `running`), a fixed word for why, how often it started, when its
  first start was, and which run rows it produced. It holds ids, times, counts
  and fixed words only: never a name, a prompt or an output. The run rows stay
  in `routines.json`, and a row and its routine's next time are still saved in
  one write; the ledger is worked out from the rows at every save.
  - **Each occurrence starts once.** Before the scheduler makes a row for an
    occurrence it asks the ledger whether that occurrence already has a
    record; one that has is not made again, whatever brought it back (a
    `routines.json` put back from a copy, a clock set back, an edit made while
    the clock was wrong, a second process on the same files). A start is
    appended to the ledger and flushed to disk before its turn begins. A retry
    is a further start of the same record, counted on it.
  - **A ledger that cannot be written never stops a schedule.** A write that
    fails is logged once and made again with the next save; it fails neither
    the save nor any other run. A scheduled start waits at most three
    scheduler passes for the ledger; after that it starts without a record,
    and so does every later one until the ledger can be written again, with
    `routines.json` alone keeping a run from starting twice, as before there
    was a ledger. Meanwhile the health report says `unreadable: true`. A run
    someone started by hand never waits for the ledger.
  - **A clock that was ahead.** A row closed without starting says nothing
    about a time that has not come: a record reaching past now is cut back to
    now when that is seen, and cut again to just before an occurrence that
    comes due inside it, so every occurrence after the clock is put right is
    made and run. A record of a run that did start keeps its time.
  - **Leases.** A started occurrence's record carries a lease naming the
    machine and process that run it, renewed every minute for three, and given
    up at a clean shutdown. A process that starts on the same machine takes a
    cut run over at once (only one server holds a data folder). One that
    starts on another machine, a copy of the disk, waits until the lease has
    lapsed before it starts that run again.
  - **A restore from a backup.** A small file, `routines.ledger.mark`, keeps
    the ledger's sequence number and the time of its last change. A ledger
    with a lower number than the mark was brought back from a backup: every
    occurrence up to the mark's time already had its turn, so runs the backup
    held unfinished are let go ("Not run again: this schedule was restored
    from a backup…") and the occurrences up to then close on one counted row
    per routine; what came due after that is caught up as after any downtime.
    When a whole disk is restored, mark included, there is nothing to tell it
    by, and the catch-up rule above applies.
  - **Size.** The file is appended to and rewritten whole, through a temporary
    file and a rename, once it holds 500 more lines than records. Records that
    have ended are all kept for 48 hours; after that each routine keeps its
    200 newest for 90 days, and the file never holds more than 10,000. A
    record that has not ended is never dropped. A torn last line (a crash in
    the middle of an append) is dropped at the next start and the rest kept;
    a ledger that is lost, or left empty, is made again from the run rows,
    and its sequence number carries on from the mark; neither is taken for a
    restore.
  - **Earlier versions.** A version from before the ledger reads and writes
    `routines.json` as it always did and ignores the two new files, so going
    back loses no routine and no run row. Coming forward again, the ledger
    takes in the rows that version made. At the first start with the ledger,
    it is made from the run rows already saved; none is moved or dropped.
  - `GET /api/routines?history=<routine id>` adds `occurrences`: that
    routine's records, newest first, for a routine the asker may see.
- The run rows in `routines.json` are still capped at 2,000. When the cap is
  reached, the row dropped is the oldest ended one of the routine that holds
  the most ended rows, so a routine that runs every five minutes uses up its
  own history and not the others'.
- **A run whose turn is gone.** A run that shows as running while its
  conversation has had no turn of its own for five minutes of scheduler
  passes, and has sent no event in that time, is treated like a run that
  failed: it starts once more ("Starting again shortly after a failure: its
  turn ended without reporting back"), and a second loss fails it. A run that
  waits on you or on work it handed on is never taken for lost, nor is a room
  goal's run, nor one whose turn is parked waiting for a computer another
  conversation holds: that turn resumes by itself when the computer is free. The five minutes are added up a pass at a time, so the hours a
  computer slept are not in them.
- Every occurrence that does not run leaves a **Missed** row with its reason in
  the routine's log. Occurrences skipped behind the same earlier run share one
  row, which counts them ("Skipped 12 scheduled runs because the previous run
  of this routine is still running") and keeps the first and the last time, so
  a schedule every minute behind a long run adds one row. Such a row is shown
  as already seen and is never the routine's "latest run", a failure in a row,
  or one of its "N of M runs OK": it asks nothing of you. A run that has waited
  on you for 30 minutes when an occurrence is skipped behind it is the
  exception: you are told once, and that row shows under To review.
- Failures never turn a routine off. When a routine's cloud desktop does not
  start three runs in a row, the routine stays on and its scheduled runs are
  spaced out instead: the next one starts no sooner than an hour after the
  third failure, and four hours after each later one, because every such run
  spends the bot's AI for minutes before it fails. You are told once, the list
  says "Its cloud desktop did not start N runs in a row", and the occurrences
  held back share one Missed row. While it is spaced, the routine's next due
  time (what wakes a sleeping Cloud, keeps a desktop awake, and holds back a
  restart) is the first occurrence after the spacing, not one it will skip.
  The first run whose cloud desktop starts, **Run now**, or any change to the
  routine ends the spacing.
- A routine that an earlier version turned off after three such failures is
  turned back on, once per installation, at the first start of a version with
  this rule, when it can be told apart from one you turned off: it is off
  without a hold, its three newest results are that failure, the third ended
  within the last 30 days, and the routine has not been changed since that
  moment. Its bot says so in one quiet line in its own chat ("Turned back on:
  …"), with nothing to answer. One you edited after it was turned off, one
  that a workspace restore brought back (a restore leaves every routine off
  and counts as a change), one switched off longer ago, or one whose failed
  runs are no longer in the log, stays off: turn it on in the list. A copy
  frozen by a move to another home turns nothing back on until the freeze
  lifts.
- A run stops when it reaches its limit, ends as failed with the limit named
  ("Stopped: this run ran longer than the 3-hour limit"), and the schedule
  carries on. A routine may set its own limit, 5 minutes to 24 hours: that one
  counts the time since the run started, less the time its approvals and
  questions were open. Without one, the default applies to every run, whether
  the schedule, an event or **Run now** started it: 3 hours of work for a
  bot's run, 12 hours for a room goal's run (which stays running across every
  member's turn). Work is the time the run spent running since its current
  start: the time it is queued (behind a busy bot, for its one retry, for a
  usage limit's reset) and the time it waits (on your approval or answer, on a
  conversation left with you, on work it handed to teammates) is not in it.
  It is added up a minute at a time while the app runs, so the hours a
  computer slept, or a clock that was changed, are not in it either.
- A scheduled run queued behind its busy bot for an hour ends as Missed ("Did
  not run: the bot was busy for more than 60 minutes"), and the next
  occurrence starts as usual. Only the time it was seen waiting counts, not
  the time the computer slept or the app was closed, and the count starts
  again if the run starts and is queued once more. A run an event or **Run
  now** started has no next occurrence and waits as long as it takes; so does
  a run waiting behind its own routine's earlier run (overlap **queue**).
- Stopping a run's turn is given 10 seconds. If the AI has not confirmed the
  stop by then, the scheduler goes on with the other routines, but starts no
  new run of that routine until the stop is confirmed or 5 minutes have
  passed, so two runs of one routine never work side by side. The stop is sent
  again each minute, and the stopped run's row says so; a stop that was never
  confirmed stays written on it.
- `routines.json` is written through a temporary file and a rename. If it
  cannot be read, nothing in it is overwritten: no routine runs, changes are
  refused, the Automations list says so, a copy of the file is kept beside it
  (`routines.json.unreadable-…`, one per content, five at most), and the file is
  read again every minute. Once it can be read, the desktop app and a
  self-hosted server load it and do again what start does with routines
  (phone adoption, run-on-startup, the quiet lines above); a Cloud home
  restarts itself instead, because who owns its routines is settled only at
  start.
- A run that asks you for an approval or an answer waits for you. Its card and
  the Routines log say what it waits for ("Waiting for your approval to use
  COMPOSIO_SEARCH_TOOLS"), the approval notification names the routine, and the
  time it waits does not count toward its run limit, which bounds
  active work only. If the engine's own wait for an approval runs out with
  nobody's answer, the run stops with "Stopped: nobody answered the approval to
  use …" and the routine-failed notification. A run still waiting when its
  routine's next occurrence is due gives way to that occurrence.
- An unattended run (scheduled, webhook or Run now) recovers from a passing
  failure by itself, the same on the desktop, a headless server and a Cloud
  home (`server/routine-recovery.ts`):
  - Its engine stalled, OpenMausBot restarted while it ran, the provider
    rate-limited it, or the provider failed for a moment: it starts once more
    in the same conversation after a short wait (15 s; a minute after a rate
    limit), told to check what its first start already did. A second failure
    fails it: "Failed after one automatic retry: …".
  - A run that a shutdown or crash cut off is picked up once when OpenMausBot
    starts again; the same run, never a copy.
  - Its bot or conversation was busy when it started: it waits there,
    checking every 30 s, for up to an hour.
  - A usage limit with a chosen backup AI that can carry on, or a signed-out AI with a
    backup AI of the bot's own (or the app-wide one while Automatic recovery is
    on): the run starts again on that AI after a short wait (see "When an engine runs out" and "When an engine is signed
    out" in self-hosting.md), and the owner hears once that the bot is using it.
  - Signed out, out of credit, payment required, a usage limit nothing can carry
    on from, or an engine that needs setting up: no retry. The owner gets one
    notification per bot and cause saying what to do, and no more until one of
    that bot's runs completes. A usage limit that says when it resets (Claude
    Code does) puts the run back for just after the reset, if that is within
    12 hours.
  - The log says what happened ("Retried after the engine stalled ·
    Completed"), and each routine shows "N of M runs OK this week".
- Existing one-time, daily/weekday and interval schedules are not migrated or
  reinterpreted. Team exports retain cron expressions and zones; imports remain
  paused until enabled. Older phone apps safely treat cron as a newer schedule;
  use chat or the desktop/web editor for it, rather than converting it to daily.

Cron series are edited through the routine editor rather than calendar dragging,
which could otherwise ambiguously change an entire expression. Dense calendar
projections are bounded per day; Run logs remain the source of actual outcomes.
