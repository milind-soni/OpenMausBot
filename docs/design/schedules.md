---
created: 2026-11-12
updated: 2026-11-12
owner: Z (Senior UI/UX & Motion Designer)
plan: docs/dev/plans/implementation--scheduled-runs-and-backup-model.md
task: docs/dev/fixes/todo--scheduled-runs-and-backup-model.md
status: ready-for-implementation
---

# Design Specification: Scheduled Runs, Auto-Resume & Backup Model

This specification covers three connected workflows that keep work moving on time and across usage limits:
1. **Scheduled Runs (an alarm clock for bots)** — A dedicated **Schedules** screen, a **New schedule** sheet, a header clock trigger in every chat/room, **"Send later…"** on the composer send button, and a **`⏰ Scheduled`** message label.
2. **Auto-Resume when Usage Runs Out** — An in-chat notice (`"Claude's usage ran out. I'll pick this up at 3:42 PM."`) with **Cancel** and **Resume now** controls.
3. **Backup Model** — Per-bot **Backup model** and **When usage runs out** settings in `SettingsPanel.tsx`, an activity line when a turn switches, and a **"Using backup"** badge on `ModelPicker.tsx`.

---

## 1. Design Tokens & Visual Language

Uses existing tokens from `src/styles.css` (`@theme`):
- **Surfaces**: `bg-app` (`#070707`), `bg-panel` (`#111111`), `bg-card` (`#262626`), `bg-raised` (`#2f2f2f`), `bg-raised-hover` (`#3d3d3d`), `bg-inset` (`#191919`).
- **Borders**: `border-hairline/40`, `border-hairline/50`, `border-hairline/60` (`#333333`).
- **Typography**: `font-sans`, tabular numerals (`tabular-nums`) for all alarm times and countdowns.
- **Semantic colors**:
  - Active schedule / primary CTA: `bg-accent` / `text-accent` (`#1084fe`)
  - Healthy / sent outcome: `text-success` / `bg-success/15` (`#38d591`)
  - Paused / missed run / auto-resume waiting / using backup badge: `text-warning` / `bg-warning/10` / `border-warning/30` (`#ff9800`)
  - Failed run / destructive action: `text-danger` / `bg-danger/10` (`#ff5667`)

---

## 2. Component List

1. **`SchedulesScreen.tsx`** — Lazy-loaded full-page screen (`src/App.tsx`) with alarm-clock schedule cards grouped by bot or room, global **"Pause all schedules"** switch, runtime banner with the **"Keep running in the menu bar"** opt-in toggle, and empty state.
2. **`ScheduleSheet.tsx`** — Modal sheet for creating or editing a schedule (opened from the Schedules screen, the chat/room header clock button, or `"Send later…"` in the composer).
3. **Sidebar schedules entry (`src/components/Sidebar.tsx`)** — Footer navigation button with `AlarmClock` icon and active schedule badge.
4. **Chat & Room Header Clock Button (`src/components/ChatView.tsx`, `src/components/GroupView.tsx`)** — Opens `ScheduleSheet` pre-filled with that bot or room.
5. **Composer `"Send later…"` Control (`src/components/Composer.tsx`)** — Secondary clock action beside the Send button when the composer has content.
6. **Scheduled Message Label (`src/components/ChatView.tsx`, `src/components/GroupView.tsx`)** — `"⏰ Scheduled"` badge above scheduled user bubbles.
7. **`AutoResumeNoticeCard.tsx`** — Inline chat notice card when a turn pauses for usage reset, with **Cancel** and **Resume now** actions.
8. **Backup Model & Usage-Limit Controls (`src/components/SettingsPanel.tsx`, `src/components/ModelPicker.tsx`)** — `"Backup model"` picker, `"When usage runs out"` radio group, and `"Using backup"` header badge + popover actions.

---

## 3. Sidebar Entry & Alarm-Clock Schedules Screen (`SchedulesScreen.tsx`)

### 3.1 Sidebar Entry (`src/components/Sidebar.tsx`)
- Placed in the sidebar footer navigation list above **Projects**:
  - Icon: `AlarmClock` (`size={20}`), `className={state.schedulesOpen ? "text-accent" : "text-ink-secondary"}`.
  - Label: `Schedules` (`text-[14px] text-ink`).
  - Right badge (when expanded and active schedules > 0):
    - If global pause is off: `<span className="rounded-full bg-raised px-2 py-0.5 text-[11px] tabular-nums text-ink-secondary">{activeCount}</span>`
    - If global pause is on: `<span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10.5px] font-medium text-warning">Paused</span>`

