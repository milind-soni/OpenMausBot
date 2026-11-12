# Usage & Limits: Keeping Track of Your AI Apps

Gerer Build Studio puts you in full control of your AI allowance. Instead of wondering whether your bots will suddenly stop mid-task, you can glance at the **Usage Rings** in the top bar to see how much usage is left on each AI app and exactly when it refreshes.

---

## 1. What Are Usage Rings?

In the top right of the application header, you will see small circular rings representing each AI app your bots use (such as Claude, OpenAI, or Grok).

Each ring is color-coded and proportional to how much usage you have remaining in your current allowance window.

```
┌────────────────────────────────────────────────────────────────────────┐
│ [🐭 Yv] Yv                 [Claude 62% ◉][Codex 85% ◉] │ [Claude ▾] [📱] │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Reading the Ring Colors & Statuses

Gerer Build Studio uses both colors and clear visual badges so you can always understand your status at a glance:

| Ring Appearance | What It Means | Percentage Left | What You Should Do |
|---|---|---|---|
| **Green Solid Arc** | **Healthy Usage** | **Over 40%** (`41%–100%`) | Everything is running smoothly. Work as usual! |
| **Amber Solid Arc + Dot** | **Low Usage** | **15% to 40%** | You're approaching your limit. Great time to ensure your bot has a [Backup Model](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/backup-model.md) set. |
| **Red Short Arc + "!" Badge** | **Almost Out** | **Under 15%** (`1%–14%`) | Only a small amount of usage remains before refreshing. |
| **Red Pill: "Out until {time}"** | **Exhausted** | **0%** | Usage is paused. If a backup model is configured, your bots switch over automatically. Otherwise, they will resume at the stated time. |
| **Dashed Grey Ring** | **Not Reported** | *(Not provided by AI app)* | Some AI apps do not share live numbers ahead of time. Your bot will notify you if it runs out. |

> [!NOTE]
> **Accessibility note:** Color is never the only signal. The ring arc length, corner badges (`•` or `!`), tooltips, and click popovers state the exact percentage and status in plain English.

---

## 3. Tooltips & The Usage Popover

### Hover for a Quick Summary
Hover your mouse over any ring (or focus it with your keyboard) to see an immediate summary:
- *"Claude: 62% left in the current 5-hour window · refreshes at 3:40 PM. Weekly: 80% left."*
- *"OpenAI Codex: 78% left · refreshes at 6:15 PM."*

### Click for Full Details
Click any ring to open the **Usage Details Card**:
- **Usage Windows:** View separate progress bars for hourly, 5-hour, or weekly allowances.
- **Refresh Times:** See the exact clock time when your allowance resets (e.g. *"Refreshes at 3:40 PM"*).
- **Bots Using This App:** See which of your bots rely on this AI app and whether each bot has a backup model configured.
- **One-Click Actions:** Click **Set a backup model…** to immediately configure a safety net for your bots.

*(Footnote: Some AI companies refer to these allowances as "rate limits", "token limits", or "usage quotas").*

---

## 4. Smaller Screens: The Summary Ring

If you shrink your window or work in split-screen mode (under `900px` width), the studio cleanly collapses multiple rings into **one summary ring**.

The summary ring automatically monitors the AI app that has the lowest usage or needs your attention most. Clicking the summary button opens a unified popover showing all your active AI apps at once.

---

## 5. Customizing Usage Rings in Settings

You can choose exactly which AI apps appear in your top bar:

1. Open **Settings** (click your profile avatar or the gear icon in the bottom-left sidebar).
2. Go to the **Connected AI Apps** (Models & Providers) tab.
3. Under **Usage in the top bar**:
   - Use the master switch **Show usage in the top bar** to turn rings on or off.
   - Use the individual toggles to show or hide specific AI apps (for example, hide apps you rarely use).

---

## 6. Related Guides

- [Backup Models](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/backup-model.md) — How to automatically switch models when usage runs out.
- [Scheduled Runs](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/schedules.md) — How bots use usage refresh times to resume work automatically.
- [Plain-Language Glossary](file:///Users/esoefildine/Documents/Dev/GererBuildStudio/docs/guide/glossary.md) — Our guide to non-technical terminology across Gerer Build Studio.
