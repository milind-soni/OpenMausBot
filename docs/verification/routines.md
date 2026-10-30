# Routines

## Monthly and custom cron

See [schedule behavior and examples](../routine-schedules.md). In the isolated
renderer below, create a monthly routine for day 1 at 09:00 in Asia/Kolkata.
Check that the next three dates are all on the 1st, then save, reload and edit
the title without changing its expression or zone. Switch to Custom cron and
try `0 9 31 2 *`: the inline error must disable Save and leave the stored rule
untouched. Check `0 9 L * *` and `0 9 * * MON#2` for real month-end/nth-weekday
previews. Calendar calls deliberately retain their existing scheduling choices.

The automated cron tool fixture calls the real MCP proxy through a disposable
server, confirms the resulting card, and verifies list/update/pause/resume,
persisted timing and HTTP 400 validation failures. It scripts the tool call;
it does not measure a real model's natural-language-to-cron accuracy.

It also retries an existing schedule under a different name through the real
tool, checking that the response identifies the existing routine and creates
neither a second approval card nor a second schedule. The proposal-service
tests cover competing confirmations, Full Access, per-bot ownership, explicit
interval starts, meaningful punctuation and differing execution settings.
This guard only applies to agent creation proposals; intentional duplicates
in the manual editor remain possible. Existing routines are never removed.

```sh
pnpm exec vitest run shared/routine-schedule.test.ts server/routine-cron.e2e.test.ts server/routine-requests.test.ts server/routines.test.ts server/routines-startup.test.ts src/components/routines/cron-editor.test.ts src/lib/routine-calendar.test.ts src/lib/schedule-label.test.ts server/bot-package.test.ts server/package-export.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/cron-routines-ui.e2e.test.ts
```

## Launch the isolated renderer

Run the launcher directly so Ctrl-C reaches the fixture owner:

```sh
node --experimental-strip-types scripts/verify-routines.ts
```

Open the printed `previewUrl`, not the user's running app. The launcher uses
`launchVerificationServer()` from the shared control surface, a temporary home
and data directory, free ports, and only the repository's fake Claude engine.
It mounts the real App and StoreProvider through Vite, with `/api` proxied to
that exact fixture. It does not use a real provider account, inbox, desktop,
cloud VM, or external service.

The launcher prepares these cases:

- **Pepper** gets an **Agent-created inbox check** trigger, applied at once with
  its live trigger card. The real `trigger` MCP handler (`action: "create"`) creates it using
  credentials captured from a running fixture turn. The fake model does not
  decide to call the tool.
- **Manual inbox check** is created through the routine API and run twice for
  Pepper. Both fresh executions report into **Fleet health reports**, inside
  the **OMB management** folder. Its next scheduled occurrence is an hour later.
- **Provider failure example** is created for **Miso** and run once. Miso's
  isolated fake engine deliberately exits early, producing a failure receipt.
- **Automatic scheduled check** is scheduled for Pepper about twelve seconds
  after creation. The real scheduler must dispatch it without clicking Run now.

The final startup JSON includes the server `url`, `previewUrl`, `pepperId`,
`misoId`, `scheduledRoutineId`, `manualRoutineId`, `resultsThreadId`,
`resultsFolderId`, temporary `dataDir`, and persistent `logPath`.

## Real UI checks

1. In Pepper's source chat, inspect the pending routine card. Confirm it once;
   the card must become settled and exactly one matching routine must appear.
   Reloading must preserve both the routine and the card's settled state.
   Open that routine and run it. Its report lands in Pepper's main thread (the
   open conversation the person last wrote in, here the source chat), not a new
   "· Results" thread, as one Pepper message captioned with the routine's name,
   and the caption's **See run** leads to the isolated execution thread. See
   [automation reports](automation-reports.md) for quiet runs, questions and
   the concurrency rule.
2. Open **Automations → Schedule**. Toggle **List / Calendar**. The list must
   show paused and finished schedules as well as active ones; changing views
   must not change a routine or start a run. Filter by Pepper and Miso and
   confirm that routine ownership stays correct.
3. Use **New → Scheduled task** to create a distinctly named Pepper routine.
   Check its saved schedule and prompt, edit it, then pause and resume it.
   **Run now** should create one run and show its eventual saved result.
   For the agent-created interval, compare `/api/routines` before and after a
   title-only edit: `schedule.anchorAt` and `nextRunAt` must not shift. An
   unchanged one-time schedule must likewise retain its exact `schedule.at`,
   including seconds and milliseconds omitted by the editor's time field.