### 3.2 Schedules Screen Header & Runtime Note Banner

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [←]  ⏰ Schedules                                          Pause all schedules [○]   [ + New schedule ]  │
│      Have your bots run prompts automatically on a set schedule.                                         │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ℹ️  Schedules run while Gerer Build Studio is open on your computer.                               │  │
│  │     If your computer is asleep or the app is closed, runs missed by less than 2 hours start        │  │
│  │     automatically when you reopen the app.                                                         │  │
│  │     ─────────────────────────────────────────────────────────────────────────────────────────────  │  │
│  │     Keep running in the menu bar when the window is closed                                    [●]  │  │
│  │     Lets scheduled runs start on time even after you close the main window.                        │  │
│  └────────────────────────────────────────────────────────────────────────────────────────────────────┘  │
```

- **Header Bar (`h-[64px] shrink-0 flex items-center justify-between border-b border-hairline/40 px-6`)**:
  - Left: Back button (`ArrowLeft size={18}`, `"Back to conversation (Esc)"`), `AlarmClock size={20} className="text-accent"`, Title `"Schedules"` (`text-[16px] font-semibold text-ink`), Subtitle `"Have your bots run prompts automatically on a set schedule."` (`hidden sm:block text-[12px] text-ink-secondary`).
  - Right (`flex items-center gap-3`):
    - **Global `"Pause all schedules"` switch**:
      - Wrapper: `flex items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5`
      - Label (`text-[12.5px] font-medium text-ink`): `"Pause all schedules"`
      - Switch (`role="switch"`, `aria-checked={pausedAll}`): `relative h-5 w-9 rounded-full transition-colors` (`bg-warning` when paused, `bg-raised` when not paused).
    - **Primary CTA**: `flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110 shrink-0` → `<Plus size={15} /> New schedule`.
- **Paused Banner (shown when `"Pause all schedules"` is ON)**:
  - `mx-auto max-w-4xl mb-4 flex items-center justify-between rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-[13px] text-warning`
  - Copy: `"All schedules are paused. No automatic runs will start until you resume them."`
  - Action button: `"Resume schedules"` (`rounded-lg bg-warning px-3 py-1 text-[12px] font-medium text-white`).
- **Always-Visible Runtime Note & Menu-Bar Opt-In Card**:
  - Container: `rounded-2xl border border-hairline/50 bg-panel/80 p-4 text-[13px]`
  - Top row (`flex items-start gap-3`):
    - Icon: `Info size={17} className="mt-0.5 shrink-0 text-accent"`
    - Copy:
      - Primary line (`font-medium text-ink`): `"Schedules run only while Gerer Build Studio is open."`
      - Secondary line (`mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary`): `"If the app is closed or your computer is asleep at a run time, runs missed within 2 hours will start once when you come back. Older missed runs are skipped so your bots don't run all at once."`
  - Desktop App Opt-In Row (`mt-3 pt-3 border-t border-hairline/40 flex items-center justify-between gap-4`, shown in Electron desktop app):
    - Left:
      - Label (`text-[13px] font-medium text-ink`):
        - macOS (`platform === "darwin"`): `"Keep running in the menu bar when the window is closed"`
        - Windows / Linux: `"Keep running in the system tray when the window is closed"`
      - Subtext (`text-[12px] text-ink-secondary`): `"Keeps the scheduler active in the background when you close the main window."`
    - Right: `role="switch"` (`h-6 w-11 rounded-full`, `bg-accent` when enabled, `bg-raised` when off).

---

### 3.3 Alarm-Clock Schedule Cards (Grouped by Bot or Room)

```
  [🐭 Yv]  Yv · CEO & Project Lead                                                       Open chat ›
  ┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │  09:00 AM              │  "Review #gerer-wavez open tasks and post today's top 3 priorities."     │
  │  Weekdays · Mon–Fri    │  Next run: Tomorrow at 9:00 AM · Last run: Today at 9:00 AM (Sent)       │
  │                        │                                      [ ▶ Run now ] [ ✎ ] [ 🗑 ]   [ ● ]  │
  └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Group Header (`flex items-center justify-between px-1 pb-2 pt-4`)**:
  - Left: `MausAvatar size={28}` (or `StackedMauses` for a room) + Bot/Room name (`text-[14px] font-semibold text-ink`).
  - Right: `"Open chat"` button (`text-[12px] text-ink-secondary hover:text-ink`).
