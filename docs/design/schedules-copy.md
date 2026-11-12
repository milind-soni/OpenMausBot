---
created: 2026-11-12
updated: 2026-11-12
owner: Marty (Lead Marketer & Brand Strategist)
support: Z (UI/UX Designer), SoSo (Developer)
plan: docs/dev/plans/implementation--scheduled-runs-and-backup-model.md
task: docs/dev/fixes/todo--scheduled-runs-and-backup-model.md
status: ready-for-implementation
---

# Product Copy Deck: Scheduled Runs, Auto-Resume & Backup Models

This document defines the complete user-facing copy for **Scheduled Runs**, **Auto-Resume**, **Backup Models**, and the associated **Usage Rings**. All strings adhere to the plain-language guidelines in `docs/guide/glossary.md` and align with Z's design specifications in `docs/design/usage-rings.md`.

---

## 1. Navigation & Screen Labels

### 1.1 Sidebar Item
- **Sidebar Label:** `Schedules`
- **Icon:** Alarm Clock (`Clock` / `AlarmClock`)
- **Tooltip (collapsed sidebar):** `Schedules (3 active)`
- **`aria-label`:** `Schedules, 3 active schedules`

### 1.2 Schedules Screen Header
- **Page Title:** `Schedules`
- **Subtitle:** `Have your bots start work automatically at set times.`
- **Top Actions:**
  - Primary Button: `+ New schedule`
  - Global Pause Switch (when running): `Pause all schedules`
  - Global Resume Switch (when paused): `Resume schedules`
- **Pause Banner (when paused):**
  - Banner Text: `All scheduled runs are currently paused. Your bots will not start scheduled tasks until you resume.`
  - Action Button: `Resume schedules`

### 1.3 Row Actions & Status Badges
- **Status Toggle (on row):** `Turn on` / `Turn off` (`aria-label="Toggle schedule for {Bot Name}"`)
- **Row Menu Options:**
  - `Run now` — Immediately triggers the prompt as if scheduled
  - `Edit schedule` — Opens the schedule configuration sheet
  - `Delete schedule` — Permanently removes the schedule
- **Next Run Badge:**
  - `Today at 3:00 PM`
  - `Tomorrow at 9:00 AM`
  - `Monday at 8:30 AM`
  - `Paused` (muted grey badge)

---

## 2. Empty States

### 2.1 Main Schedules Screen (Zero Schedules)
- **Illustration / Icon:** Clock with forward motion icon (`Clock` or `Sparkles`)
- **Headline:** `Have a bot start work at a set time`
- **Description:** `Set up morning briefings, daily task check-ins, or recurring research summaries. When the time arrives, your bot will pick up the task automatically.`
- **Primary CTA:** `Create a schedule`

### 2.2 Filter / Search Empty State
- **Headline:** `No schedules found`
- **Description:** `No schedules match "{query}". Check your spelling or clear your filters.`
- **Action Button:** `Clear filter`

---

## 3. Schedule Creation & Edit Sheet (`NewScheduleSheet` / `EditScheduleSheet`)

### 3.1 Sheet Header
- **Create Mode Title:** `New schedule`
- **Edit Mode Title:** `Edit schedule`
- **Close Button:** `Cancel` (`aria-label="Close schedule sheet"`)

### 3.2 Form Fields & Helper Text

#### 1. Target Selector
- **Label:** `Who should work on this?`
- **Options:** Dropdown or pill selector showing individual bots and multi-bot rooms.
- **Helper Text:** `Choose an individual bot or a collaborative room.`

#### 2. Prompt / Instruction Field
- **Label:** `What should they do?`
- **Placeholder:** `e.g. Check our open tasks in #gererbuildstudio and list top priorities for the day`
- **Helper Text:** `Write instructions just like a normal chat message. Use #project to attach a project folder or @bot to include teammates.`

#### 3. Repeat Cadence Dropdown
- **Label:** `When should it run?`
- **Options:**
  - `One time` — Runs once at a specific date and time
  - `Every day` — Runs daily at your selected time
  - `Monday to Friday (Weekdays)` — Runs Monday through Friday
  - `Every week` — Runs on selected days of the week
  - `Every few hours` — Runs at regular hourly intervals

#### 4. Time & Interval Pickers
- **When "One time" is selected:**
  - Date Picker Label: `Date`
  - Time Picker Label: `Time`
- **When "Every day" or "Weekdays" is selected:**
  - Time Picker Label: `Time` (e.g., `9:00 AM`)
- **When "Every week" is selected:**
  - Day Selection Label: `On these days`
  - Day Checkboxes: `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun`
  - Time Picker Label: `At this time`
