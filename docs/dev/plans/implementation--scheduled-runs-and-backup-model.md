# Implementation plan: scheduled runs, auto-resume, and backup model

## Objective

Three connected capabilities:

1. **Scheduled runs (an alarm clock for bots).** The user sets a prompt, a bot
   or room, and a time: once, daily, on weekdays, weekly, or every N hours.
   When the time comes, the bot starts working on its own, exactly as if the
   user had sent the message.
2. **Auto-resume when credits run out.** When a bot's engine reports that
   usage has run out, the bot schedules itself to continue when usage
   refreshes, and says so in the chat.
3. **Backup model.** Each bot can name a backup model. When the main model
   runs out, the bot switches to the backup automatically and finishes the
   job. It can switch back once the main model's usage refreshes.

Out of scope for v1:
- Running schedules while the app is fully quit (see Risks).
- Calendar integrations.
- Conditional triggers such as "when a file changes".

## Current state

- No scheduler exists. The only timers are Trello sync and screen polling.
- Messages are dispatched through the store `send` / `sendGroup` actions on
  the client, and `server/index.ts` runs turns and queues room responders.
- Bots have a single `modelSelection` (`server/store.ts:106`). There is no
  fallback.
- Out-of-credit failures arrive as generic `error:` activities. The usage-limit
  classifier and reset times come from Phase A of
  `implementation--usage-rings.md`, which this plan depends on for parts 2
  and 3.
- Bots already have agent tools (task board, messaging) through
  `server/drivers/agents-proxy.ts`. These are extended here.

## Proposed changes

### Part 1: scheduled runs
1. **`server/schedules.ts`**: storage (`schedules.json`, atomic, owner-only)
   and pure next-run calculation:
   ```ts
   type Schedule = {
     id: string;
     target: { botId: string } | { groupId: string };
     prompt: string;               // may include #project and @bot mentions
     repeat: { kind: "once"; at: string }
           | { kind: "daily" | "weekdays"; time: string }
           | { kind: "weekly"; time: string; days: number[] }
           | { kind: "every"; hours: number };
     timezone: string;             // captured from the user's system
     enabled: boolean;
     origin: "user" | "bot" | "auto-resume";
     createdBy?: string;           // bot id when origin = "bot"
     nextRunAt: string | null;
     lastRun?: { at: string; outcome: "sent" | "skipped-busy" | "missed" | "failed"; note?: string };
   };
   ```
2. **Scheduler loop** in the harness:
   - A single timer is set to the soonest `nextRunAt` and recalculated on any
     change. No per-second polling.
   - When a run is due:
     - The prompt is sent as a normal user message, labeled
       "⏰ Scheduled" in the chat, through the same server-side path that
       turns use.
     - If the bot is busy, the message queues behind the current turn. It is
       never dropped.
   - **Missed runs** (app closed or computer asleep):
     - On startup, a run missed by less than its grace window (default 2
       hours, adjustable per schedule) runs once.
     - Older misses are recorded as "missed" and shown to the user. They are
       never replayed in bulk.
   - Daylight-saving and timezone handling uses the stored timezone, with
     tests at DST boundaries.
3. **API**:
   - `GET/POST/PATCH/DELETE /api/schedules`, plus `POST /api/schedules/:id/run-now`
   - SSE `schedules` frames
   - The same request guard as the other mutation routes
4. **Bot tools** in agents-proxy: `create_schedule`, `list_schedules`, and
   `cancel_schedule`.
   - Bots may create schedules only for themselves, or for rooms they belong
     to.
   - Each bot is limited to 20 active schedules.
   - Every bot-created schedule is visible and cancellable by the user.
5. **UI** (design by Z, copy by Marty):
   - A **Schedules screen** (sidebar entry with an alarm-clock icon). It is a
     list grouped by bot or room, showing next run, repeat, on/off toggle,
     edit, run now, and delete, with a clear empty state ("Have a bot start
     work at a set time").
   - **In a chat or room**:
     - a clock button in the header opens a "New schedule" sheet, pre-filled
       with that bot
     - the composer send button gains "Send later…"
   - Scheduled messages show a small clock label in the chat.
   - A desktop notification fires when a scheduled run starts (respecting the
     bot's notification setting).

### Part 2: auto-resume when credits run out
6. A turn failing with `usage_limit` follows the bot's **"When usage runs out"**
   setting:
   - **Switch to backup model** (default when a backup is set). See part 3.
   - **Wait and continue** (default when no backup is set):
     - Create an `origin: "auto-resume"` schedule at `resetsAt` + 2 minutes,
       or, if no reset time is known, retry in 60 minutes with backoff up to 6
       hours.
     - The prompt is "Continue where you left off," with the interrupted
       request quoted.
     - The chat shows: "Claude's usage ran out. I'll pick this up at 3:42 PM."
       with **Cancel** and **Resume now** buttons.
   - **Stop and tell me**: the chat shows the notice only.
7. Only one pending auto-resume is allowed per bot thread. Repeated failures
   update it instead of stacking new ones.

### Part 3: backup model
8. Add `backupModelSelection?: ModelSelection` and
   `onUsageLimit?: "backup" | "wait" | "stop"` to the bot record (both stores).
   Migration: unset means current behavior.
9. On `usage_limit`, when the backup engine is available and not itself
   exhausted (checked against the usage store):
   - Retry the same turn on the backup automatically.
   - Post an activity line: "Switched to GPT-5 because Claude's usage ran
     out."
   - The bot's model picker shows a "using backup" badge.
10. **Switch back.** When the usage store reports the main engine as
    refreshed, the next *new* turn uses the main model again. It never
    switches in the middle of a turn. The user can pin the backup from the
    badge.
11. **UI.** Bot settings gain "Backup model" (a model picker restricted to
    other engines, recommended) and "When usage runs out" (the three options,
    in plain words).

### Documentation
12. Add `docs/guide/schedules.md` and `docs/guide/backup-model.md`, plus
    updates to the bot settings help text.

## Verification

- Unit tests:
  - next-run calculation for every repeat kind, across DST in two timezones
  - missed-run grace window
  - de-duplication of auto-resume entries
  - fallback decision logic (backup available, exhausted, missing)
- Server tests (fake CLIs):
  - a due schedule sends a message
  - a busy bot queues the scheduled message
  - a simulated usage-limit failure:
    - with a backup, it retries on the backup
    - without a backup, it creates an auto-resume schedule, and cancel and
      resume-now both work
  - bot tool permission scoping
- Manual (Dell):
  - a schedule set 2 minutes ahead fires
  - quitting and reopening inside and outside the grace window
  - the computer sleeping over a run time
  - a room schedule
  - everything works in a browser session

## Risks and rollback

- **The app must be running.**
  - Schedules fire only while Gerer Build Studio is open.
  - v1 lets the desktop app keep running in the menu bar or tray when its
    window is closed (opt-in), and shows a clear note in the Schedules
    screen.
  - Waking a sleeping computer is a follow-up.
- **Runaway bots.** Per-bot caps, visible bot-created schedules, and a global
  "Pause all schedules" switch.
- **Wrong-time runs.** Stored timezone plus DST tests.
- **Rollback.** Schedules are additive. The backup model is opt-in per bot.
  Disabling the scheduler loop through the pause switch stops all automatic
  runs.

## Approval

Status: awaiting user approval