- **Alarm Card (`rounded-2xl border border-hairline/50 bg-card p-4 shadow-sm transition-opacity`, `opacity-60` when `enabled === false` or global pause is on)**:
  - Layout: `flex flex-col sm:flex-row sm:items-center justify-between gap-4`
  - **Left Column — Digital Alarm Face (`sm:w-[190px] shrink-0 sm:border-r sm:border-hairline/40 sm:pr-4`)**:
    - **Time Readout**:
      - For `once`, `daily`, `weekdays`, `weekly`: `text-[22px] font-semibold tracking-tight tabular-nums text-ink` (e.g., `"9:00 AM"`).
      - For `every`: `text-[19px] font-semibold tabular-nums text-ink` (e.g., `"Every 4 hours"`).
    - **Repeat Pill (`mt-1 inline-flex items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary`)**:
      - Examples: `"Once · Tomorrow"`, `"Daily"`, `"Weekdays · Mon–Fri"`, `"Weekly · Mon, Thu"`, `"Every 4 hours"`.
  - **Middle Column — Prompt & Status (`min-w-0 flex-1`)**:
    - **Prompt text**: `text-[14px] leading-snug text-ink line-clamp-2` (renders `#project` and `@bot` mentions using `ProjectMentionText`).
    - **Origin & Status Metadata Row (`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary`)**:
      - Next run: `"Next run: Tomorrow at 9:00 AM"` (or `"Paused"` when toggle is off).
      - Origin badge (if `origin === "bot"`): `<span className="rounded bg-inset px-1.5 py-0.5 text-[11px] text-ink-secondary">Created by {botName}</span>`.
      - Origin badge (if `origin === "auto-resume"`): `<span className="rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning">Auto-resume when usage refreshes</span>`.
      - Last run outcome (if `lastRun` present):
        - `"sent"`: `"Last: Today 9:00 AM · Sent"` (`text-ink-secondary`)
        - `"skipped-busy"`: `"Last: Queued behind active turn"` (`text-accent`)
        - `"missed"`: `"Missed at 9:00 AM while app was closed"` (`text-warning`)
        - `"failed"`: `"Last run failed"` (`text-danger`)
  - **Right Column — Controls (`flex items-center gap-1.5 shrink-0 self-end sm:self-center`)**:
    - **Run now button**: `flex items-center gap-1 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover` → `<Play size={12} /> Run now`.
    - **Edit button**: `rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink` (`Pencil size={15}`, `aria-label="Edit schedule"`, `title="Edit"`).
    - **Delete button**: `rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-danger` (`Trash2 size={15}`, `aria-label="Delete schedule"`, `title="Delete"`).
    - **Alarm On/Off Switch**:
      - `ml-1 relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors` (`bg-accent` when `schedule.enabled`, `bg-raised` when off; `role="switch"`, `aria-label="Enable schedule at {time}"`).

---

### 3.4 Empty State (`schedules.length === 0`)

- **Container**: `mx-auto my-8 max-w-[480px] rounded-2xl border border-hairline/50 bg-card p-8 text-center shadow-sm`
- **Icon**: `<span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><AlarmClock size={24} /></span>`
- **Heading (`text-[16px] font-semibold text-ink`)**:
  `"Have a bot start work at a set time"`
- **Body (`mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary`)**:
  `"Set an alarm for any bot or room — like a morning summary, a weekday check on a project folder, or a message you want sent later today."`
- **Primary Button (`mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13.5px] font-medium text-white hover:brightness-110`)**:
  `"+ New schedule"`
- **Starter Preset Chips (`mt-5 pt-5 border-t border-hairline/40`)**:
  - Label (`text-[11.5px] text-ink-secondary mb-2.5`): `"Or start from an example:"`
  - Chips (`flex flex-wrap justify-center gap-2`):
    - `"Weekdays at 9:00 AM · Morning summary"`
    - `"Daily at 5:00 PM · Wrap up open tasks"`
    - `"Every 4 hours · Check project progress"`

---

