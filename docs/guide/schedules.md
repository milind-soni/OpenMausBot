# Schedules

Have a bot start work at a set time: a morning briefing, a weekday project check-in, or a message you want sent later.

## Create a schedule

Open **Schedules** in the sidebar and choose **New schedule**. You can also use the clock in a chat or room header. Beside the send button, **Send later…** starts a schedule with your draft text. The draft clears only after the schedule is saved. Scheduled messages currently support text; attachments stay in the normal composer.

Choose a bot or room, write the instructions, and choose when it should run:

- **One time:** a date and time.
- **Every day:** the same local time each day.
- **Monday to Friday (Weekdays):** the same local time on weekdays.
- **Every week:** selected days and a time.
- **Every few hours:** an interval of 1–168 hours, measured as elapsed time.

The timezone starts with your computer’s timezone. The preview shows the next run in the saved timezone. For rooms, mention the bots that should reply; a room with one member addresses that member automatically. `#project` mentions work as they do in a normal message.

The catch-up window defaults to two hours and can be changed under **Catch-up window**. The scheduled message appears in the conversation with an **⏰ Scheduled** label. If a bot is busy, the message waits on the computer running Studio, rather than disappearing when you leave the chat.

## The app must be running

Schedules run on the computer running Gerer Build Studio. You can close a browser tab while Studio keeps running there. They do not wake a sleeping computer or run after Studio has fully quit.

In the desktop app, you can turn on **Keep running in the menu bar when the window is closed** (macOS) or **Keep running in the system tray when the window is closed** (Windows and Linux). This is off by default. With it on, closing the window hides it; use the menu-bar or tray icon to reopen Studio or quit it fully. Without it, closing the last desktop window quits Studio.

Desktop notifications announce scheduled work when the bot’s notifications are on and your system permits notifications. A browser can announce a run only while its tab is open and notification access has already been granted.

## Missed, paused, and queued runs

When your computer wakes or Studio reopens, a missed run starts once if it is inside its catch-up window. Older missed runs are marked **Missed** in Schedules. Several days of work are never replayed in bulk. Only the latest eligible occurrence is considered. Each repeating schedule then moves to its next future time. Work already accepted into the busy queue stays queued until it starts or you cancel it; the catch-up window applies to alarms that had not yet been accepted.

**Pause all schedules** holds automatic runs, including automatic retries. It does not interrupt work already starting or running. **Run now** is an explicit request and still works while automatic runs are paused. Runs that are too old when you resume are marked missed.

Each card shows whether the message was sent, is queued, was missed, or failed to start. “Sent” means the message reached its conversation; it does not promise the bot completed the task. If the app closed while a run was starting and its result is uncertain, Studio marks it failed for review instead of risking repeating actions. Check the chat before choosing **Run now**.

Daily and weekly schedules follow their saved local clock through daylight-saving changes. If a time does not exist when clocks move forward, it shifts forward by that clock change. When a time occurs twice as clocks move back, the first occurrence is used, once that day. Hourly intervals follow elapsed hours instead.

## Manage schedules

Use each card to edit, turn on or off, run now, or delete. One-time schedules remain visible after they run. Bot-created schedules show their creator. Bots can create work only in their own chat or rooms they belong to, with at most 20 active schedules per bot. You can always cancel their pending schedules. Deleting a schedule does not stop a task that already began; use the conversation’s Stop control for that.

Automatic retry schedules are managed through **Cancel** and **Resume now**, rather than edited. See [Backup model](backup-model.md) and [Usage left](usage-and-limits.md) for their behavior.
