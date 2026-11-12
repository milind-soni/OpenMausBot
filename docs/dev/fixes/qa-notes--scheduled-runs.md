---
status: review
created: 2026-11-12
updated: 2026-11-12
owner: Dell
scope: scheduled-runs-auto-resume-backup-qa
commit-tested: 806f93a702803ef32b578edc942908ab12c89f5c
---

# Scheduled runs, auto-resume, and backup QA

Verdict: CHANGES REQUIRED. Three medium-severity failures are independently reproduced and filed below. Scheduling, scoped access under the supported caller contract, retry recovery, and backup selection otherwise pass the checks exercised here. Native desktop acceptance remains pending.

## Isolation and verification method

- New detached checkout: /Users/esoefildine/Documents/Dev/GBS-worktrees/dell-schedules at 806f93a. Existing node_modules reused by symlink; no install. No product code edits. No active main, soso, or z-preview files changed; no merges or pushes.
- QA harness 8923, Vite 5223, disposable Chrome/CDP 9323, and a second throwaway restart harness on 8924. Explicit GBS_DATA_DIR and GBS_PROJECTS_FILE; sanitized child environment and fake-only configured provider executables. No paid/real model turns and no real-bot messages.
- Installed playwright-core drives actual Chrome. Request/state polls wait for observable results. Synthetic clock checks import ScheduleStore and time helpers without touching live data. Live shared API port 8899 is used only to read/update task records.
- Sources reviewed: implementation plan, design/copy, board notes, user guides, schedules/time/backup code, runtime tests, settings UI and Electron background module.

## Failures requiring fixes

### Medium: Schedules accept a second target key with a non-string value

- Shared bug: efe15245-d22a-4658-9afb-db65dc6d3e17, tagged gererbuildstudio / schedules / severity-medium.
- Result: FAIL.
- Steps / observed / expected: At 806f93a POST /api/schedules with {target:{botId:VALID_TEST_BOT_ID,groupId:3},prompt:"QA",repeat:{kind:"once",at:FUTURE_ISO},timezone:"UTC"}. Actual: 201, malformed target persisted verbatim. Repeat with groupId:false or null: also 201. Internal /api/internal/schedules using the calling bot’s own ID similarly accepts numeric/boolean groupId. Two string-valued keys correctly return 400. Expected: exactly one target key with a nonempty string ID; reject the other key regardless of its type. validateSchedule compares only whether each value is a string, so malformed dual-key objects pass. This review did not demonstrate an authorization escape; ownership and membership checks separately passed.

### Medium: Schedule save errors lose modal focus and disable Escape dismissal

- Shared bug: ca15c855-4813-4b7f-b0e5-be0b461d96cd, tagged gererbuildstudio / schedules / severity-medium.
- Result: FAIL.
- Steps / observed / expected: In a browser chat enter a text draft, choose Send later, and submit a valid future schedule while POST /api/schedules returns a 400 error (QA intercepted response: {error:"QA rejected schedule"}). After the visible error appears, document.activeElement is BODY, outside the role=dialog sheet. Press Escape: the sheet remains open. The pending state disables the submit button, dropping focus, and the key handler exists only on the dialog. Expected: focus stays/returns inside the sheet on save failure; Tab remains trapped; Escape closes the sheet while preserving the unscheduled draft. Opening the sheet and immediately pressing Escape does work.

### Medium: Automatic retry status leaks into a different conversation

- Shared bug: cb983db0-e045-4c4a-8729-1d387d3de3c7, tagged gererbuildstudio / schedules / severity-medium.
- Result: FAIL.
- Steps / observed / expected: Have a limited fake create a retry in chat A. Click Cancel in its auto-resume notice, then select unrelated chat B without reloading. Actual: chat B displays "Automatic resume cancelled." even when B has no retry. Reproduced by cancelling QA UI retry, then opening QA UI backup and switching/keeping its backup model; screenshot and role=status DOM confirm the stale cancellation status in QA UI backup. AutoResumeNoticeCard stores status/error in component-local state without resetting when threadId changes. Expected: confirmation and error state belong to the conversation/action that produced them, and never appear in a different chat or room.