## 4. "New Schedule" Sheet (`ScheduleSheet.tsx`)

Used for creating a schedule, editing an existing schedule, clicking the chat header clock button, or choosing **"Send later…"** from the composer.

```
┌──────────────────────────────────────────────────────────────┐ ← max-w-[520px] rounded-2xl bg-card p-5
│  ⏰ New schedule                                         [✕] │
│                                                              │
│  Bot or room                                                 │
│  [ 🐭 Scout · Research Specialist                        ▾ ] │
│                                                              │
│  What should it do?                                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Summarize new papers and update #gerer-wavez notes…    │  │ ← ProjectMentionTextarea
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  How often                                                   │
│  [ Once ] [ Daily ] [• Weekdays ] [ Weekly ] [ Every N hrs ] │
│                                                              │
│  Time                                                        │
│  [  09 : 00  AM  ]     Local time (Europe/Paris)             │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ⏰ Scout will run this every weekday (Mon–Fri) at       │  │
│  │    9:00 AM. Next run: Tomorrow at 9:00 AM.             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│                               [ Cancel ]  [ Save schedule ]  │
└──────────────────────────────────────────────────────────────┘
```

- **Backdrop & Modal Dialog**:
  - Backdrop: `fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4`
  - Dialog: `animate-pop-in w-full max-w-[520px] rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl shadow-black/70` (`role="dialog" aria-modal="true" aria-labelledby="schedule-sheet-title"`).
- **Fields**:
  1. **Target (`Bot or room`)**:
     - Select button (`w-full flex items-center justify-between rounded-xl border border-hairline/50 bg-inset px-3.5 py-2.5 text-[14px] text-ink`): shows `MausAvatar size={22}` (or `StackedMauses`) + name + `ChevronDown size={15}`.
     - Dropdown lists all visible Bots under `"Bots"` and all Rooms under `"Rooms"`.
  2. **Prompt (`What should it do?`)**:
     - `ProjectMentionTextarea` (`w-full min-h-[96px] rounded-xl border border-hairline/50 bg-inset px-3.5 py-2.5 text-[14px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none`).
     - Placeholder: `"Write the message the bot should receive — use # for projects and @ for bots"`.
  3. **Repeat Cadence (`How often`)**:
     - 5-option segmented pill bar (`grid grid-cols-5 gap-1 rounded-xl border border-hairline/40 bg-panel p-1`):
       - `"Once"` (`kind: "once"`)
       - `"Daily"` (`kind: "daily"`)
       - `"Weekdays"` (`kind: "weekdays"`)
       - `"Weekly"` (`kind: "weekly"`)
       - `"Every N hours"` (`kind: "every"`)
     - Each pill: `rounded-lg py-1.5 text-center text-[12px] font-medium transition-colors` (`bg-raised text-ink shadow-sm` when active, `text-ink-secondary hover:text-ink` when inactive).
  4. **Time & Conditional Sub-Controls**:
     - **When `"Once"` is selected**:
       - Quick-pick chips row (`flex flex-wrap gap-1.5 mb-2.5`):
         - `"In 1 hour"`, `"Later today (6:00 PM)"`, `"Tomorrow 9:00 AM"`, `"Monday 9:00 AM"`.
       - Date input (`type="date"`, `rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-[13.5px] tabular-nums text-ink`) + Time input (`type="time"`, `rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-[15px] font-semibold tabular-nums text-ink`).
     - **When `"Daily"` or `"Weekdays"` is selected**:
       - Large tactile time input (`type="time"`, `rounded-xl border border-hairline/50 bg-inset px-3.5 py-2 text-[16px] font-semibold tabular-nums text-ink`, default `"09:00"`) + timezone note (`text-[12px] text-ink-secondary`).
     - **When `"Weekly"` is selected**:
       - Day-of-week toggle pills (`flex items-center gap-1.5 mb-3`): 7 circular buttons (`Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun`, `h-8 px-2.5 rounded-lg text-[12px] font-medium`, `bg-accent text-white` when selected, `bg-inset border border-hairline/40 text-ink-secondary` when unselected) + Time input.
     - **When `"Every N hours"` is selected**:
       - Inline stepper row (`flex items-center gap-2 text-[14px] text-ink`):
         `"Run every"` + `<input type="number" min={1} max={24} value={hours} className="w-16 rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-center text-[15px] font-semibold tabular-nums text-ink" />` + `"hours"` (with quick pills: `2h`, `4h`, `6h`, `12h`).
  5. **Plain-Language Live Preview Box (`rounded-xl border border-hairline/40 bg-panel/80 px-3.5 py-2.5 text-[12.5px] text-ink-secondary`)**:
     - Dynamically summarizes the schedule before saving:
       - `"Scout will run this every weekday at 9:00 AM. Next run: Tomorrow at 9:00 AM."`
       - `"Product Room will receive this once on Fri, Nov 13 at 2:30 PM."`
  6. **Footer (`mt-5 flex items-center justify-end gap-2`)**:
     - `"Cancel"` (`rounded-xl bg-raised px-4 py-2 text-[13.5px] font-medium text-ink hover:bg-raised-hover`)
     - `"Save schedule"` (or `"Schedule message"` when opened from Composer `"Send later…"`, `rounded-xl bg-accent px-4 py-2 text-[13.5px] font-medium text-white hover:brightness-110 disabled:opacity-40`).

