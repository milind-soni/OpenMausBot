# Implementation plan: mobile device preview panel (v1)

> **Status:** Superseded by [`docs/dev/plans/implementation--preview-studio.md`](./implementation--preview-studio.md) (Preview Studio: expanded quick preview panel + full Preview page with Single and Canvas modes).

## Objective

Add a sidebar-toggled panel that renders an arbitrary URL inside fixed mobile device-frame viewports, so a user can sanity-check a page on a few common phone sizes without leaving the app.

In scope for v1: single URL input, 3 fixed mobile presets (iPhone SE, iPhone 14 Pro, one Android reference), one device frame visible at a time, toggle from the room sidebar following the existing activity-panel pattern, empty/loading/loaded/error states (including timeout).

Out of scope for v1: multi-device simultaneous preview, interaction mirroring/sync across frames, element inspector, screenshots/recording, tablet/desktop presets, side-by-side device rows. These are the fuller Responsively-style feature set and will be scoped as follow-up plans once v1 ships and is reviewed.

## Current state

- **Panel/toggle pattern**: `src/components/RoomActivityPanel.tsx` is a presentational `<aside>` fixed at `w-[320px]`. It is toggled from `src/components/GroupView.tsx` via local `useState` seeded from `localStorage` (`room-activity-open`) and a `window.matchMedia("(min-width: 1180px)")` default, not a global reducer action:
  ```tsx
  const [activityOpen, setActivityOpen] = useState(() => {
    const saved = localStorage.getItem("room-activity-open");
    return saved === null ? window.matchMedia("(min-width: 1180px)").matches : saved === "true";
  });
  ```
  It renders twice: a permanent flex column at `min-[1180px]:flex`, and an overlay+backdrop below that breakpoint. Both are gated by `{activityOpen && (...)}` at `GroupView.tsx:334-358`. There is no shared panel registry — every panel (`RoomActivityPanel`, `ComputerPanel`, `SettingsPanel`, `PluginsPanel`, `AppSettingsPanel`) is manually imported and conditionally rendered by its owning view.
- **State management**: plain React Context + `useReducer` (`src/state/store.tsx`), no zustand/redux. Global cross-component toggles (`toggleComputer`, `toggleSettings`) go through the reducer; view-scoped panel visibility (`activityOpen`, `bulletinOpen`) stays as local `useState` + direct `localStorage` writes. This panel is view-scoped (opened from the room header, like activity), so it follows the local-state pattern, not the reducer.
- **No preview/embed mechanism exists today**: searched `electron/`, `dist-server/`, `server/`, `src/` for `webview`, `BrowserView`, `WebContentsView`, `<iframe`, CSP/X-Frame-Options handling — zero hits. The app is Electron (`electron/main.mjs`, `preload.cjs`) with a single `BrowserWindow`, `contextIsolation: true` (`electron/main.mjs:112-129`), and `webviewTag` currently unset (defaults off). The closest analog, `ComputerPanel.tsx`, previews content by polling PNG screenshots into an `<img>`, not by embedding live content — not reusable here since we need an interactive, live-navigating viewport.
- **Implication**: a plain `<iframe>` will break on most real sites due to `X-Frame-Options`/CSP sent by the target site. Electron's `<webview>` tag renders the guest in its own process/guest context and is not subject to the host page's embedding restrictions the way an iframe is, so it is the only viable v1 approach — but it requires enabling `webviewTag: true` in `BrowserWindow` webPreferences, which is currently off and is a security-relevant change.

## Proposed changes

