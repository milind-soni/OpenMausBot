# Routines

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

- **Pepper** receives a pending **Agent-created inbox check** confirmation card.
  The real `propose_routine` MCP handler creates the card using credentials
  captured from a running fixture turn. The fake model does not decide to call
  the tool, and the launcher does not confirm the card.
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
   Open that routine, run it, and return to its source chat: its lifecycle
   receipt must lead to the isolated execution thread, not replace the source
   conversation.
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
   pending approvals. Open the results thread: both dated reports remain.
9. Use a report's **Open run** to inspect its fresh execution transcript, then
   **Back to results**. **Run logs** retains the full execution history.
   A user follow-up sent in a completed execution makes it an ordinary visible
   thread; marking the older run seen must not hide that conversation again.
10. In the routine editor, **Post results to** offers visible threads grouped by
    folder or **Create a dedicated results thread**. Save to Fleet health
    reports, reload, and confirm the selection persists. In quick create,
    **More options** must preserve the chosen destination. Changing the owning
    bot, including via Call/Team goal selectors, must reset a foreign destination.
    Run a new routine twice: both reports use the chosen thread, while Run logs
    links to two different executions. The dedicated default similarly reuses
    one results thread for future runs.

Existing chat-created routines keep reporting to their source conversation
unless the user chooses another destination. Historical runs keep the destination
they started with. If that destination is deleted, their execution threads become
visible so results and approvals remain reachable; future runs can create a new
results destination. No existing user conversation is silently deleted or filed.

An unconfirmed proposal is not an active routine. A run marked **Waiting** is
not necessarily asking the user for approval: its attention text can explain
that delegated work is still running. Status, result and scheduled/manual
trigger must agree with the saved server record.

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

```sh
pnpm exec vitest run server/routines.test.ts server/routines-startup.test.ts server/routine-results.e2e.test.ts server/routine-delegation.e2e.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run src/components/routines/RoutineViews.test.ts src/components/routines/ResultsDestination.test.ts src/components/bot-settings/RoutinesSection.test.ts src/components/RoutineRunCard.test.ts src/components/BotProjects.test.ts src/lib/folder-read.test.ts src/lib/computer-panel-view.test.ts src/state/store.test.ts
```

The delegation integration tests launch their own shared-control fixtures.
They verify a busy peer delaying completion until its result resumes the same
routine, a denied handoff resuming the routine with that outcome, and a cancelled
routine refusing a stale approved handoff. They print retained server-log and
JSON evidence paths. These complement the scheduler, proposal and renderer
tests; they do not prove real-provider tool selection, actual desktop work, or
packaged Electron behavior.

The results integration fixture additionally proves fresh provider contexts,
saved destination snapshots, dated result cards, approval links, deleted-thread
fallback, and continued user conversations staying visible. Native decoding and
thread-list tests retain hidden execution records for direct navigation and
approvals while omitting them from ordinary iOS/Android thread pickers.
