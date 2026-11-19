# Backup model and waiting to continue

A backup model is an alternate AI model your bot can use if its main AI app reports that usage has run out. It helps with supported interruptions; it cannot guarantee that work will always continue.

## Choose what happens

Open the bot’s settings and find **Backup model**. Choose a model from a different AI app, then choose **When usage runs out**:

- **Switch to backup model:** retry the interrupted request once on the other configured model after the failed attempt ends. If neither model can continue, save a retry for later.
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

The **Using backup** badge shows which model is active while the main AI app remains exhausted or its usage is unknown. When a new request begins, Studio can return to the main model if it has a fresh usage reading. If a request on the backup hits its usage limit, Studio checks whether the main model can resume it. Both choices stay saved across switches and restarts. **Make this the main model** swaps the main and backup choices. **Switch back now** selects the saved main model for the next request, even if its usage has yet to refresh. Both actions are available when the Buddy is idle.

If the main app’s usage cannot be checked, Studio keeps using the backup for new requests. If the backup hits a limit, Studio can try the main model once when its usage is unknown. Read [Usage left](usage-and-limits.md) to understand unknown readings and refresh times.