---

## 5. Chat Header Clock Button, Composer "Send later…", and Chat Label

### 5.1 Clock Button in `ChatView.tsx` & `GroupView.tsx` Header
- Placed in the right-hand header controls next to `Preview` and `Tasks`:
  - Class: `relative flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-raised/60 hover:text-ink`
  - Icon: `AlarmClock size={14}`
  - Label: `<span className="hidden sm:inline">Schedule</span>`
  - Count badge (when this bot/room has `>= 1` enabled schedule):
    `<span className="flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white">{botScheduleCount}</span>`
  - `aria-label`: `"Schedule a message for {botOrRoomName}"`, `title="Schedule a message"`.
- Clicking opens `ScheduleSheet` pre-filled with the current bot or room. If the bot/room already has active schedules, the top of `ScheduleSheet` shows a compact bar: `"{N} active schedules for {Name} · View all in Schedules"` that links to `SchedulesScreen`.

### 5.2 "Send later…" on the Composer Send Button (`src/components/Composer.tsx`)

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ [📎]  Message Z — # for projects                                        [ ⏰ Send later… ] [↑] │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- When `hasContent` is `true` in `Composer.tsx`:
  - Immediately to the left of the round primary Send button (`size-8 rounded-full bg-accent`), render a compact **"Send later…"** pill button:
    - Class: `flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-hairline/50 bg-raised/80 px-2.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`
    - Content: `<Clock size={13} /> <span className="hidden sm:inline">Send later…</span>`
    - `aria-label="Send message later"`, `title="Send later… (⌘⇧Enter)"`.
  - Clicking **"Send later…"** (or pressing `⌘⇧Enter` / `Ctrl+Shift+Enter`) opens `ScheduleSheet` with:
    - `target`: current `bot` or `group`
    - `prompt`: pre-filled with the composer's current `text`
    - `repeat`: defaulted to `Once` (Tomorrow at 9:00 AM, with one-tap chips for `"In 1 hour"`, `"Tonight at 6:00 PM"`, `"Tomorrow at 9:00 AM"`, `"Monday at 9:00 AM"`).
  - When saved, the composer clears its draft and briefly shows a confirmation strip above the input (`mb-2 flex items-center justify-between rounded-lg border border-hairline/40 bg-panel px-3 py-1.5 text-[12.5px] text-ink-secondary`):
    `"⏰ Scheduled for Tomorrow at 9:00 AM"` + `"Manage"` link (opens `SchedulesScreen`) and `"Undo"` button.

### 5.3 Scheduled-Message Label in the Chat (`ChatView.tsx` & `GroupView.tsx`)

```
                                                      ⏰ Scheduled · Weekdays 9:00 AM
                                    ┌───────────────────────────────────────────────┐
                                    │ Review #gerer-wavez open tasks and post       │
                                    │ today's top 3 priorities.                     │
                                    └───────────────────────────────────────────────┘
```

- When a message in the transcript has `scheduled: true` (or `scheduleId` metadata):
  - Above the user message bubble (`mb-1 flex items-center justify-end gap-1 pr-1 text-[11px] font-medium text-ink-secondary`):
    - `<AlarmClock size={11} className="text-accent" />`
    - Copy: **`"⏰ Scheduled"`** (or `"⏰ Scheduled by {bot.name}"` when `origin === "bot"`).