4. Open **Run logs**. Verify the successful manual run, the Miso failure and its
   error, and the automatic run. Open the automatic receipt and verify it was
   **Scheduled**, not **Manual**. A finished one-shot schedule must not be
   described as a successful run merely because its date has passed.
5. Exercise bot and status filters, search by name or result/error text, and
   open a routine's scoped **Run logs** link. **Show all routines** removes that
   routine-only filter. Opening a run must show its own saved details and its
   actual execution thread when that thread still exists.
6. Return to Pepper and open its Computer side panel. The **Routines** tab next
   to Computer and the compact entry below the computer section must reach the
   same bot-scoped list. Check next-run dates, latest results and log links.
   Switch to Miso and back; never show Pepper's routines under Miso. Each bot's
   selected side-panel tab should survive closing and reopening the panel.
7. Open bot settings → Routines. It must use the same routine editor and central
   logs, without creating a second definition or competing history page.
   Confirm that the chat's model header and Ask composer retain their positions.
8. Expand Pepper's threads. **OMB management** contains one **Fleet health
   reports** thread, not separate sidebar entries for the two executions.
   Right-click the folder (or use its actions menu) → **Mark folder as read**.
   Its unread dots clear without selecting a conversation or resolving any
   pending approvals. Open the results thread: both captioned reports remain.
9. Use a report's **See run** to inspect its fresh execution transcript, then
   **Back to results**. **Run logs** retains the full execution history.
   A user follow-up sent in a completed execution makes it an ordinary visible
   thread; marking the older run seen must not hide that conversation again.
10. In the routine editor, **Post results to** offers visible threads grouped by
    folder or **The bot's main thread** (the default). Save to Fleet health
    reports, reload, and confirm the selection persists. In quick create,
    **More options** must preserve the chosen destination. Changing the owning
    bot, including via Call/Team goal selectors, must reset a foreign destination.
    Run a new routine twice: both reports use the chosen thread, while Run logs
    links to two different executions. The default reports every run into the
    bot's main thread and never creates a "· Results" thread.

Every routine reports into its bot's main thread unless the user chooses another
destination, whether it was made in a chat, the editor or the API, and whether a
teammate (such as a Chief) asked for it. The main thread is the open
conversation a person last wrote in (until anyone has, the selected one, then
the oldest); a bot with hidden threads opens there too. Conversations from
before the server kept that take it, once on upgrade, from the newest line a
person sent there from the app. Each run looks it up
again, so the routine saves nothing and its results follow the person. A routine
still pointing at an automatic "<name> · Results" thread from an older version
moves to the main thread on its next run; that thread and its reports stay. The
oldest thread that v0.1.98 to v0.1.107 saved on routines as if it were chosen is
cleared once on upgrade, also when it was archived since. On a Cloud home, a routine written by someone other
than the owner keeps its own results conversation, opened as theirs. Historical
runs keep the destination they started with. If that destination is deleted,
their execution threads become visible so results and approvals remain
reachable; future runs report into the main thread. No existing user
conversation is silently deleted or filed.

An unconfirmed proposal is not an active routine. A run marked **Waiting** is
not necessarily asking the user for approval: its attention text can explain
that work it handed to teammates is still outstanding — the job runtime has
assignments open for the run's thread (docs/runtime-contract.md §9), and the
run completes when their results have resumed it as a routine turn. Status,
result and scheduled/manual trigger must agree with the saved server record.

## Run on startup

A repeating routine's **Advanced** section offers **Also run when OpenMausBot
starts**. In the isolated renderer, create a daily routine with it ticked, then
reopen the editor: the box stays ticked. A one-time routine does not offer it.
Startup needs a restart on the same data, which this launcher does not do;
`server/routines-startup.test.ts` restarts a real fixture server on its own
store and requires exactly one completed **On startup** run.

The desktop gives every server child of one launch the same
`OMB_DESKTOP_LAUNCH_ID`, and `routines.json` records the launch whose startup
runs were queued. A crash recovery or switching back to a workspace within
that launch queues none; the next launch does. A server without the variable,
such as a standalone one, counts every process start.

```sh
pnpm exec vitest run server/routines.test.ts server/routines-startup.test.ts server/routine-requests.test.ts server/drivers/agents-proxy.test.ts shared/package-format.test.ts server/package-export.test.ts server/package-import.test.ts
node --test electron/server-child-launch.node-test.mjs
```

## Evidence and cleanup

Keep screenshots or a browser action transcript for renderer checks, and the
final startup JSON. For bounded chat evidence, copy the exact fixture bot and
execution-thread IDs into the shared control commands:

