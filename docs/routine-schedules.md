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
- Existing catch-up policy remains: up to 12 hours late, one missed occurrence
  can be dispatched; older work receives a missed-run receipt. The next date
  advances without replaying every missed minute. Queued/running/waiting work
  for the same cron routine does not accumulate overlapping copies (a run is
  waiting while teammates still owe it results on the job runtime,
  docs/runtime-contract.md §9).
- A run that asks you for an approval or an answer waits for you. Its card and
  the Routines log say what it waits for ("Waiting for your approval to use
  COMPOSIO_SEARCH_TOOLS"), the approval notification names the routine, and the
  time it waits does not count toward its optional run limit, which bounds
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
  - Signed out, out of credit, payment required, a usage limit or an engine
    that needs setting up: no retry. The owner gets one notification per bot
    and cause saying what to do, and no more until one of that bot's runs
    completes. A usage limit that says when it resets (Claude Code does) puts
    the run back for just after the reset, if that is within 12 hours.
  - The log says what happened ("Retried after the engine stalled ·
    Completed"), and each routine shows "N of M runs OK this week".
- Existing one-time, daily/weekday and interval schedules are not migrated or
  reinterpreted. Team exports retain cron expressions and zones; imports remain
  paused until enabled. Older phone apps safely treat cron as a newer schedule;
  use chat or the desktop/web editor for it, rather than converting it to daily.

Cron series are edited through the routine editor rather than calendar dragging,
which could otherwise ambiguously change an entire expression. Dense calendar
projections are bounded per day; Run logs remain the source of actual outcomes.