---

## 6. Auto-Resume Notice in the Chat (`AutoResumeNoticeCard.tsx`)

When a bot's turn stops with `usage_limit` and its **"When usage runs out"** setting is **"Wait and continue"** (or **"Stop and tell me"**):

### 6.1 "Wait and continue" State (Auto-Resume Scheduled)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ⏰  Claude's usage ran out. I'll pick this up at 3:42 PM.               │
│      Your request is saved and will continue from where it paused.       │
│                                                                          │
│      [ Cancel ]   [ ▶ Resume now ]                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Outer alignment**: `flex justify-start` inside the chat message list (`max-w-[900px]`).
- **Card styling**: `w-full max-w-[520px] rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-[13.5px] text-ink animate-msg-in` (`role="status" aria-live="polite"`).
- **Exact On-Screen Copy**:
  - **Primary headline (`font-medium text-ink`)**:
    - When reset time is known (`resetsAt` + 2 min):
      **`"{EngineName}'s usage ran out. I'll pick this up at {formattedTime}."`**
      *(Example: **`"Claude's usage ran out. I'll pick this up at 3:42 PM."`**)*
    - When reset time is unknown (60-minute backoff retry):
      **`"{EngineName}'s usage ran out. I'll try again at {formattedTime} (in 60 minutes)."`**
  - **Helper subtext (`mt-1 text-[12.5px] text-ink-secondary`)**:
    `"Your request is saved and will continue automatically when usage refreshes."`
- **Action Buttons (`mt-3 flex items-center gap-2`)**:
  1. **`"Cancel"`**:
     - Class: `rounded-lg border border-hairline/50 bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink`
     - Action: Calls `DELETE /api/schedules/:id` for the pending `auto-resume` schedule. Transitions the card to `"Automatic resume cancelled."` with a `"Resume now"` button still available.
  2. **`"Resume now"`**:
     - Class: `flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110`
     - Action: Calls `POST /api/schedules/:id/run-now` (and cancels the timer), immediately sending `"Continue where you left off"` to the bot.

### 6.2 "Stop and tell me" State
- Same card container, without a timer:
  - Headline: **`"Claude's usage ran out, so I stopped here."`**
  - Subtext: `"You can wait for usage to refresh at 3:40 PM, or set a backup model so future tasks keep going."`
  - Buttons: **`"Try again"`** (`bg-raised text-ink`) and **`"Set a backup model…"`** (`bg-accent text-white`, opens Bot Settings).

### 6.3 "Switch to backup model" Activity Line
- When the bot automatically switches to its backup model on `usage_limit`, an `ActivityChip`-style row renders in the transcript:
  - Class: `flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1.5 text-[12.5px] text-warning`
  - Copy: **`"Switched to {BackupModelLabel} because {MainEngineName}'s usage ran out."`**
    *(Example: **`"Switched to GPT-5 because Claude's usage ran out."`**)*

---

## 7. Bot Settings: Backup Model & When Usage Runs Out (`src/components/SettingsPanel.tsx`)

Placed inside `SettingsPanel.tsx` (`w-[400px]`) immediately below the existing **Model** card (`src/components/SettingsPanel.tsx:152-160`):

