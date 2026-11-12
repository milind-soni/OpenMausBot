---
created: 2026-11-12
updated: 2026-11-12
owner: Z (Senior UI/UX & Motion Designer)
plan: docs/dev/plans/implementation--preview-studio.md
task: docs/dev/fixes/todo--preview-studio.md
status: ready-for-implementation
---

# Design Specification: Preview Studio

Preview Studio turns work-in-progress previewing into a first-class workflow for designers checking responsive layouts, authors reviewing formatted chapters or Markdown manuscripts, and researchers inspecting generated HTML/PDF reports.

It consists of two connected surfaces built on a shared `PreviewFrame` and `previewSizes` foundation:
1. **Quick Preview Side Panel (`MobilePreviewPanel.tsx`)** — A fast, single-frame inspector docked beside any 1:1 chat or multi-bot room.
2. **Full Preview Page (`PreviewScreen.tsx`)** — A dedicated sidebar destination offering a focused **Single mode** and a multi-artboard **Canvas mode** (ported from `#gerer-wavez`'s `src/editor/CanvasBoard.tsx`), plus **Share to chat**.

---

## 1. Design Tokens & Visual Foundation

All surfaces strictly use existing tokens from `src/styles.css` (`@theme`):

| Role | Token | CSS Variable / Hex | Tailwind Utility |
|---|---|---|---|
| App canvas / board stage | `app` | `--color-app` (`#070707`) | `bg-app` |
| Panel / toolbar surface | `panel` | `--color-panel` (`#111111`) | `bg-panel` |
| Elevated control / active tab | `raised` | `--color-raised` (`#2f2f2f`) | `bg-raised` |
| Control hover state | `raised-hover` | `--color-raised-hover` (`#3d3d3d`) | `bg-raised-hover` |
| Card / popover / dialog surface | `card` | `--color-card` (`#262626`) | `bg-card` |
| Input / recessed well | `inset` | `--color-inset` (`#191919`) | `bg-inset` |
| Hairline dividers & borders | `hairline` | `--color-hairline` (`#333333`) | `border-hairline/40`, `border-hairline/50` |
| Primary text | `ink` | `--color-ink` (`#fcfcfc`) | `text-ink` |
| Secondary / muted text | `ink-secondary` | `--color-ink-secondary` (`#fcfcfc99`) | `text-ink-secondary` |
| Primary accent | `accent` | `--color-accent` (`#1084fe`) | `bg-accent`, `text-accent`, `border-accent` |
| Active artboard / focus ring | `accent-border` | `--color-accent-border` (`#459ffe`) | `ring-accent-border`, `border-accent-border` |
| Positive / auto-refresh live | `success` | `--color-success` (`#38d591`) | `text-success`, `bg-success/15` |
| Local address / snapshot notice | `warning` | `--color-warning` (`#ff9800`) | `text-warning`, `bg-warning/10` |
| Error / blocked failure | `danger` | `--color-danger` (`#ff5667`) | `text-danger`, `bg-danger/10` |
| Motion curves | `panel-in`, `pop-in` | `cubic-bezier(0.22, 1, 0.36, 1)` | `animate-panel-in`, `animate-pop-in` |

---

## 2. Size Catalog (`src/lib/previewSizes.ts`)

Replaces `src/lib/mobileDevicePresets.ts` (while re-exporting `MOBILE_DEVICE_PRESETS` and `DEFAULT_MOBILE_DEVICE_PRESET_ID` for backward compatibility).

| Group | ID | Label | Default `width × height` (CSS px) | Rotatable | Default in Canvas Set |
|---|---|---|---|---|---|
| **Phone** | `iphone-se` | `iPhone SE` | `375 × 667` | Yes (`667 × 375`) | No |
| **Phone** | `iphone-16` | `iPhone 15 / 16` | `393 × 852` | Yes (`852 × 393`) | **Yes** |
| **Phone** | `pixel` | `Pixel` | `412 × 915` | Yes (`915 × 412`) | No |
| **Tablet** | `ipad-mini` | `iPad mini` | `744 × 1133` | Yes (`1133 × 744`) | **Yes** |
| **Tablet** | `ipad-pro-11` | `iPad Pro 11"` | `834 × 1194` | Yes (`1194 × 834`) | No |
| **Laptop** | `laptop-1280` | `Laptop` | `1280 × 800` | Yes (`800 × 1280`) | **Yes** |
| **Desktop** | `desktop-1440` | `Desktop` | `1440 × 900` | Yes (`900 × 1440`) | **Yes** |
| **Desktop** | `desktop-1920` | `Wide Desktop` | `1920 × 1080` | Yes (`1080 × 1920`) | No |
| **Custom** | `custom` | `Custom size…` | User-defined (`240`–`3840` × `240`–`3840`, default `1024 × 768`) | Yes (swaps `W` & `H`) | Optional |

- **Device frame styling**:
  - **Phone & Tablet** sizes use a tactile bezel: `rounded-[24px] border-[5px] border-raised bg-inset shadow-xl`.
  - **Laptop, Desktop, and Custom** sizes use a clean window frame: `rounded-xl border border-hairline/60 bg-inset shadow-xl`.

---

## 3. Component List & Hierarchy

1. **`PreviewFrame.tsx`** — Shared single-frame renderer:
   - Desktop (`window.gbs` present): renders `<webview>` for web addresses and HTML/PDF files; uses `window.gbs.previewScreenshot` for native capture.
   - Browser fallback: renders `<iframe sandbox="allow-scripts allow-same-origin allow-forms">` for web addresses and HTML/PDF; detects load timeouts and frame-blocking headers.
   - Markdown files (`.md`, `.markdown`): rendered inside a scrollable document container (`bg-card text-ink px-8 py-6 max-w-none`) using `ChatMarkdown`.
   - Image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`): rendered centered on a subtle checkerboard/inset stage with `object-contain`.
2. **`PreviewSourceBar.tsx`** — Unified source bar for web addresses or project files (`compact` variant for Quick Preview panel; `full` variant for Preview page).
3. **`PreviewSizePicker.tsx`** — Grouped dropdown/pill selector for Phone, Tablet, Laptop, Desktop, and Custom sizes, plus Rotate and Zoom controls.
4. **`MobilePreviewPanel.tsx`** — Rebuilt quick preview side panel in `ChatView` and `GroupView`.
5. **`PreviewScreen.tsx`** — Lazy-loaded full-page screen with Single mode and Canvas mode.
6. **`PreviewCanvas.tsx`** — Pannable, zoomable multi-artboard board ported from `#gerer-wavez` (`src/editor/CanvasBoard.tsx`), enforcing the 6-live-frame cap.
7. **`SharePreviewModal.tsx`** — Modal popover/dialog to send one size or all selected sizes as screenshots to a chosen bot or room with an optional note.

---

## 4. Surface 1: Improved Quick Preview Side Panel (`MobilePreviewPanel.tsx`)

### 4.1 Exact Layout & Sizes

```
┌──────────────────────────────────────────────────────────┐ ← w-[400px] border-l border-hairline/40 bg-panel
│ [Globe/File ▾] [ http://localhost:5173 or file…  ] [Open]│ ← Row 1: px-3 pt-2.5 pb-1.5, gap-1.5
│ [‹] [›] [↻] │ [📱 iPhone 15/16 ▾] [⇄] [Fit ▾] │ [📷▾][↗][✕]│ ← Row 2: px-3 pb-2 border-b border-hairline/40
├──────────────────────────────────────────────────────────┤
│                                                          │
│              ┌────────────────────────────┐              │
│              │                            │              │
│              │                            │              │
│              │       <PreviewFrame>       │              │ ← Stage: flex-1 min-h-0 p-4 bg-app/50
│              │                            │              │   items-center justify-center
│              │                            │              │
│              │                            │              │
│              └────────────────────────────┘              │
│               iPhone 15 / 16 · 393×852 · 82%             │ ← Readout: mt-2 text-[11px] text-ink-secondary
└──────────────────────────────────────────────────────────┘
```

- **Outer container**: `flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel` (`aria-label="Quick preview"`).
- **Header Trigger in `ChatView.tsx` & `GroupView.tsx`**:
  - Button class: `relative flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px]` (`bg-raised text-ink` when open, `text-ink-secondary hover:bg-raised/60 hover:text-ink` when closed).
  - Icon: `Smartphone` (`size={14}`), Label: `Preview` (`hidden sm:inline`).
  - `aria-label={previewOpen ? "Hide preview panel" : "Show preview panel"}`, `aria-pressed={previewOpen}`.

#### Row 1 — Source Bar (`px-3 pt-2.5 pb-1.5 flex items-center gap-1.5`)
- **Choose File button**: `flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline/40 bg-inset text-ink-secondary hover:bg-raised hover:text-ink` (`FolderOpen size={13}`, `title="Preview a file from a project"`, `aria-label="Preview a file from a project"`). Opens a popover listing registered projects (`#project`) and their previewable files (`.html`, `.pdf`, `.md`, images), or accepts drag-and-drop onto the panel.
- **Address / File input**: `min-w-0 flex-1 h-7 rounded-md border border-hairline/40 bg-inset px-2.5 text-[12px] text-ink placeholder:text-ink-secondary/70 focus:outline-none focus:ring-1 focus:ring-accent`.
  - Placeholder: `"Enter a web address or drop a file…"`.
  - Focus opens the recent history listbox (`max-h-52 overflow-y-auto rounded-lg border border-hairline/50 bg-card py-1 shadow-xl z-30`).
- **Submit button**: `shrink-0 h-7 rounded-md bg-accent px-2.5 text-[11.5px] font-medium text-white hover:brightness-110` — label `"Open"`.

#### Row 2 — Navigation, Size, Zoom & Actions (`px-3 pb-2 border-b border-hairline/40 flex items-center justify-between gap-1`)
- **History & Reload cluster** (`flex items-center gap-0.5`):
  - **Back** (`ChevronLeft size={14}`), **Forward** (`ChevronRight size={14}`), **Reload** (`RotateCw size={13}`): each `flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-35 disabled:pointer-events-none`.
  - `aria-label`: `"Go back"`, `"Go forward"`, `"Reload preview"`.
- **Size Picker dropdown button**:
  - `flex h-6 max-w-[136px] items-center gap-1 rounded-md bg-inset border border-hairline/40 px-2 text-[11px] font-medium text-ink hover:bg-raised`
  - Shows group icon (`Smartphone`, `Tablet`, `Laptop`, or `Monitor` at `size={12}`) + truncated preset label + `ChevronDown size={11}`.
  - Clicking opens a `w-[232px] rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl z-30` menu grouped with section headers (`text-[10px] font-semibold uppercase tracking-wider text-ink-secondary px-3 pt-2 pb-1`):
    - **Phone**: `iPhone SE (375×667)`, `iPhone 15 / 16 (393×852)`, `Pixel (412×915)`
    - **Tablet**: `iPad mini (744×1133)`, `iPad Pro 11" (834×1194)`
    - **Laptop**: `Laptop (1280×800)`
    - **Desktop**: `Desktop (1440×900)`, `Wide Desktop (1920×1080)`
    - Divider (`border-t border-hairline/40 my-1`)
    - **Custom size…**: reveals two inline numeric inputs `W` × `H` (`w-16 rounded bg-inset px-1.5 py-1 text-[11px] tabular-nums text-ink`) + `"Apply"` button.
- **Rotate button**:
  - `flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink` (`aria-pressed={rotated}`, `aria-label="Rotate screen"`, `title="Rotate screen"`).
  - When rotated (`rotated === true`), swaps `width` and `height` and highlights with `bg-accent/15 text-accent`.
- **Zoom picker dropdown**:
  - `flex h-6 items-center gap-0.5 rounded-md bg-inset border border-hairline/40 px-1.5 text-[11px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink`
  - Options: `Fit` (default), `50%`, `75%`, `100%`.
  - When `Fit` is active, displays `"Fit"` (and the footer readout shows the computed percentage, e.g. `82%`). When a fixed zoom is chosen and the scaled frame exceeds the stage area, the stage container switches from `overflow-hidden` to `overflow-auto`.
- **Right utility actions** (`flex items-center gap-0.5`):
  - **Screenshot menu button** (`Camera size={14}` + `ChevronDown size={10}`): opens menu with `"Send visible area to chat"` and `"Send full page to chat"`.
  - **Open in Preview page button** (`Maximize2 size={13}`, `title="Open in Preview page"`, `aria-label="Open in Preview page"`): carries the current `source`, `presetId`, `rotated`, and `zoom` directly into `PreviewScreen` and navigates there.
  - **Close panel button** (`X size={14}`, `aria-label="Close preview panel"`).

---

## 5. Surface 2: Full Preview Page (`PreviewScreen.tsx`)

### 5.1 Sidebar Entry (`src/components/Sidebar.tsx`)
- Placed in the sidebar footer navigation list between **Projects** and **Apps**:
  - Icon: `MonitorSmartphone` (or `Eye`) at `size={20}`, `className={state.previewOpen ? "text-accent" : "text-ink-secondary"}`.
  - Label: `Preview` (`text-[14px] text-ink`).
  - Button class: `flex items-center gap-3 rounded-xl p-2 text-left` (`w-full px-3 py-2` expanded; `justify-center p-2.5` when `collapsed`).
  - Selected state: `bg-raised`; unselected: `hover:bg-raised/50`.

### 5.2 Top Header & Source Bar Layout

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [←]  Preview   [🌐 Web address | 📄 Project file] [ #gerer-wavez ▾ / index.html or https://… ] [Open] [↻]  │
│      [‹][›]  ☑ Refresh when files change    │  Sizes: [📱 393][📱 744][💻 1280][🖥 1440][+ Sizes ▾]        │
│                                             │  Mode: [ Single | Canvas ]         [📷 Share to chat… ▾]     │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar container**: `shrink-0 border-b border-hairline/40 bg-panel px-5 py-2.5` (`WebkitAppRegion: "drag"` on the outer strip; interactive clusters wrapped in `WebkitAppRegion: "no-drag"`, with `pr-[148px]` on Windows).
- **Row A — Identity, Source Bar & Share Action (`flex items-center justify-between gap-3`)**:
  1. **Left identity cluster (`flex items-center gap-2.5 shrink-0`)**:
     - Back button (`ArrowLeft size={18}`, `rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink`, `title="Back to conversation (Esc)"`).
     - Title: `h1` `"Preview"` (`text-[15px] font-semibold text-ink`).
  2. **Center Source Bar (`flex min-w-0 max-w-[680px] flex-1 items-center gap-1.5`)**:
     - **History buttons**: Back (`ChevronLeft size={15}`), Forward (`ChevronRight size={15}`), Reload (`RotateCw size={14}`) in `flex items-center gap-0.5`.
     - **Source Type Pill Switch** (`inline-flex rounded-lg bg-inset p-0.5 border border-hairline/40 shrink-0`):
       - `"Web address"` (`Globe size={12}`)
       - `"File"` (`FileText size={12}`)
     - **When `"Web address"` is active**:
       - URL input (`h-8 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none`) with recent URLs dropdown.
       - `"Open"` button (`h-8 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110`).
     - **When `"File"` is active**:
       - **Project Picker** (`h-8 max-w-[180px] rounded-lg border border-hairline/50 bg-inset px-2.5 text-[12.5px] text-ink`): lists registered projects (`#gerer-wavez`, etc.).
       - **File Picker / Path Button** (`h-8 min-w-0 flex-1 flex items-center justify-between rounded-lg border border-hairline/50 bg-inset px-3 text-[12.5px] text-ink hover:bg-raised/50`): shows current relative file path (e.g. `docs/report.html` or `chapters/chapter-1.md`) or `"Choose a file or drop one here…"`. Clicking opens a filterable file list scoped to the selected project (`.html`, `.htm`, `.pdf`, `.md`, `.markdown`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`).
  3. **Right Action Cluster (`flex items-center gap-2 shrink-0`)**:
     - **Mode Segmented Control (`Single` | `Canvas`)**:
       - Container: `inline-flex rounded-lg border border-hairline/40 bg-inset p-[3px] gap-0.5` (matches `.ratio-switch` in `#gerer-wavez/src/editor/canvas.css`).
       - Each button: `inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors`.
       - Active: `bg-raised-hover text-ink shadow-[inset_0_0_0_1px_var(--color-hairline)]`; Inactive: `text-ink-secondary hover:bg-raised hover:text-ink`.
     - **Share to chat button**:
       - `flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white hover:brightness-110`
       - Icon: `Camera size={14}`, Label: `"Share to chat…"`.

- **Row B — Size Set Bar & Auto-Refresh (`mt-2 flex items-center justify-between gap-3 pt-2 border-t border-hairline/30`)**:
  - **Left — Size tabs / checkboxes**:
    - **In Single mode**: horizontal pill tabs for the active size set (`iPhone 15 / 16 · 393×852`, `iPad mini · 744×1133`, `Laptop · 1280×800`, `Desktop · 1440×900`), where clicking a tab switches the active frame (`bg-accent/15 text-accent border border-accent/30` when selected; `bg-inset text-ink-secondary hover:text-ink` otherwise), plus `[⇄ Rotate]` (`R`) and `[Zoom: Fit ▾]`.
    - **In Canvas mode**: shows checked size chips (`flex items-center gap-1.5 flex-wrap`) with a `"+ Sizes"` popover button (`SlidersHorizontal size={13}`) where the user checks/unchecks which sizes appear on the board (saved per source in `localStorage`).
  - **Right — Auto-refresh & Scroll sync toggles**:
    - **Auto-refresh checkbox/switch**:
      - Label: `"Refresh automatically when files change"` (`text-[12px] text-ink-secondary`).
      - Default: **On** for project files; **Off** for web addresses.
      - When active and watching, shows a `size-1.5 rounded-full bg-success` indicator dot.
    - **In Canvas mode only — Scroll sync toggle**:
      - Label: `"Sync scroll"` (`text-[12px] text-ink-secondary`, off by default).

---

### 5.3 Single Mode (`PreviewScreen` → `mode === "single"`)

- **Stage container**: `relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-auto bg-app p-6`.
- **Frame wrapper**:
  - Uses `ResizeObserver` on the stage container (with `24px` padding) to compute `scale` when Zoom is `"fit"`, or applies `0.5`, `0.75`, `1.0` when fixed zoom is selected.
  - Smooth dimension transitions when switching size tabs or rotating: `transition-[width,height] duration-200 ease-out` (disabled under `prefers-reduced-motion: reduce`).
- **Bottom status pill** (`mt-3 flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[11.5px] text-ink-secondary`):
  - `"iPhone 15 / 16 · 393 × 852 · 100% · Press [ or ] to switch size, R to rotate"`

---

### 5.4 Canvas Mode (`PreviewCanvas.tsx`, ported from `#gerer-wavez/src/editor/CanvasBoard.tsx`)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  .canvas-board (radial dot grid: 1px #333333 every 22px on #070707)                                        │
│                                                                                                            │
│   iPhone 15 / 16 · 393×852  [⇄]       iPad mini · 744×1133  [⇄]          Laptop · 1280×800  [⇄]           │
│   ┌─────────────────┐                 ┌──────────────────────────┐        ┌─────────────────────────────┐  │
│   │                 │                 │                          │        │                             │  │
│   │   Live Frame 1  │                 │       Live Frame 2       │        │         Live Frame 3        │  │
│   │                 │                 │                          │        │                             │  │
│   └─────────────────┘                 └──────────────────────────┘        └─────────────────────────────┘  │
│                                                                                                            │
│                                                                                  ┌──────────────────────┐  │
│                                                                                  │ [−] [ 64% ] [+] [⛶] │  │
│                                                                                  └──────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Exact Board Math & Styling (ported from `#gerer-wavez`)
- **Viewport (`div.canvas-board`)**:
  - `position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: default;`
  - Background:
    ```css
    background:
      radial-gradient(circle, var(--color-hairline) 1px, transparent 1.2px) 0 0 / 22px 22px,
      var(--color-app);
    ```
  - When `spaceDown || dragging`: `data-panning="true"` sets `cursor: grab !important` on `.canvas-board` and all children.
- **Plane (`div.canvas-plane`)**:
  - `position: absolute; left: 0; top: 0; transform-origin: 0 0;`
  - `transform: translate(${view.x}px, ${view.y}px) scale(${view.k})`
  - Artboard layout: horizontal row in size order (Phone → Tablet → Laptop → Desktop → Custom) with `GAP = 120` board units between artboards.
  - `width = sum(artboard.width) + 120 * (count - 1)`
  - `height = max(artboard.height) + 48`
  - `fit()` calculation: `pad = 48`, `MIN = 0.1`, `MAX = 4`:
    `k = clamp(Math.min((clientWidth - 96) / width, (clientHeight - 96) / height))`
    `x = (clientWidth - width * k) / 2`, `y = (clientHeight - height * k) / 2`.
- **Artboard (`section.canvas-artboard`)**:
  - `position: absolute; top: 0; display: flex; flex-direction: column; gap: 12px;`
  - **Counter-scaled Header (`header`)**:
    - `display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 36px; color: var(--color-ink-secondary); white-space: nowrap;`
    - `style={{ fontSize: 14 / Math.max(view.k, 0.35) }}` — keeps artboard labels legible even when zoomed out to `20%`.
    - **Title button**: `"{Preset Label} · {width}×{height}"` (e.g., `"iPhone 15 / 16 · 393×852"`). Hover underlines and turns `var(--color-ink)`. Clicking opens that size in **Single mode** (`title="Open iPhone 15 / 16 in Single view"`).
    - **Header controls**: Rotate button (`RotateCcw`, swaps `width`/`height` for that artboard) and single-artboard Screenshot button (`Camera`).
  - **Artboard Frame (`div.canvas-artboard-frame`)**:
    - `position: relative; overflow: hidden; width: box.w; height: box.h;`
    - `box-shadow: 0 0 0 1px var(--color-hairline), 0 18px 48px rgba(0, 0, 0, 0.45);`
    - Primary/active artboard gets `data-primary="true"` with `box-shadow: 0 0 0 2px var(--color-accent-border), 0 18px 48px rgba(0, 0, 0, 0.45)`.
- **Performance Cap: At Most 6 Live Frames**:
  - At most **6** artboards mount a live `<PreviewFrame>` (`<webview>` or `<iframe>`) simultaneously.
  - When a user selects 7 or more sizes (e.g., all 8 presets), the first 6 in the active LRU list are **Live**, and artboards 7+ render in **Snapshot mode**:
    - Displays the most recent captured PNG snapshot of that size (or a clean dark card showing the size dimensions if not yet captured).
    - Artboard header displays an amber pill badge: `"Snapshot · hover or click for live view"` (`rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-warning`).
    - Hovering the artboard for `150ms` or clicking/focusing it promotes it into the 6-frame live pool and snapshots the least-recently-used live frame before unmounting its `<webview>`/`<iframe>`.
- **Bottom-Right Zoom HUD (`div.canvas-zoom`)**:
  - `position: absolute; right: 12px; bottom: 12px; z-index: 5; display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--color-panel); border: 1px solid var(--color-hairline); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);`
  - Buttons (`min-width: 28px; height: 26px; border-radius: 5px; font-size: 11px; color: var(--color-ink-secondary)`):
    1. **Zoom out** (`Minus size={13}`, `aria-label="Zoom out"`, `zoomAt(1 / 1.25)`)
    2. **100% readout** (`className="mono min-w-[46px] tabular-nums"`, `aria-label="Zoom to 100%"`, `title="Zoom to 100%"`, displays `{Math.round(view.k * 100)}%`)
    3. **Zoom in** (`Plus size={13}`, `aria-label="Zoom in"`, `zoomAt(1.25)`)
    4. **Fit all** (`Maximize size={13}`, `aria-label="Fit all artboards"`, `title="Fit all artboards (Shift+0)"`, calls `fit()`)

---

### 5.5 Share to Chat (`SharePreviewModal.tsx`)

Triggered by clicking **`"Share to chat…"`** in the Preview page header.

```
┌──────────────────────────────────────────────────────────┐
│  Share preview to chat                               [✕] │
│  Send screenshots so a bot or room can review them.      │
│                                                          │
│  What to capture                                         │
│  (•) Current size (iPhone 15 / 16 · 393×852)             │
│  ( ) All selected sizes (4 screenshots)                  │
│                                                          │
│  Capture area:  [ Visible area  |  Full page ]           │
│                                                          │
│  Send to                                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ [🐭 Z]  Z · Senior UI/UX Designer               [✓]│  │
│  │ [🐭 SoSo]  SoSo · Staff Full-Stack Engineer        │  │
│  │ [🐭🐭 Product Expansion]  Room · 5 bots            │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Note (optional)                                         │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Check the spacing on the mobile header…            │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│                              [ Cancel ]  [ Send to Z ]   │
└──────────────────────────────────────────────────────────┘
```

- **Modal container**: `fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4`, inner card `w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-card p-5 shadow-2xl shadow-black/70 animate-pop-in`.
- **Browser session fallback**: Because native `webContents` screenshots require the Electron desktop app (except for image/Markdown previews which can be attached directly), in browser sessions for external URLs the modal shows a helper banner: `"Page screenshots work in the Gerer Build Studio desktop app. You can still share the preview link and your note to chat."`

---

## 6. Every State & Exact On-Screen Copy

All copy avoids developer jargon (`localhost`, `iframe`, `X-Frame-Options`, `webview`, `CSP` are translated to plain words).

### 6.1 Empty State
- **Quick Preview Panel**:
  - Icon: `MonitorSmartphone size={22} className="mb-3 text-ink-secondary/60"`
  - Heading (`text-[13px] font-medium text-ink`): `"Preview a page or file"`
  - Body (`mt-1 text-[12px] leading-5 text-ink-secondary`): `"Enter a web address above, choose a file from a project folder, or drop an HTML, PDF, Markdown, or image file here."`
- **Full Preview Page**:
  - Card (`max-w-[460px] rounded-2xl border border-hairline/40 bg-panel p-6 text-center`):
  - Heading (`text-[16px] font-semibold text-ink`): `"See your work at any screen size"`
  - Body (`mt-1.5 text-[13.5px] leading-relaxed text-ink-secondary`): `"Paste a web address or pick an HTML page, PDF, image, or Markdown document from one of your project folders. Check one size up close or compare phone, tablet, and desktop side by side on the canvas."`
  - Quick actions (`mt-4 flex flex-wrap justify-center gap-2`):
    - Button 1 (`bg-accent text-white rounded-lg px-3.5 py-2 text-[13px] font-medium`): `"Choose a project file…"`
    - Button 2 (`bg-raised text-ink rounded-lg px-3.5 py-2 text-[13px] font-medium hover:bg-raised-hover`): `"Paste a web address"`

### 6.2 Local / Internal Address Confirmation State (`state === "confirm"`)
- Icon: `AlertTriangle size={20} className="mb-3 text-warning"`
- Heading (`text-[13px] font-medium text-ink`): `"{pendingLocalUrl} is running on this computer or your local network."`
- Body (`mt-1 text-[12px] leading-5 text-ink-secondary`): `"Only open local pages you trust."`
- Actions (`mt-3 flex items-center gap-2`):
  - Secondary (`rounded-lg border border-hairline/50 px-3 py-1.5 text-[12px] font-medium text-ink-secondary hover:text-ink`): `"Cancel"`
  - Primary (`rounded-lg bg-warning px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110`): `"Show preview"`
- Header indicator while loaded: amber pill `<AlertTriangle size={11} /> Local page` (`text-[10.5px] text-warning`).

### 6.3 Loading State (`state === "loading"`)
- Overlay inside each frame: `absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-panel/80 backdrop-blur-[2px]`
- Spinner: `Loader2 size={20} className="animate-spin text-accent"`
- Label (`text-[12px] text-ink-secondary`): `"Loading preview…"`

### 6.4 Blocked-Site State (`state === "blocked"` — Browser `<iframe>` embedding blocked)
- Triggered when a web page refuses iframe embedding in browser sessions.
- Card inside frame (`max-w-[320px] rounded-xl border border-hairline/50 bg-card p-4 text-center`):
  - Icon: `ExternalLink size={20} className="mx-auto mb-2.5 text-warning"`
  - Heading (`text-[13.5px] font-semibold text-ink`): `"This website doesn't allow itself to be shown inside another page"`
  - Body (`mt-1 text-[12px] leading-relaxed text-ink-secondary`): `"In a web browser, some sites block side-by-side previews. You can open it in a new browser tab, or use the Gerer Build Studio desktop app to preview any site."`
  - Actions (`mt-3.5 flex flex-wrap justify-center gap-2`):
    - Primary (`rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110`): `"Open in new tab"`
    - Secondary (`rounded-lg bg-raised px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover`): `"Retry"`

### 6.5 Error & Timeout States (`state === "error"`)
- Icon: `AlertTriangle size={20} className="mb-3 text-danger/80"`
- Copy by error reason:
  - **Empty input**: `"Enter a web address or choose a file to preview."`
  - **Invalid address**: `"That doesn't look like a valid web address. Try something like example.com or localhost:3000."`
  - **Unsupported scheme**: `"Only web addresses (http or https) and project files can be previewed."`
  - **Timeout (15 seconds)**: `"This page is taking too long to respond."`
  - **Unreachable / load failure**: `"Couldn't open this page — check that the address is spelled right and that the site is running."`
  - **Unsupported file type**: `"This file type can't be previewed yet. Choose an HTML, PDF, Markdown, or image file."`
  - **File outside registered project**: `"For your security, Preview only opens files inside your registered project folders."`
- Action button (`mt-3 rounded-lg bg-raised px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover`): `"Try again"`

---

## 7. Responsive Layouts at `1024px`, `1280px`, and `1920px`

### 7.1 Quick Preview Side Panel (`ChatView` / `GroupView`)
- **Below `1180px` (including `1024px`)**:
  - Inline panel (`hidden min-[1180px]:flex`) is hidden so the chat transcript never crushes below `624px`.
  - Renders as a slide-over drawer (`absolute inset-y-0 right-0 z-30 flex w-[400px] max-w-[88vw] shadow-2xl min-[1180px]:hidden animate-panel-in`) over a `bg-black/55` backdrop button (`aria-label="Close preview panel"`).
- **At `1280px` (`>= 1180px`)**:
  - Sidebar (`320px`) + Chat column (`560px`) + Quick Preview panel (`400px`) = `1280px` inline side-by-side.
- **At `1920px`**:
  - Sidebar (`320px`) + Chat column (`1200px`, transcript centered at `max-w-[900px]`) + Quick Preview panel (`400px`) = `1920px`.

### 7.2 Full Preview Page (`PreviewScreen.tsx`)

| Viewport Width | Sidebar Width | Preview Workspace Width | Header & Toolbar Layout | Single Mode Stage (`1440×900` Desktop preset) | Canvas Mode Default Set (`393 + 744 + 1280 + 1440 + 3×120 = 4217` board width) |
|---|---|---|---|---|---|
| **`1024px`** | `320px` (or `68px` when collapsed) | **`704px`** (`956px` if sidebar collapsed) | Two compact rows: Row A holds Back, `"Preview"`, Source bar (`min-w-[260px] flex-1`), Mode switch, and `"Share…"`; Row B scrolls size chips horizontally (`overflow-x-auto no-scrollbar`) and collapses `"Refresh automatically when files change"` to `"Auto-refresh"`. | Stage inner width `656px`; `1440×900` frame auto-fits at `scale = 0.455` (`656×410` px). | `fit()` computes `k = (704 - 96) / 4217 = 0.144`, centering all 4 default artboards cleanly with counter-scaled `14 / 0.35 = 40px` board-unit headers (`~14px` on screen). |
| **`1280px`** | `320px` | **`960px`** | Two rows with full labels; Source bar gets `480px`; all 4 default size tabs fit without scrolling. | Stage inner width `912px`; `1440×900` frame auto-fits at `scale = 0.633` (`912×570` px). `iPhone 15 / 16` (`393×852`) fits at `scale = 1.0` (`100%`) when window height `>= 980px`. | `fit()` computes `k = (960 - 96) / 4217 = 0.205`, showing all 4 default artboards side by side with room to pan/zoom. |
| **`1920px`** | `320px` | **`1600px`** | Spacious two-row bar; Source bar expands to `max-w-[680px]`; all size presets and full `"Refresh automatically when files change"` label visible at once. | Stage inner width `1552px`; `1440×900` Desktop frame renders at full **`100%` (`scale = 1.0`)** with zero downscaling. | `fit()` computes `k = (1600 - 96) / 4217 = 0.357`, making every artboard immediately readable at a glance. |

---

## 8. Keyboard Shortcuts & Accessibility

### 8.1 Keyboard Shortcuts
| Key | Surface | Action |
|---|---|---|
| `[` / `]` | Preview Page (Single mode, when not typing in an input) | Switch to previous / next size in the active size set |
| `R` | Preview Page (Single mode, when not typing in an input) | Rotate current size (`width ⇄ height`) |
| `=` or `+` / `-` | Preview Page (Canvas mode, when not typing) | Zoom canvas in (`×1.2`) / out (`÷1.2`) |
| `Shift + 0` | Preview Page (Canvas mode, when not typing) | Fit all artboards in viewport (`fit()`) |
| `Space + drag` | Preview Page (Canvas mode) | Pan canvas board (`cursor: grab`) |
| `⌘/Ctrl + scroll` | Preview Page (Canvas mode) | Zoom canvas around pointer |
| `Escape` | Quick Preview / Preview Page / Modals | Closes open dropdown or Share modal first; if none open on Preview Page, returns to active conversation |

### 8.2 Accessibility (WCAG AA)
- **Landmarks & Roles**:
  - Quick Preview panel: `<aside aria-label="Quick preview">`.
  - Full Preview page: `<main aria-label="Preview Studio">`, canvas viewport `role="region" aria-label="Preview canvas: all selected screen sizes"`, each artboard `<section aria-label="{Size Label} ({width} by {height} pixels)">`.
  - Recent URLs dropdown: `role="listbox" aria-label="Recent preview addresses"`.
  - Share modal: `role="dialog" aria-modal="true" aria-labelledby="share-preview-title"` with focus trap and focus return to trigger button on close.
- **Screen-reader announcements**:
  - Frame state changes (`Loading preview…`, `Preview loaded`, `Couldn't open this page`) announce via an `aria-live="polite"` status region.
- **Reduced motion**:
  - Under `@media (prefers-reduced-motion: reduce)`, frame size transitions and panel slide-in animations are instant.
