# Spaces: a multi-bot canvas for the desktop app

Status: approved design, not yet implemented
Date: 2026-09-03

## Summary

Spaces is an opt-in second view of the bots you already have. Instead of one
chat beside a sidebar, every bot gets a card on a single zoomable canvas. Zoom
out and you see the whole workspace at once, like Mission Control; zoom in and
one card fills the screen with its neighbours peeking past the edges, and you
slide between bots the way you slide between desktops.

Nothing about the existing shell changes. Spaces is a rendering of state the
client already holds, reachable only after the user turns it on.

## Goals

- One canvas holding a live card per bot and per room.
- Two states — grid and focus — that are the same layout at two zoom levels.
- A floating composer that always addresses the focused bot, with `@` to
  redirect anywhere.
- Ambient awareness: status chips on every card, toasts when a bot you are not
  watching finishes something.
- Off by default. Available only after an explicit opt-in in Settings.

## Non-goals

- Real per-bot `BrowserWindow`s. A later phase may add a "detach this bot"
  action; v1 is one window.
- Free-form card positioning. Spaces is a grid, not a desk.
- Replacing the sidebar shell. Spaces is a place you visit.

## Decisions and their rationale

**Simulated canvas, not real OS windows.** The reference interface has no
traffic lights, no title bars, and one global input; it is a canvas that
resembles a window manager. Real windows would cost N renderers, cross-window
store sync, and per-window state persistence, and the grid view would have to be
simulated anyway because macOS does not let an app tile its own Mission Control.
A "detach this bot into its own window" action is deliberately deferred to a
later phase.

**A mode you enter and leave.** The Settings toggle unlocks Spaces; it does not
replace the shell. The sidebar view stays the default and stays mounted
underneath, so leaving is instant and every existing surface — Settings,
Routines, Browser workspace, Team Map — keeps its current home.

**Grid and focus are one layout at two zoom levels.** All cards sit at fixed
positions in an R x C grid. Both states are a single transform on the stage that
contains them:

    grid   ->  scale(fitAll)  translate3d(0, 0, 0)
    focus  ->  scale(1)       translate3d(-col * W, -row * H, 0)

The cell is sized so that a focused card occupies 65% of the viewport width and
75% of its height, matching the reference interface: at `scale(1)` the adjacent
columns land just past the edges, which is what produces the peeking neighbours
without any separate treatment. Columns are `clamp(2, floor(viewportWidth /
minCellWidth), 4)` and rows are `ceil(count / columns)`, so a narrow window
tiles two across and a wide one four. The grid scale is whatever fits all rows
and columns inside the viewport with a 48px margin, floored at 0.22 so cards
never become unreadable — past that floor the grid scrolls vertically instead of
shrinking further.

Sliding walks the grid in reading order: right along a row, wrapping down to the
start of the next. This is why the focused state shows neighbours to the left
and right only. Because one element transitions rather than N, the cost of a
transition is the same for six bots as for forty, and a card's position never
changes between the two views, so spatial memory holds.

**Every card is live.** Cards are real `ChatView` / `GroupView` instances:
scrollable, typeable, with working suggestion chips and inline artifacts. Cards
are always mounted and interactive; they are only *painted* when near the
viewport. See Performance.

**All visible bots, virtualized.** Population is `state.bots` filtered by
`!hidden`, concatenated with `state.groups`, in the sidebar's existing order.
No curation step, no cap, no silent reordering between visits.

**No new animation dependency.** The repo has deliberately avoided one
(`react`, `react-dom`, `react-markdown`, `lucide-react`, `qrcode.react`,
`tailwind-merge`). A single transformed stage needs only CSS transitions; toasts
and the artifact zoom use the Web Animations API.

## Architecture

### New modules, under `src/components/spaces/`

