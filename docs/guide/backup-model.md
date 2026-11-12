# Backup model and waiting to continue

A backup model is an alternate AI model your bot can use if its main AI app reports that usage has run out. It helps with supported interruptions; it cannot guarantee that work will always continue.

## Choose what happens

Open the bot’s settings and find **Backup model**. Choose a model from a different AI app, then choose **When usage runs out**:

- **Switch to backup model:** retry the interrupted request on the backup after the failed attempt has ended. If that backup is unavailable or has also run out, save a retry for later.
- **Wait and continue:** keep the request and schedule a new attempt.
- **Stop and tell me:** leave the conversation paused so you can decide what to do.

Existing bots keep **Stop and tell me** when upgrading, so an update does not start automatic work you did not previously enable. Newly created bots default to **Wait and continue**. Choosing a backup selects **Switch to backup model**; removing it selects **Wait and continue**. You can change that choice before the next task. Model choices cannot change while the bot is working.

## Waiting to continue

When a supported usage interruption occurs, the conversation shows its saved retry with **Cancel** and **Resume now**. Cancel removes pending retry work. Resume now queues one attempt as soon as the bot is free; it does not create several copies.

When the AI app reports a verified refresh time, the retry is set for two minutes after that time. Without a known time, the first retry is in 15 minutes, then 30 minutes, then an hour. Further waits grow up to six hours. This also allows for brief interruptions that clear before a daily or weekly allowance refreshes.

There is only one pending automatic retry per conversation. Repeated failures update it. The original request stays saved. A new message from you replaces the pending retry, and Stop cancels pending continuation for the task you stopped.

Where the AI app supports checking usage without doing work, Studio checks again before an automatic retry. If it still reports no usage, the retry is moved. Otherwise the next attempt tries to continue your saved request. A displayed time is not a promise that the account will be available. Claude does not currently provide a verified refresh time here. Grok and Antigravity interruptions without a supported usage signal remain ordinary errors; Studio does not guess that their usage ran out.

Automatic retries appear in **Schedules** and obey **Pause all schedules** and the catch-up window. Studio must still be running; see [Schedules](schedules.md). Cancelled or missed retries do not wake a sleeping computer or restart a fully quit app.

## Using a backup

Switching happens after a failed attempt ends. The original user message is kept once, and the retry uses the saved conversation. Studio asks the backup to inspect existing results before repeating actions, but you should review work with outside effects after an interruption.

The **Using backup** badge shows that a backup is selected for new work while the main AI app remains unavailable or its usage is unknown. A fresh reading alone does not switch a running conversation. The next new turn can use the main model once usage is reported as available. **Keep this model** makes the backup the main choice. **Switch back now** returns to the main model for the next message, even if its usage has not refreshed yet. Neither one interrupts a running task.

If the main app’s usage cannot be checked, Studio does not guess that it refreshed. You can select it manually when you are ready. Read [Usage left](usage-and-limits.md) to understand unknown readings and refresh times.