- **When "Every few hours" is selected:**
  - Interval Picker Label: `Run every`
  - Options: `2 hours`, `4 hours`, `6 hours`, `8 hours`, `12 hours`

#### 5. Local Timezone Notice
- **Notice Copy:** `Times match your computer's local clock ({Timezone, e.g. Pacific Time}).`

#### 6. The "App Must Be Open" Notice & Background Running Opt-In
> [!IMPORTANT]
> Non-developers must clearly understand that background execution requires the desktop app to remain running.

- **Callout Box Text:** 
  > **Primary Line:** `Schedules run only while Gerer Build Studio is open.`
  > **Secondary Line:** `If the app is closed or your computer is asleep at a run time, runs missed within 2 hours will start once when you come back. Older missed runs are skipped so your bots don't run all at once.`
- **Desktop Background Running Switch (shown in Desktop App):**
  - **macOS Label:** `Keep running in the menu bar when the window is closed`
  - **Windows / Linux Label:** `Keep running in the system tray when the window is closed`
  - **Subtext:** `Keeps the scheduler active in the background when you close the main window.`

#### 7. Form Action Buttons
- **Primary Submit (Create):** `Schedule run`
- **Primary Submit (Edit):** `Save changes`
- **Cancel Button:** `Cancel`

---

## 4. In-Chat Controls & Message Badges

### 4.1 Chat Header Clock Button
- **Button Label:** `Schedule run…`
- **Tooltip:** `Schedule this bot to start a task at a set time`

### 4.2 Composer "Send Later" Option
- **Send Button Menu:** Split-button dropdown on the composer send arrow:
  - `Send now (Enter)`
  - `Send later… (Schedule)`

### 4.3 Scheduled Chat Bubble Badge
When a scheduled message posts into a conversation:
- **Badge Label:** `⏰ Scheduled` (displayed at the top of the user message bubble)
- **Tooltip:** `Sent automatically by a scheduled run`

### 4.4 Desktop Notification Copy
- **Notification Title:** `⏰ Scheduled task started`
- **Notification Body:** `{Bot Name} started: "{Prompt Summary}"`

---

## 5. Auto-Resume & Out-of-Credit Chat Notices

When a bot's AI app runs out of usage, it posts a clear, reassuring notice directly in the chat with immediate actions.

### 5.1 Auto-Resume Notice (Known Reset Time)
- **Notice Bubble:**
  > **Claude's usage ran out.** I'll pick this up automatically at **3:42 PM**.
- **Action Buttons:**
  - Primary Action: `Resume now` (attempts to run immediately if credits refreshed early)
  - Secondary Action: `Cancel auto-resume` (removes the scheduled resume)

### 5.2 Auto-Resume Notice (Unknown Reset Time)
- **Notice Bubble:**
  > **Claude's usage ran out.** I'll check back in an hour to continue where we left off.
- **Action Buttons:**
  - Primary Action: `Try now`
  - Secondary Action: `Cancel auto-resume`

### 5.3 Backup Model Switch Notice
When a bot encounters a limit and seamlessly switches to its backup model:
- **Notice Line:**
  > **Switched to GPT-5** because Claude's usage ran out. Continuing your task…
- **Header Badge:** A compact badge beside the model picker:
  - Badge Text: `Using backup` (amber/accent pill)
  - Badge Click Popover:
    - Title: `Currently using backup model`
    - Description: `This bot switched to GPT-5 because Claude's usage ran out. It will switch back to Claude once usage refreshes at 3:42 PM.`
    - Actions:
      - `Switch back to Claude now`
      - `Keep GPT-5 as main model`

### 5.4 Stop & Notify Notice (When Configured Not to Auto-Resume)
- **Notice Bubble:**
  > **Claude's usage ran out for now.** Work is paused until usage refreshes at **3:42 PM**.
- **Action Buttons:**
  - `Switch to backup model…`
  - `Resume now`

---

## 6. Bot Settings: Backup Model & Usage Options

Located in `SettingsPanel.tsx` (or Bot Settings modal) under the AI Model section:

### 6.1 Backup Model Field
- **Section Label:** `Backup model`
- **Picker Placeholder:** `Select a backup model…`
- **Helper Description:** `An alternate AI model to use if your main model runs out of usage. We recommend choosing a model from a different AI app (for example, pairing Claude with GPT-5).`

### 6.2 Out-of-Usage Behavior ("When usage runs out")
- **Section Label:** `When usage runs out`
- **Options (Radio Group):**
  1. **Switch to backup model (Recommended)**
     - *Helper Text:* `Continue working seamlessly using your backup model.`
  2. **Wait and continue**
     - *Helper Text:* `Pause and automatically schedule this task to resume when your primary model refreshes.`
  3. **Stop and tell me**
     - *Helper Text:* `Pause work and display a message so you can decide what to do.`

