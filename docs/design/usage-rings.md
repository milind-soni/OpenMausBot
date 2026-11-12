---
created: 2026-11-12
updated: 2026-11-12
owner: Z (Senior UI/UX & Motion Designer)
plan: docs/dev/plans/implementation--usage-rings.md
task: docs/dev/fixes/todo--usage-rings.md
status: ready-for-implementation
---

# Design Specification: Remaining-Usage Rings (`UsageRings`)

Remaining-Usage Rings give users a calm, at-a-glance readout of how much usage is left on each AI app (Claude, OpenAI Codex, Grok, Antigravity) their bots rely on, when that usage refreshes, and a one-click path to set a backup model before work is interrupted.

---

## 1. Design Tokens & Visual Encoding

All colors, surfaces, and animations use the existing tokens in `src/styles.css` (`@theme`):

| State / Threshold | Remaining Share (`remainingPercent`) | Stroke Color Token | Track / Geometry | Non-Color Secondary Signal (Mandatory) |
|---|---|---|---|---|
| **Healthy (`ok`)** | **`> 40%`** (`41%–100%`) | `var(--color-success)` (`#38d591`) | Solid arc on `var(--color-raised)` (`#2f2f2f`) track | Arc length proportional to remaining share; tooltip & `aria-label` state exact `% left` |
| **Low (`low`)** | **`15%–40%`** (`15%–40%`) | `var(--color-warning)` (`#ff9800`) | Solid arc on `var(--color-raised)` track | **`6×6px` amber warning triangle/dot badge** at bottom-right of ring + `"Low"` prefix in tooltip/popover & `aria-label` |
| **Critical (`low` < 15%)** | **`1%–14%`** | `var(--color-danger)` (`#ff5667`) | Solid short arc on `var(--color-raised)` track | **`10×10px` `!` badge** (`bg-danger text-white font-bold`) at bottom-right + inline `%` pill (`"9% left"`) |
| **Exhausted (`exhausted`)** | **`0%`** (or limit error active) | `var(--color-danger)` (`#ff5667`) | Full ring at `35%` opacity (`stroke-danger/35`) | Inline text pill beside ring: **`"Out until 3:40 PM"`** (or **`"Out of usage"`** if reset time is unknown) + `!` badge |
| **Unknown (`unknown`)** | **`null`** (not reported by AI app) | `var(--color-ink-secondary)` (`#fcfcfc99`) | **Dashed ring** (`stroke-dasharray="2.5 2.5"`, opacity `0.55`) | Dashed ring geometry (distinct from solid track) + `?` micro-badge on hover + `"Usage not reported"` in tooltip/popover |