## Independent result matrix

| Check | Result | Evidence / reproduction |
| --- | --- | --- |
| Public origin guard | PASS | Cross-origin POST to /api/schedules returns 403. Valid UI writes through the actual Vite proxy work. |
| Internal authentication | PASS | Missing token and unknown caller return 401. Used only the token emitted to our fake CLI. |
| Ownership / room restrictions | PASS | Bot A cannot create for B (403) or a room A does not belong to (403). Bot B cannot cancel A's schedule (403). Bot PATCH and run-now return 405. Caller list contains only its own chat/member rooms. |
| Membership revoked after creation | PASS | Bot-created room alarm is created while A belongs to room; remove A, Run now as user. Delivery is failed with a plain no-access explanation; no room message is appended. |
| Active schedule cap | PASS | 20 caller-owned schedules accepted; 21st rejected (400). Caller can cancel pending schedules. |
| Malformed targets | FAIL | Missing/null/number-only targets and two string IDs are rejected, but dual keys with one numeric/boolean/null value are accepted and stored. See bug above. |
| Due dispatch and label | PASS | Short actual-clock one-time alarm sends exactly one user message with scheduleId metadata; browser transcript exposes the Scheduled label. |
| Actual two-minute timer | PASS | One-time alarm set 120 seconds ahead fired once after 120,490ms. Its sent timestamp was within about 10ms of the due timestamp; polling observed completion about 490ms later. |
| Busy queue | PASS | Hold a fake Claude turn, Run now on a schedule. Delivery stays pending; no premature prompt appears. Change fake to happy, interrupt initial turn: one scheduled prompt is delivered. |
| Model changes while busy | PASS | PATCH onUsageLimit during the held fake turn returns 409. Repository runtime tests also cover room backup behavior. |
| Global pause / explicit manual run | PASS | Pause all persists; manual Run now still dispatches once while paused. Resume re-enables automatic work. |
| Daily/weekly/weekday/hourly kinds | PASS | All five form cadence choices render. Pure time tests cover every repeat kind; full suite remains green. UI creation specifically saves a daily 09:10 Europe/Berlin alarm. |
| DST gaps/folds | PASS | Independently checked 2027 New York 02:15 spring gap -> 07:15Z, 01:15 autumn fold -> first 05:15Z; Berlin spring 02:10 -> 01:10Z, autumn 02:10 -> first 00:10Z; Lord Howe 30-minute spring gap 02:15 -> 15:45Z previous UTC day. |
| Fold is not run twice | PASS | After the first New York 01:15 occurrence, next daily occurrence is next local day, not the repeated hour. |
| Grace and offline backlog | PASS | Controlled-clock store catches an eligible occurrence once, records an old occurrence missed, and after a week queues only the most recent daily occurrence. |
| Actual server stop/restart | PASS | Stop our second harness, seed valid schedules representing one 10 minutes overdue and one 3 hours overdue, restart. Recent one is sent once; older one is missed. Restart again: sent occurrence is not replayed. No browser/SSE client is connected to that harness. |
| Durable busy queue / uncertain crash | PASS (store-level) | Pending delivery survives reconstruction. Mark a job dispatching, reconstruct again: it is failed for review and not replayed. This simulates uncertain crash state; no native app or machine crash was performed. |
| New-bot default | PASS | Fresh POST /api/bots has onUsageLimit=wait. Legacy stop-default migration is covered by code review/repository checks, not a separate legacy-profile UI migration run. |
| Stop on usage limit | PASS | Limited fake with stop policy yields no auto-resume schedule. |
| Unknown usage retry | PASS | Fake Claude failure produces one pending retry about 15 minutes ahead. Resume now twice updates that same ID to attempts 1/2 and about 30/60 minutes, never stacks another pending retry. |
| Backoff maximum / dedup | PASS | Repeated store upsertResume calls retain one schedule per conversation; delay caps at six hours. |
| Verified refresh retry | PASS | Fake Codex reports reset 2100-01-01T00:00Z; retry is exactly 2100-01-01T00:02Z. Fixture date is deliberately synthetic. |
| Stop / new message cancellation | PASS | Stop removes a pending private-chat retry. A new healthy room message replaces/removes the old room continuation. |
| Missing / exhausted backup | PASS | Unsupported backup selection or exhausted backup results in one wait schedule, without a retry loop through models. |
| Backup recovery | PASS | Main fake Codex fails, healthy fake Claude retries. Original user request remains once, saved main stays primary, usingBackup is true, and no redundant auto-resume remains. |
| Refresh and switch-back timing | PASS | Make main fake healthy and refresh through another fake turn: existing conversation stays on backup. Its next new turn returns to main and clears usingBackup. |
| Room backup / room retry | PASS | Room backup leaves one original room user request and settles room/bot busy state. Room auto-resume stores correct owner/thread, updates one retry with 30-minute backoff, and is cancelled by new work. |
| UI Send later | PASS | Text/target prefill match chat; cancel preserves draft; successful save clears it; intercepted failed save keeps it and shows error. Keyboard error recovery FAILS separately. |
| UI schedule management | PASS | Create daily alarm, observe row via SSE, edit prompt, Run now through a fake turn, and delete. All five cadence forms selectable. |
| UI global pause persistence | PASS | Pause via UI, reload, reopen Schedules: banner and server paused state persist. Resume works. |
| Browser layout | PASS | No document horizontal overflow at 1024, 1280, or 1920px. |
| Header target selection | PASS | Bot header preselects that bot; room header preselects the room ID. |
| Settings | PASS | Pick backup -> backup behavior; choose wait; reload/reselect same bot -> saved backup remains; remove backup -> wait. |
| Retry feedback conversation isolation | FAIL | Cancelling a retry in chat A leaves its confirmation visible after navigating to unrelated chat B; see bug above. |
| Retry UI actions | PASS | Resume now updates one retry; Cancel removes it. Notice has role=status. |
| Backup UI actions | PASS | Switch back now clears usingBackup while retaining main; Keep this model promotes backup, clears backup selection/flag, and sets wait. |
| Keyboard normal / save-error | MIXED | Sheet initially focuses inside itself and Escape restores normal view while preserving draft. After failed save focus is BODY and Escape fails: filed bug. |
| Typecheck | PASS | pnpm typecheck, exit 0. |
| Full tests | PASS | pnpm test: 45 files, 361 tests pass. Includes runtime fakes and Electron background-mode mocks. |
| Production build | PASS | pnpm build, exit 0; existing >500kB chunk advisory remains. |