1. **Enable and harden the `<webview>` surface** (`electron/main.mjs`)
   - Set `webviewTag: true` on the `BrowserWindow` webPreferences.
   - Add a `will-attach-webview` handler on the window's `webContents` that overwrites (not merges) the guest's `webPreferences` before attach: force `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `preload: undefined`. This runs regardless of what the renderer requests, so a compromised/careless renderer can't loosen it.
   - Block `will-navigate` and `new-window`/`setWindowOpenHandler` on the guest: no top-level navigation out of the preview, no popped windows. Attempted navigations are redirected into the same preview frame's `loadURL` instead.
   - On the `<webview>` tag markup itself: `nodeintegration="false"`, `allowpopups="false"`, no `disablewebsecurity`, no `preload`.

2. **URL validation before it reaches the webview** (new `src/lib/mobilePreviewUrl.ts`)
   - Parse and allow only `http:`/`https:` schemes; reject `javascript:`, `file:`, `data:`, `chrome:`, and anything else with an inline error, no navigation attempt.
   - Detect `localhost`/private-IP-range/loopback hosts and pass a boolean flag up to the UI. Per Angel's review, a passive notice was not sufficient — local/private results route to an explicit `confirm` state (Cancel / Continue anyway) and the webview only navigates after the user clicks through. Not blocked outright, since local dev preview is a legitimate use case for this tool, but it requires deliberate acknowledgment rather than a badge someone can glance past. Note: only the *initial* `loadUrl` is checked — in-page navigation within an already-loaded guest to a private host is not re-validated (v1 scope; flagged as a known gap, not assumed covered).

3. **Device preset constants** (new `src/lib/mobileDevicePresets.ts`)
   - Document exact values instead of inlining magic numbers:
     - iPhone SE: 375×667 @2x
     - iPhone 14 Pro: 393×852 @3x
     - Android reference (Pixel 7): 412×915 @2.6x
   - Each preset exports `{ id, label, width, height, dpr }`.

4. **`MobilePreviewPanel` component** (new `src/components/MobilePreviewPanel.tsx`)
   - `<aside>` sized independently from the activity panel — target ~375-420px so one device frame fits without cropping (confirmed with @Dell: no fixed-width registry forces 320px, panels size themselves).
   - Header: URL input, device preset selector (pill/tab row, one frame visible at a time for v1).
   - Preview area: fixed-size wrapper around the `<webview>` matching the selected preset's CSS px (using width/height, not DPR — DPR is documented for reference/future screenshot work but not applied via `zoomFactor` in v1 to keep behavior predictable).
   - States:
     - `empty` — no URL entered yet.
     - `loading` — from navigation start until `dom-ready`/`did-finish-load`.
     - `loaded` — normal display.
     - `error` — triggered by `did-fail-load`, or by a client-side timeout (~15s with no `dom-ready`/`did-finish-load`) so a hanging site doesn't spin forever.
   - Local/internal-address confirm gate rendered per item 2 when applicable.
   - Preview area scales the device frame down (via `ResizeObserver` measuring available space + CSS `transform: scale`) to fit the panel's height rather than overflowing/scrolling; the header (URL input + preset row) is kept to a single compact block so it doesn't eat into frame space.

5. **Sidebar integration** (`src/components/GroupView.tsx`)
   - Add a `mobilePreviewOpen` local `useState`, seeded from `localStorage` (`room-mobile-preview-open`) mirroring the `activityOpen` pattern exactly, including the same `min-width: 1180px` default and overlay-below-breakpoint behavior.
   - Add a header toggle button (device/phone icon) next to the existing Activity button.
   - Conditionally render `MobilePreviewPanel` alongside `RoomActivityPanel` using the same wide/narrow dual-render approach.

## Verification

- **Automated**: `pnpm typecheck` after each change group; no existing test suite covers Electron main-process webPreferences, so webview hardening is verified manually (see below) rather than by unit test.
- **Manual — webview hardening**:
  - Confirm `webviewTag` guests cannot `require('electron')` or access Node globals (`process`, `require`) from the loaded page's devtools console.
  - Attempt navigation to a `javascript:` URL and a `file://` URL via the input — both must be rejected client-side before reaching the webview.
  - Click a link on a loaded page designed to open `target="_blank"` — confirm no new window is created and no top-level navigation occurs.
- **Manual — states**: load a normal site (loaded state), a nonexistent domain (error via `did-fail-load`), a URL from a host that accepts but never responds (error via timeout), and `localhost:<devserver>` (local-address notice).
- **Manual — layout**: verify panel width/behavior at both wide (≥1180px) and narrow window widths, and that it coexists with the activity panel toggle without layout collision.
- **Manual — presets**: visually confirm each of the 3 device frames renders at its documented CSS px dimensions.

## Risks and rollback

- **Security**: enabling `webviewTag` widens the app's attack surface if hardening in step 1 is incomplete. Mitigated by enforcing guest `webPreferences` in the main process (not just the tag attributes, which a compromised renderer could alter) and by scheme allowlisting before any URL reaches the guest. @Angel to review the hardening specifically before this ships past `review--`.
- **Security (scope of `webviewTag`)**: `webviewTag: true` is set at the `BrowserWindow` level, so it's enabled for the entire renderer, not scoped to this panel. `will-attach-webview` re-locks every guest's `webPreferences` regardless of origin, which covers the sharp edges, but if the app ever has an XSS elsewhere, that surface could now spawn a sandboxed webview too — hardening makes the blast radius small, not zero. Flagged by Angel; accepted as a known v1 tradeoff rather than scoping `webviewTag` per-panel (which Electron doesn't support per-instance without a second `BrowserWindow`).
- **Scope creep**: Responsively-style multi-device sync is explicitly deferred; this plan only covers single-frame preview so the review surface stays small.
- **Rollback**: the feature is additive (new files, one new header button, one new webPreferences flag). Reverting is a straightforward revert of the panel/toggle commit(s) and the `webviewTag`/`will-attach-webview` changes in `electron/main.mjs`.

## Approval

Status: approved by Sandy (CEO) 2026-08-14. Implementation tracked in `docs/dev/fixes/doing--mobile-preview-panel.md`.