| Module | Responsibility |
|---|---|
| `SpacesShell.tsx` | Owns `mode` (`grid` \| `focus`) and the stage transform. The only stateful piece. |
| `SpacesStage.tsx` | Positions cards on the grid. Pure layout, no state. |
| `SpaceCard.tsx` | One card: chrome, status chip, and a live `ChatView`/`GroupView` or a snapshot. |
| `SpacesComposer.tsx` | The floating pill. Wraps the existing `Composer` with an identity chip and `@` picker. |
| `SpacesToasts.tsx` | Top-right background-activity stack. |
| `spaces-layout.ts` | Pure: grid dimensions from viewport and count, index <-> (row, col), transform for a state. |
| `spaces-nav.ts` | Pure reducer for navigation intents: next, prev, up, down, focus, grid, wrap and clamp rules. |
| `spaces-flip.ts` | `flipTo(fromEl, toEl)` — the one shared-element transition. |

The pure modules exist as separate files specifically so the real logic is
testable under `environment: "node"`, which is what the suite runs.

### Changes to existing files

- `src/lib/feature-flags.ts` — add `spacesEnabled(config)`, mirroring
  `builtInBrowserEnabled`.
- `src/state/store.tsx` (line ~348) — add `spaces?: boolean` to the `features`
  type.
- `src/components/SettingsModal.tsx` — the toggle, in the existing
  `experimental` section beside the browser and skill-recorder switches. No new
  settings surface.
- `src/App.tsx` — render `<SpacesShell>` as an overlay above the normal shell
  when open, leaving the sidebar shell mounted beneath it.
- `src/components/ChatView.tsx` — **the one real refactor.** Add
  `active?: boolean`, defaulting to `true` so every existing call site is
  unchanged. When `false`, skip global `window` keydown registration (line
  ~867), autofocus, and scroll-into-view. Twenty mounted ChatViews must not mean
  twenty Cmd-F handlers.

No new server fields, no new IPC channels, no protocol change.

## Interaction

### The focused card is `state.selectedId`

Spaces adds exactly one piece of local state: `mode`. The focused card is the
selected bot. Focusing dispatches the existing select action, so leaving Spaces
lands in that bot's normal chat with no reconciliation, and the sidebar
underneath was already correct.

### Navigation

| Input | Action |
|---|---|
| `Ctrl-Up` / pinch out | Focus -> grid |
| `Ctrl-Down` / pinch in / click a card / `Esc` | Grid -> focus |
| `Ctrl-Left` / `Ctrl-Right` | Previous / next in reading order |
| Two-finger horizontal swipe | Slide, tracking the finger, snapping on release |
| `Cmd-1`..`Cmd-9` | Jump to that card, extending the existing binding in `App.tsx` |
| `Esc` from focus | Leave Spaces |

macOS reserves genuine three-finger Spaces swipes for the OS; Electron never
receives them. Two-finger horizontal scroll arrives as `wheel` events with
`deltaX` and is what we bind. On a trackpad it feels near-identical. It is not
literally the same gesture, and the docs should not claim it is.

### Composer

`SpacesComposer` wraps the existing `Composer` rather than reimplementing it, so
attachments, queued messages, and voice work unchanged. It adds the bot identity
chip and the `@` picker. Typing `@` opens a bot list; choosing one sends through
that bot's normal path and slides the stage to it as the message lands — the
motion is the receipt. Each live card keeps its own inline composer; the pill is
the fast path, not the only path.

### Toasts

A subscriber watches `bot.activity` transitions and terminal assistant messages.
When a bot that is not focused settles, it pushes a toast. Rules that keep it
from becoming noise:

- At most three stacked.
- Four-second dismiss.
- Coalesced per bot: a second event replaces that bot's toast rather than
  stacking a new one.
- Suppressed entirely in grid mode, where the card itself is already visible.

Clicking a toast focuses that card.

### Status chips

Derived entirely from fields that already exist on `Bot`: `activity`
(`working` | `waiting-on-you` | `idle` | `no-signal` | `dead`), `unread`, and
`busy`. Rooms use the equivalent fields on `Group`.