```
┌──────────────────────────────────────────────────────────┐
│  Model                                    [ Claude 4 ▾ ] │
│  Which provider and model this bot runs on               │
├──────────────────────────────────────────────────────────┤
│  Backup model                                [ GPT-5 ▾ ] │
│  Used automatically when the main model runs out         │
│                                                          │
│  When usage runs out                                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ (•) Switch to backup model                         │  │
│  │     Finish the job on GPT-5, then switch back      │  │
│  │     once Claude refreshes.                         │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ( ) Wait and continue                              │  │
│  │     Pause and continue automatically when usage    │  │
│  │     refreshes.                                     │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ( ) Stop and tell me                               │  │
│  │     Stop right away and post a notice in chat.     │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- **Card container**: `rounded-xl bg-card p-4 space-y-4`
- **Row 1 — Backup model (`flex items-center justify-between gap-4`)**:
  - Left:
    - Title (`text-[15px] font-medium text-ink`): `"Backup model"`
    - Subtitle (`mt-0.5 text-[13px] text-ink-secondary`): `"Used automatically when the main model runs out"`
  - Right: **`BackupModelPicker`**:
    - Same two-column rail + model list popover as `ModelPicker.tsx`, plus a top `"None"` option (`"No backup model"`).
    - **Provider filtering**: Other AI engines (`instance.instanceId !== bot.modelSelection.instanceId`) are listed first with a `"Recommended"` tag if available and not exhausted; the main model's own engine is disabled in the rail with the hint `"Choose a different AI app so it still works when {MainEngine} runs out"`.
- **Row 2 — When usage runs out (`border-t border-hairline/40 pt-3.5`)**:
  - Title (`text-[15px] font-medium text-ink`): `"When usage runs out"`
  - Subtitle (`mt-0.5 text-[13px] text-ink-secondary`): `"What this bot should do if its AI app runs out of usage"`
  - Options (`mt-2.5 divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40 bg-inset`, `role="radiogroup" aria-label="When usage runs out"`):
    1. **`"Switch to backup model"`** (`value: "backup"` — default when `backupModelSelection` is set):
       - Description (`text-[12px] text-ink-secondary`):
         - When backup is set: `"Finish the reply on {backupLabel}, then switch back once {mainEngine} refreshes."`
         - When no backup is set: `"Choose a backup model above to use this option."`
    2. **`"Wait and continue"`** (`value: "wait"` — default when no backup is set):
       - Description (`text-[12px] text-ink-secondary`): `"Schedule the bot to continue automatically as soon as usage refreshes."`
    3. **`"Stop and tell me"`** (`value: "stop"`):
       - Description (`text-[12px] text-ink-secondary`): `"Stop right away and show a notice in the chat."`

---

## 8. "Using Backup" Badge (`src/components/ModelPicker.tsx`)

When a bot is currently running on its `backupModelSelection` (because its primary model hit a usage limit and hasn't switched back yet, or was pinned):

```
┌───────────────────────────────────────────────┐
│ [CodexMark] GPT-5  [ Using backup ]  ▾        │
└───────────────────────────────────────────────┘
```

- **Trigger Button in `ModelPicker.tsx`**:
  - Shows the active backup model's icon and label (`GPT-5`), followed by an inline pill badge:
    - Class: `rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning`
    - Exact copy: **`"Using backup"`**
- **Banner at the Top of `ModelPicker` Popover (when `usingBackup` is active)**:
  - Container: `border-b border-hairline/40 bg-warning/10 p-2.5 text-[12px]`
  - Copy: `"Using {backupLabel} because {mainEngine}'s usage ran out. Switches back to {mainLabel} on the next new message after usage refreshes."`
  - Actions (`mt-2 flex items-center gap-2`):
    - **`"Keep using backup"`** (`rounded-md bg-raised px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover`) — pins the backup model so it stays active even after the main engine refreshes.
    - **`"Switch back now"`** (`rounded-md border border-hairline/50 px-2.5 py-1 text-[11.5px] text-ink-secondary hover:text-ink`) — immediately restores `mainModelSelection` for the next turn.

---

## 9. Responsive Behavior, Keyboard & Accessibility

### 9.1 Responsive Behavior
- **`1024px` width**:
  - `SchedulesScreen` content (`max-w-4xl`) has `704px` available width alongside the `320px` sidebar; alarm cards stack into 2 rows if needed (`flex-col sm:flex-row`), keeping the `22px` time readout and On/Off switch aligned at the top right.
  - In `ChatView` / `GroupView` header, the `Schedule` button hides its text label below `640px` (`hidden sm:inline`), keeping the `AlarmClock` icon and count badge visible.
- **`1280px` & `1920px` width**:
  - `SchedulesScreen` renders full horizontal alarm cards (`190px` digital time column + flexible prompt column + right action cluster).

### 9.2 Keyboard & Accessibility
- **`ScheduleSheet` modal**: Focuses the Prompt textarea (when opened from chat header) or the Date/Time quick chips (when opened from `"Send later…"`). Traps `Tab` focus; `Escape` closes the sheet and restores focus to the trigger.
- **Switches**: Every schedule toggle, `"Pause all schedules"`, and `"Keep running in the menu bar"` uses `role="switch"` and `aria-checked`.
- **Auto-resume notice**: Uses `role="status"` and `aria-live="polite"` so screen readers announce `"Claude's usage ran out. I'll pick this up at 3:42 PM."` as soon as the turn pauses.