```sh
pnpm control:omb wait --bot BOT_ID --task THREAD_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --task THREAD_ID --limit 20 --url http://127.0.0.1:PORT
```

Use only the printed fixture server URL. The browser interaction checklist is
not automatically asserted by the launcher. On Ctrl-C, the launcher writes
`<logPath>.json` containing setup mutation evidence and the final `/api/routines`
snapshot (or a separately labelled `persisted` snapshot if Ctrl-C already stopped
the API), closes Vite and the exact child server, and removes only its temporary
data. The server log and adjacent JSON remain. Close the dedicated browser tab;
never kill processes by name or delete a broad temporary root.

## Automated regressions

In the editor's Advanced section, recurring routines offer **Skip this
occurrence** (the default) or **Queue one run**. The queued scheduled run waits
for the same routine to finish, including the assignments its run still has
outstanding on the job runtime; extra occurrences are skipped, not
accumulated. Manual runs and webhook deliveries remain independent. Pausing
still cancels queued work. The cron renderer test changes this option, saves
it, opens the editor again and switches it back.

The List view and `trigger_info` expose saved skipped-occurrence counts and
recent consecutive failures. Skips count occurrences observed by the scheduler
while busy, not every interval elapsed while offline. Failure streaks are
derived from retained terminal receipts (up to the existing history limit),
ignore cancelled/missed runs, and reset only after the whole run succeeds—not
an intermediate turn waiting for a teammate. Neither indicator pauses work
automatically. The scheduler tests cover bounded queues, daily/cron/interval
parity, restart recovery, duplicate completion events and atomic cursor/counter
rollback on a failed save. The MCP fixture verifies reviewed policy changes
and the listing through the actual tool and API, using no live accounts.

The routine tool defaults to `maus` (the bot's configured model and computer,
including VPS); `box` explicitly selects the bot's Boat cloud computer, which the
bot's own model drives through its computer tools. Legacy `cloud`
values remain accepted without migrating existing routines. The cron tool
fixture checks this default and the missing-Boat-account recovery instruction.
The VPS fixture runs an actual scheduled execution with fake ACP/SSH and checks
that the same VPS computer tools reach the agent without a Boat key. These are
deterministic routing checks, not a live model-choice or real VPS acceptance test.

```sh
pnpm exec vitest run server/vps-routing.test.ts server/routine-cron.e2e.test.ts
```

```sh
pnpm exec vitest run server/routines.test.ts server/routines-startup.test.ts server/routine-results.e2e.test.ts server/routine-delegation.e2e.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run src/components/routines/RoutineViews.test.ts src/components/routines/ResultsDestination.test.ts src/components/bot-settings/RoutinesSection.test.ts src/components/RoutineRunCard.test.ts src/components/BotProjects.test.ts src/lib/folder-read.test.ts src/lib/computer-panel-view.test.ts src/state/store.test.ts
```

The hand-off integration tests (`server/routine-delegation.e2e.test.ts`,
`server/runtime-paths.e2e.test.ts`) launch their own shared-control fixtures.
A routine turn hands work on with `coordinate_bots`; the run's root on the
job runtime names the run as its
requester with routine lineage (docs/runtime-contract.md §9). They verify a
busy peer delaying completion until its result resumes the same run as a
routine turn, a denied hand-off refused with that outcome and no assignment
written, a run that stays waiting through a restart while its cut teammate
turn runs again once (§5), and the one-time import of a pre-runtime
`delegations.json` at boot (`server/routines-startup.test.ts`). They print
retained server-log and JSON evidence paths. These complement the scheduler,
proposal and renderer tests; they do not prove real-provider tool selection,
actual desktop work, or packaged Electron behavior.

Webhook delivery IDs are committed atomically with their execution receipt.
Retries keep the same run ID for seven days, independently of run-log pruning;
unfinished work remains deduplicated beyond that window. A full retry ledger
rejects new work rather than discarding identities that senders may still retry.

```sh
pnpm exec vitest run server/webhook-idempotency.test.ts server/webhook-restart.e2e.test.ts
```

The restart test launches a disposable fake-engine server, creates a webhook,
then exits an owned worker between the execution and ingress commits. It restarts
that same isolated server and checks that redelivery returns the original run ID
with one execution. Its retained JSON evidence includes the receipt and transcript.

The results integration fixture additionally proves fresh provider contexts,
saved destination snapshots, captioned report lines, copied approval cards,
deleted-thread fallback, and continued user conversations staying visible. Native decoding and
thread-list tests retain hidden execution records for direct navigation and
approvals while omitting them from ordinary iOS/Android thread pickers.