## Desktop and scope limitations

- Actual Electron was not launched: it cannot be isolated from the live app under the standing constraints. Native menu-bar/tray persistence, closing/hiding the desktop window, full desktop quit/reopen, OS notification permissions/delivery, and real sleep/wake remain UNVERIFIED on macOS; Windows/Linux native behavior is also unverified.
- Electron background-mode code and mocked tests were reviewed/run. That is not a claim that native tray or window behavior was tested. The browser correctly has no native keep-running toggle.
- Real operating-system sleep and clock changes were not performed. Catch-up was verified via actual isolated-server restarts with seeded overdue times; DST and uncertain dispatch were checked with controlled store clocks/state.
- Fake engine outputs verify supported failure/recovery contracts, not the reliability of live providers. No paid models were contacted.
- Early UI automation assertions read state before React/SSE settled, and one reload initially inspected the default selected bot instead of reselecting the intended bot. Those were corrected and retested: draft clearing, pause persistence, and backup persistence pass. The failed-save focus issue remains reproducible after waiting for the error and is a product failure, not those timing artifacts.

## Finalization

The real 120-second timer passed. All test bots/rooms were idle before shutdown. QA processes stopped; lsof confirmed no listeners on 8923, 5223, 9323, or 8924. Temporary profiles, fixture state, fake wrappers, traffic logs and screenshots were removed. The detached QA checkout and this report are retained for review. Only this report is committed locally. No product code, dependency installation, merges, or pushes.