---

## 7. Errors & Missed-Run Messages

### 7.1 Caught-Up Missed Run (Within Grace Window)
- **Chat Notice / Activity Banner:**
  > **⏰ Caught up on scheduled task:** This task was scheduled for 8:00 AM while the app was closed. We started it as soon as Gerer Build Studio opened.

### 7.2 Skipped Missed Run (Outside Grace Window)
- **Schedules Screen Notification:**
  > **Scheduled run skipped:** The run scheduled for 6:00 AM was missed because your computer was asleep for more than 2 hours. It will run next at tomorrow's scheduled time (6:00 AM).
- **Action Link:** `Run now`

### 7.3 General Failure Error
- **Error Banner:**
  > **Could not start scheduled run:** {Friendly error reason}.
- **Action Button:** `Retry now`

### 7.4 Bot Schedule Cap Warning
- **Warning Toast / Dialog Note:**
  > **Schedule limit reached:** Each bot can have up to 20 active schedules. Please remove an older schedule to create a new one.

---

## 8. Usage-Ring Tooltips & Popover Copy (Aligning with Z's Spec)

### 8.1 Tooltips (`UsageTooltip.tsx`)
Displayed on hover (`120ms` delay) or keyboard focus:

- **Healthy State (`> 40%`, Multiple Windows):**
  `"Claude: 62% left in the current 5-hour window · refreshes at 3:40 PM. Weekly: 80% left."`
- **Healthy State (`> 40%`, Single Window):**
  `"OpenAI Codex: 78% left · refreshes at 6:15 PM."`
- **Low Usage (`15%–40%`):**
  `"Low usage — Claude: 24% left in the current 5-hour window · refreshes at 3:40 PM."`
- **Critical Usage (`1%–14%`):**
  `"Almost out — Claude: 8% left in the current 5-hour window · refreshes at 3:40 PM."`
- **Exhausted (`0%`, Reset Time Known):**
  `"Claude: Out of usage · refreshes at 3:40 PM."`
- **Exhausted (`0%`, Reset Time Unknown):**
  `"Claude: Out of usage right now."`
- **Unknown Usage (`remainingPercent === null`):**
  `"Grok: Usage left isn't reported by this AI app."`
- **Summary Ring Tooltip (under 900px viewport):**
  `"AI usage: Claude has 24% left (lowest), plus 2 other AI apps. Click to view all."`

### 8.2 Click Popover Card (`UsagePopover.tsx`)

#### Header
- **Title:** `{AI App Display Name}` (e.g. `Claude`, `OpenAI Codex`, `xAI Grok`)
- **Subtitle:** `Updated just now` / `Updated 3 min ago`
- **Status Pills:**
  - `62% left` (Healthy)
  - `Low · 24% left` (Low)
  - `Almost out · 8% left` (Critical)
  - `Out until 3:40 PM` (Exhausted)
  - `Not reported` (Unknown)

#### Windows Section
- **Window Label:** `5-hour window` / `Weekly window` / `Monthly allowance`
- **Percentage:** `{window.remainingPercent}% left`
- **Refresh Line:**
  - Same Day: `Refreshes at 3:40 PM`
  - Future Day: `Refreshes Thu at 9:00 AM`
- **Unknown Usage Callout Box:**
  > This AI app doesn't report how much usage is left ahead of time. If it runs out during a task, Gerer Build Studio will let you know and can switch to a backup model automatically.

#### Bots Using This App Section
- **Section Label:** `Bots using {AI App Name}`
- **Bot Chips:**
  - `{MausAvatar} {Bot Name} (Backup: GPT-5)`
  - `{MausAvatar} {Bot Name} (No backup set)`

#### Popover Action Buttons
1. **Primary Button:** `Set a backup model… ›`
   - *Action:* Opens bot settings and focuses the Backup Model dropdown.
2. **Secondary Button:** `What do these mean? ↗`
   - *Action:* Opens `docs/guide/usage-and-limits.md`.
3. **Searchable Technical Footnote:**
   - `"Some AI apps call this a rate limit or usage quota."`

### 8.3 Screen Reader Accessibility (`aria-label`s)
- **Healthy:** `aria-label="Claude usage: 62 percent left, refreshes at 3:40 PM"`
- **Low:** `aria-label="Claude usage low: 24 percent left, refreshes at 3:40 PM"`
- **Exhausted:** `aria-label="Claude usage ran out, refreshes at 3:40 PM"`
- **Unknown:** `aria-label="Grok usage: not reported by this AI app"`
- **Summary Ring:** `aria-label="AI usage summary: Claude 24 percent left, plus 2 other AI apps"`
