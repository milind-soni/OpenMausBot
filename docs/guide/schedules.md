# Scheduled Runs: An Alarm Clock for Your Bots

Imagine having your personal bots wake up at 8:30 AM every weekday, scan your open tasks, summarize the day's priorities, and leave a fresh brief waiting in your project room before you even open your laptop.

That is what **Scheduled Runs** do in Gerer Build Studio. You can set any instruction to run automatically once, daily, on weekdays, weekly, or every few hours.

---

## 1. What Are Scheduled Runs?

A scheduled run is an automated timer attached to a bot or a room. When the clock strikes your scheduled time, the studio sends your prompt as a normal message—exactly as if you had typed it into the chat yourself.

Your bot starts working, reads your project files, consults with teammates if needed, and posts its completed work in the conversation.

### Popular Ways to Use Schedules
- **Morning Briefings (Every weekday at 8:30 AM):** Ask your CEO or Lead Project Manager bot to summarize in-progress work across your projects.
- **Content Draft Check-ins (Daily at 2:00 PM):** Have your Writer bot review draft notes and suggest headline polish or copy edits.
- **Research Summaries (Every Monday at 9:00 AM):** Have your Researcher bot gather recent papers or findings and compile a weekly overview.
- **Task Board Clean-up (Every Friday at 5:00 PM):** Have a bot flag overdue tasks or tasks ready for review.

---

## 2. How to Set Up a Schedule

You can create a schedule in two quick ways:

### Method A: From the Schedules Screen
1. Click **Schedules** (the alarm clock icon) in the left sidebar.
2. Click **+ New schedule** in the top right.
3. Fill out the simple form:
   - **Who should work on this?** Choose a bot or a room.
   - **What should they do?** Type your instruction (e.g. `Check open tasks in #gererbuildstudio and list top priorities`).
   - **When should it run?** Choose your cadence:
     - **One time:** Runs once at a specific date and time.
     - **Every day:** Runs daily at the selected time.
     - **Monday to Friday (Weekdays):** Runs every weekday morning or afternoon.
     - **Every week:** Choose specific days (e.g., Monday and Thursday).
     - **Every few hours:** Runs at set intervals (e.g., every 4 hours).
4. Click **Schedule run**.

### Method B: Directly from Any Chat
1. Open any bot chat or collaborative room.
2. Click the **Clock icon** in the top header, or click the arrow on the composer send button and pick **Send later…**.
3. The schedule sheet opens with your bot already pre-filled. Enter your prompt, pick a time, and save!

---

## 3. Important: The App Runs on Your Computer

> [!NOTE]
> **Schedules run while Gerer Build Studio is open.**
> Because Gerer Build Studio is a private, local-first app that runs directly on your computer rather than on a remote cloud server, your bots work while the app is running.

### What Happens If My Computer Was Asleep?
Don't worry—you won't lose your work:
- **Caught-up runs (within 2 hours):** If your computer was asleep or the app was closed when a schedule was due, Gerer Build Studio will catch up and run the task as soon as you reopen the app or wake your computer.
- **Older missed runs:** If your computer was closed for an extended period (e.g., over a long weekend), the app will not flood your chat with dozens of overdue runs. It will simply skip the missed ones and notify you, ready for the next scheduled time.

*(Coming soon: Running in the background from your system menu bar even when the main window is closed).*

---

## 4. Managing Your Schedules

Open the **Schedules** screen from the sidebar anytime to:
- **Turn schedules on or off:** Use the toggle switch on any row to pause a schedule without deleting it.
- **Run immediately:** Click **Run now** to test your schedule right away without waiting for the clock.
- **Edit or delete:** Click the menu (`···`) on any row to update the instructions or delete the schedule.
- **Pause everything:** Going on vacation? Click **Pause all schedules** at the top of the screen to temporarily silence all automated tasks.

---

## 5. Automatic Bot Resumes

Bots can also create scheduled runs for themselves! 

When a bot's AI app runs out of hourly or daily credits, the bot automatically schedules a resume run for the exact moment its usage refreshes. See [Backup Models](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/backup-model.md) and [Usage & Limits](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/usage-and-limits.md) to learn more.