### Artifact zoom-out

A FLIP transition via the Web Animations API: measure the artifact's rect inside
its card, mount the existing `BrowserWorkspace` at full size, animate a transform
from first rect to last, hand over. Reversed on dismiss. Confined to
`spaces-flip.ts`.

## Performance

The budget is the load-bearing constraint, because every card is live. The rule
is: **mounted and interactive always; painted only when near the viewport.**

- Off-screen cards get `content-visibility: auto` with `contain-intrinsic-size`
  matching the cell. The browser skips their layout, style, and paint while the
  DOM stays mounted, so clicking one is instant with no re-hydration, and forty
  cards cost roughly what six do to render.
- The stage gets `will-change: transform` during a transition, removed on
  settle. Leaving it on permanently pins every card into its own compositor
  layer.
- **Degradation is measured, not guessed.** `SpacesShell` samples frame timing
  over the first few transitions. If p95 frame time stays above 20ms, cards
  beyond the nearest nine swap to static snapshots, and a quiet line in Settings
  explains why. Everything-live stays the promise; it degrades on a machine that
  cannot hold it rather than stuttering for everyone.

## Failure modes

| Situation | Behaviour |
|---|---|
| Zero visible bots | Empty state on the canvas with a "New bot" action. Never a blank wallpaper. |
| One bot | Focus mode only. `Ctrl-Up` is a no-op; a one-cell grid is a worse view of one card. |
| A card throws | Per-card error boundary, reusing the `Component`-based boundary already in `ChatView`. One broken bot shows a failed tile, not a dead canvas. |
| Focused bot deleted while open | Focus moves to the next card in reading order; if none remain, back to grid, then to the empty state. |
| Flag turned off while open | The reducer closes the view on config change, exactly as `skill-recorder` does in `store.tsx` (~line 866). |
| Window resized or display changed | Grid dimensions recompute from the pure layout function. The focused bot stays focused; its cell moves. |
| `prefers-reduced-motion` | Transitions become instant cuts. The spatial model survives without the animation. |

## Testing

The suite runs `environment: "node"` with `renderToStaticMarkup`; there is no
jsdom and no testing-library. The test plan is shaped to that.

- `spaces-layout.test.ts`, `spaces-nav.test.ts` — the real coverage. Grid
  dimensions across viewport sizes and bot counts, index <-> cell round-tripping,
  transform math, wrap at row end, clamp at the ends, deletion while focused,
  the zero-bot and one-bot cases.
- `SpaceCard.test.ts` — `renderToStaticMarkup`, following the existing
  `ApprovalCard.test.ts` pattern: correct chip per `activity` value, unread
  state, group versus bot cards, live versus snapshot.
- `feature-flags` — `spacesEnabled` gating, beside the existing flag tests.
- `ChatView` — assert that `active: false` registers no global key handler,
  which is the regression that would otherwise appear only at twenty cards.

**What tests cannot cover:** transform smoothness, gesture feel, and the FLIP
zoom. `environment: "node"` cannot assert on animation. These are verified by
hand via `pnpm dev:desktop` before the work is called done. Green tests are not
evidence that the motion is right.

## Risks

- **The artifact zoom-out is the least predictable item**, because it couples
  Spaces to `BrowserWorkspace`. If scope must be shed to land sooner, cut this
  first; everything else is load-bearing for the feel.
- **The `ChatView` `active` refactor touches a 1400-line file** that every user
  sees. The default-`true` signature keeps existing call sites untouched, which
  is the mitigation, but the change deserves careful review.
- **v1 is large** — canvas, live cards, toasts, chips, rooms, FLIP zoom, and the
  ChatView refactor. It is buildable as specified. It is not small.

## Deferred

- Detaching a card into a real `BrowserWindow`.
- Broadcasting one instruction to several bots at once (overlaps rooms; needs
  its own confirmation and cost guard).
- Free-form card positioning.