> **Accessibility Rule — Color is never the only signal**:
> Every threshold is distinguishable without color vision via:
> 1. **Arc angle** (`360° × remainingPercent / 100` clockwise from 12 o'clock),
> 2. **Stroke pattern** (solid arc vs dashed ring `2.5 2.5` for unknown),
> 3. **Corner status badge / inline text pill** (`•` amber dot for `15–40%`, `!` badge for `< 15%`, `"Out until 3:40 PM"` inline label for `0%`), and
> 4. **Explicit text in tooltips, popovers, and `aria-label`s**.

---

## 2. Top Bar Placement, Ring Size & SVG Geometry

### 2.1 Placement in the Top Bar (`ChatView.tsx`, `GroupView.tsx`, and Screen Headers)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [🐭 Z] Z                                     [Claude 62% ◉][Codex 85% ◉][Grok ◌] │ [Claude ▾] [📱 Preview] [📋 Tasks] │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Where it sits**: Inside the right-hand control cluster of the top header bar (`ChatView.tsx:677`, `GroupView.tsx:215`), placed **immediately to the left** of the `ModelPicker` (in `ChatView`) or the `Activity` button (in `GroupView`), separated by a `16px` vertical hairline divider (`<span className="mx-0.5 h-4 w-px bg-hairline/50" aria-hidden="true" />`).
- **Which engines appear**: One ring per AI engine (`instanceId`) that is:
  1. Used by at least one non-hidden bot (`bot.modelSelection.instanceId` or `bot.backupModelSelection?.instanceId`), AND
  2. Not hidden by the user's per-engine toggle in Settings.
- **Window drag safety**: Wrapped inside the header's `style={noDrag}` (`WebkitAppRegion: "no-drag"`) container, respecting the Windows caption-button clearance (`pr-[148px]` when `window.gbs?.platform === "win32"`).

### 2.2 Exact Ring Size, Stroke & Center Engine Icon

```
        28px hit target (h-7 min-w-7)
      ┌───────────────────────┐
      │     20×20px SVG       │
      │     ╭───────────╮     │ ← r = 8px, strokeWidth = 2px, -rotate-90
      │    ╱   10×10px   ╲    │
      │   │  ProviderMark │   │ ← ClaudeMark / CodexMark / GrokMark (size={10})
      │    ╲             ╱    │
      │     ╰───────────╯●    │ ← 6×6px status badge (when low / critical)
      └───────────────────────┘
```

- **Outer interactive button**:
  - Default (healthy / low / unknown): `relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-raised/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors`
  - Exhausted (`status === "exhausted"`): expands into a compact pill `relative flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 pl-1 pr-2.5 text-[11px] font-medium text-danger hover:bg-danger/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent` so `"Out until 3:40 PM"` is immediately visible without hovering.
- **Ring cluster container**:
  - `flex items-center gap-1 rounded-full border border-hairline/40 bg-panel/70 px-1 py-0.5`
- **SVG Ring specification**:
  - Dimensions: `width={20} height={20} viewBox="0 0 20 20"` (`size-5`).
  - Center & Radius: `cx={10} cy={10} r={8}`.
  - Circumference: `C = 2 * Math.PI * 8 = 50.26548`.
  - Stroke width: `strokeWidth={2}`.
  - Track `<circle>`:
    - Known usage (`ok`, `low`, `exhausted`): `stroke="var(--color-raised)" strokeWidth={2} fill="none"`
    - Unknown usage (`unknown`): `stroke="var(--color-ink-secondary)" strokeOpacity={0.55} strokeWidth={1.75} strokeDasharray="2.5 2.5" fill="none"`
  - Progress `<circle>` (rendered when `remainingPercent !== null`):
    - `className="-rotate-90 origin-center transition-[stroke-dashoffset,stroke] duration-300 ease-out"`
    - `strokeLinecap="round"`
    - `strokeDasharray={50.265}`
    - `strokeDashoffset={50.265 * (1 - Math.max(0, Math.min(100, remainingPercent)) / 100)}`
    - `stroke`:
      - `remainingPercent > 40`: `"var(--color-success)"`
      - `remainingPercent >= 15 && remainingPercent <= 40`: `"var(--color-warning)"`
      - `remainingPercent < 15`: `"var(--color-danger)"`
- **Center Engine Icon (`ProviderIcons.tsx`)**:
  - `<span className="pointer-events-none absolute inset-0 flex items-center justify-center">`
  - `<ProviderMark driverKind={instance.driverKind} size={10} />`
  - Uses existing `ClaudeMark`, `CodexMark`, `GrokMark`, `ComputerMark`, or 2-letter monogram fallback at `size={10}`.

---

## 3. Component List

1. **`UsageRings.tsx`** — Top-bar component mounted in `ChatView`, `GroupView`, and screen headers. Renders individual `UsageRingButton`s at `>= 900px` and collapses into `UsageSummaryRingButton` below `900px`.
2. **`UsageRingGraphic.tsx`** — Pure presentational `20×20px` SVG ring + centered `ProviderMark` + non-color corner status badge.
3. **`UsageTooltip.tsx`** — Lightweight hover/focus tooltip (`role="tooltip"`) positioned below the ring.
4. **`UsagePopover.tsx`** — Click-opened popover card showing all windows for the selected engine (or all engines in summary mode), affected bots, last updated timestamp, `"Set a backup model…"`, and `"What do these mean?"`.
5. **Settings section in `SettingsScreen.tsx` (`ModelsSection`)** — Master `"Show usage in the top bar"` switch and per-engine visibility toggles.

---

## 4. Tooltip & Popover Specification

### 4.1 Hover / Keyboard Focus Tooltip (`UsageTooltip.tsx`)

- **Trigger**: Hover (`120ms` open delay) or keyboard `focus-visible` on any ring button. Hidden when the popover is open.
- **Position & Styling**:
  - `absolute right-0 top-full z-40 mt-1.5 w-max max-w-[300px] rounded-lg border border-hairline/50 bg-card px-2.5 py-1.5 text-[11.5px] leading-4 text-ink shadow-xl pointer-events-none animate-pop-in`
- **Exact On-Screen Copy by State**:
  - **Healthy (`> 40%`, multiple windows)**:
    `"Claude: 62% left in the current 5-hour window · refreshes at 3:40 PM. Weekly: 80% left."`
  - **Healthy (`> 40%`, single window)**:
    `"OpenAI Codex: 78% left · refreshes at 6:15 PM."`
  - **Low (`15%–40%`)**:
    `"Low usage — Claude: 24% left in the current 5-hour window · refreshes at 3:40 PM."`
  - **Critical (`1%–14%`)**:
    `"Almost out — Claude: 8% left in the current 5-hour window · refreshes at 3:40 PM."`
  - **Exhausted (`0%`, reset time known)**:
    `"Claude: Out of usage · refreshes at 3:40 PM."`
  - **Exhausted (`0%`, reset time unknown)**:
    `"Claude: Out of usage right now."`
  - **Unknown (`remainingPercent: null`)**:
    `"Grok: Usage left isn't reported by this AI app."`

---

### 4.2 Click Popover (`UsagePopover.tsx`)

```
┌──────────────────────────────────────────────────────────┐ ← w-[320px] rounded-2xl border border-hairline/50 bg-card p-4
│  [ClaudeMark 18px]  Claude                  [ 62% left ] │
│                     Updated 1 min ago                    │
├──────────────────────────────────────────────────────────┤
│  5-hour window                                  62% left │
│  [████████████████░░░░░░░░░░]                            │ ← h-1.5 rounded-full bg-raised, fill bg-success
│  Refreshes at 3:40 PM                                    │
│                                                          │
│  Weekly window                                  80% left │
│  [█████████████████████░░░░░]                            │
│  Refreshes Thu at 9:00 AM                                │
├──────────────────────────────────────────────────────────┤
│  Used by:  [🐭 Yv] Yv · [🐭 SoSo] SoSo (Backup: GPT-5)   │
├──────────────────────────────────────────────────────────┤
│  [⇄  Set a backup model…                              ›] │ ← Primary action button
│  [?  What do these mean?                              ↗] │ ← Opens docs/guide/usage-and-limits.md
│                                                          │
│  Some AI apps call this a rate limit or usage quota.     │ ← text-[11px] text-ink-secondary/70
└──────────────────────────────────────────────────────────┘
```

- **Container**: `absolute right-0 top-full z-40 mt-2 w-[320px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl shadow-black/60 animate-pop-in` (`role="dialog"`, `aria-label="{Engine Name} usage details"`).
- **Header (`flex items-start justify-between gap-2 pb-3 border-b border-hairline/40`)**:
  - Left: `ProviderMark` (`size={18}`) inside a `size-8 rounded-lg bg-panel flex items-center justify-center border border-hairline/40`, Engine `displayName` (`text-[14px] font-semibold text-ink`), and relative timestamp `"Updated just now"` / `"Updated 3 min ago"` (`text-[11px] text-ink-secondary`).
  - Right status pill (`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums`):
    - `> 40%`: `bg-success/15 text-success` → `"{pct}% left"`
    - `15–40%`: `bg-warning/15 text-warning` → `"Low · {pct}% left"`
    - `< 15%`: `bg-danger/15 text-danger` → `"Almost out · {pct}% left"`
    - `0%` (exhausted): `bg-danger/15 text-danger` → `"Out until {time}"` (or `"Out of usage"`)
    - `unknown`: `bg-raised text-ink-secondary` → `"Not reported"`
- **Windows Section (`py-3 space-y-3 border-b border-hairline/40`)**:
  - For each `UsageWindow` in `engineUsage.windows`:
    - Top line (`flex items-baseline justify-between text-[12.5px]`):
      - `window.label` (`text-ink`, e.g. `"5-hour window"`, `"Weekly window"`)
      - `"{window.remainingPercent}% left"` (`font-semibold tabular-nums text-ink`)
    - Progress bar (`mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-raised`):
      - Inner fill bar (`h-full rounded-full transition-all duration-300`), color matching that window's threshold (`bg-success`, `bg-warning`, or `bg-danger`).
    - Reset line (`mt-1 text-[11.5px] text-ink-secondary`):
      - `"Refreshes at 3:40 PM"` (same day) or `"Refreshes Thu at 9:00 AM"` (future day).
  - **When `status === "unknown"` and `windows.length === 0`**:
    - Renders a calm explanation box (`rounded-xl bg-panel/70 border border-hairline/40 p-3 text-[12px] leading-relaxed text-ink-secondary`):
      `"This AI app doesn't report how much usage is left ahead of time. If it runs out during a task, Gerer Build Studio will let you know and can switch to a backup model automatically."`
- **Bots Using This AI App (`py-2.5 border-b border-hairline/40`)**:
  - Label (`text-[11px] font-medium text-ink-secondary`): `"Bots using {Engine Name}"`
  - Chips (`mt-1.5 flex flex-wrap gap-1.5`): each bot shown with `MausAvatar size={16}` + `bot.name` + `(Backup set)` in `text-success` or `(No backup)` in `text-ink-secondary`.
- **Actions Footer (`pt-2.5 flex flex-col gap-1`)**:
  1. **`"Set a backup model…"`** (`flex w-full items-center justify-between rounded-xl bg-raised px-3 py-2 text-left text-[13px] font-medium text-ink hover:bg-raised-hover transition-colors`):
     - Clicking closes the popover and opens `SettingsPanel` (`dispatch({ type: "toggleSettings", open: true })`) for the current bot (or the first bot using this engine) and scrolls/focuses the **Backup model** field.
  2. **`"What do these mean?"`** (`flex w-full items-center justify-between rounded-xl px-3 py-1.5 text-left text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink transition-colors`):
     - Opens the plain-language guide (`docs/guide/usage-and-limits.md`).
  3. **Searchable technical footnote** (`mt-1.5 px-1 text-[11px] text-ink-secondary/70`):
     - `"Some AI apps call this a rate limit or usage quota."`

---

## 5. Responsive Behavior: Collapse Under `900px`

When the window width is **under `900px`** (`max-[899px]`):

```
>= 900px:   [ (Claude 62%) (Codex 85%) (Grok --) ]
<  900px:   [ (Claude 24% •) +2 ]   ← Single summary ring showing tightest engine + count
```

- **Rule**: All individual rings collapse into **one single summary ring button** (`className="flex min-[900px]:hidden ..."` while the multi-ring row uses `className="hidden min-[900px]:flex ..."`).
- **Which engine drives the summary ring**:
  - Picks the engine with the **most urgent status** (`exhausted` > `low (<15%)` > `low (15–40%)` > `ok` lowest `%` > `unknown`).
- **Summary button anatomy**:
  - Container: `flex h-7 items-center gap-1.5 rounded-full border border-hairline/40 bg-panel/80 pl-1 pr-2 text-[11px] text-ink hover:bg-raised`
  - Left: `UsageRingGraphic` (`20×20px`) for the tightest engine.
  - Right label:
    - If any engine is exhausted: `"Out until 3:40 PM"` (`text-danger font-medium`)
    - Else if tightest engine is `< 40%`: `"{pct}%"` (`text-warning` or `text-danger`, `tabular-nums font-medium`)
    - Else if more than 1 engine is active: `"+{N - 1}"` badge (`text-[10.5px] font-medium text-ink-secondary tabular-nums`, e.g., `"+2"`).
- **Clicking the summary ring**:
  - Opens `UsagePopover` in **All Engines view** (`w-[320px] max-h-[75vh] overflow-y-auto`), listing each active engine as a collapsible card section inside the same popover, followed by `"Set a backup model…"` and `"What do these mean?"`.

---

## 6. Settings Toggles (`src/components/SettingsScreen.tsx`)

Added inside the **Models & Providers** tab (`ModelsSection` in `src/components/SettingsScreen.tsx`) as a new card above `"Provider CLI Setup Reference"`:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Usage in the top bar                                                            │
│  Show how much usage is left on each AI app your bots use.                  [●]  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  [ClaudeMark]  Claude                                                       [●]  │
│  [CodexMark]   OpenAI Codex                                                 [●]  │
│  [GrokMark]    xAI Grok                                                     [●]  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Card container**: `rounded-2xl border border-hairline/50 bg-card p-6 shadow-sm`
- **Master switch row (`flex items-center justify-between gap-4`)**:
  - Title (`text-[16px] font-semibold text-ink`): `"Show usage in the top bar"`
  - Description (`mt-1 text-[13px] text-ink-secondary`): `"Display small rings at the top of the window showing how much usage is left on each AI app."`
  - Switch (`role="switch"`, default `true`): `relative h-6 w-11 shrink-0 rounded-full bg-accent` (or `bg-raised` when off).
- **Per-engine visibility rows (`mt-4 divide-y divide-hairline/40 rounded-xl border border-hairline/40 bg-panel/60 px-4`)**:
  - Shown when the master switch is on.
  - Each row (`flex items-center justify-between py-2.5`):
    - Left: `<ProviderMark driverKind={inst.driverKind} size={16} />` + `inst.displayName` (`text-[13.5px] text-ink`).
    - Right: `role="switch"` (`aria-label="Show {inst.displayName} usage in the top bar"`, default `true`).

---

## 7. Accessibility & Keyboard Navigation

- **ARIA attributes on each ring button**:
  - `type="button"`
  - `aria-haspopup="dialog"`
  - `aria-expanded={popoverOpen}`
  - `aria-label` examples (always includes engine name, status word, number, and reset time):
    - `aria-label="Claude usage: 62 percent left, refreshes at 3:40 PM"`
    - `aria-label="Claude usage low: 24 percent left, refreshes at 3:40 PM"`
    - `aria-label="Claude usage ran out, refreshes at 3:40 PM"`
    - `aria-label="Grok usage: not reported by this AI app"`
    - Summary ring (`< 900px`): `aria-label="AI usage summary: Claude 24 percent left, plus 2 other AI apps"`
- **Keyboard interaction**:
  - `Tab` / `Shift+Tab` focuses each ring button in the top bar with a clear `focus-visible:ring-2 focus-visible:ring-accent` outline and immediately shows the tooltip.
  - `Enter` or `Space` opens `UsagePopover` and moves focus to the first interactive element inside the popover.
  - `Escape` closes the popover and returns focus to the triggering ring button.
  - Clicking outside (`mousedown` outside `rootRef`) or window blur closes the popover.
