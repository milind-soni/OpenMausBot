# Implementation plan: Preview Studio

## Objective

Make previewing work-in-progress a first-class part of the app for every kind
of user: a web designer checking a layout, an author checking a formatted
chapter, a researcher checking a generated report.

Two surfaces:

1. **Quick preview (side panel).** This is the existing mobile preview,
   improved. It stays a fast, one-device check beside the chat.
2. **Preview page (new screen).** A full page that previews one thing at
   several sizes, either:
   - **one size at a time**, with a large, focused frame; or
   - **all at once in canvas mode**: every size side by side on a pannable,
     zoomable board, like the artboard canvas in `#gerer-wavez`
     (`gerer-wavez/src/editor/CanvasBoard.tsx`).

Out of scope for v1:
- Editing content inside the preview.
- Visual diffing between versions.
- Device-accurate rendering. User-agent spoofing and DPR emulation are listed
  as follow-ups.

## Current state

- `src/components/MobilePreviewPanel.tsx` (401 lines) shows a single
  `<webview>` (Electron only):
  - URL validation, with a confirm step for local and private addresses
  - URL history
  - three phone presets (`src/lib/mobileDevicePresets.ts`)
  - scale-to-fit
  - screenshot to the composer (visible area or full page)
- It is opened from `ChatView` and `GroupView`, and its open state is kept in
  localStorage.
- Screens are lazy-loaded in `src/App.tsx:18-19,75-81`.
- There is no preview in browser sessions (no `<webview>`). There is no
  tablet or desktop size, no rotation, and no way to preview a local file such
  as an HTML export, PDF, or image.

## Proposed changes

### Shared foundation
1. Rename the size data:
   - `src/lib/mobileDevicePresets.ts` becomes `src/lib/previewSizes.ts`.
   - Groups: Phone (iPhone SE, iPhone 15/16, Pixel), Tablet (iPad mini, iPad
     Pro 11"), Laptop (1280×800), Desktop (1440×900, 1920×1080).
   - Each size has rotate support and a "Custom size…" option.
   - Re-export the old names so existing imports keep working.
2. Add a `PreviewFrame` component that owns one frame:
   - Electron uses `<webview>`.
   - The browser uses a sandboxed `<iframe>`, with a clear notice when a site
     blocks embedding.
   - Shared: load, timeout, and error states; scale-to-fit; and screenshot
     (Electron).
3. Add `PreviewSource`, either a **web address** or a **file**:
   - Accepted files: HTML, PDF, images, and Markdown rendered with the
     existing `ChatMarkdown`.
   - Files are picked from a project folder or dropped onto the page.
   - Files are served through a read-only harness route scoped to registered
     projects.
   - This is what makes preview useful to authors and researchers, not just
     web developers.
4. Add "Refresh automatically when files change". The harness watches the
   previewed file or project and pushes a reload event over the existing
   event stream. Off by default for web addresses.

### Quick preview (panel)
5. Rebuild `MobilePreviewPanel` on `PreviewFrame`:
   - A size picker covering all groups (phones first).
   - A rotate button.
   - Zoom: fit, 50%, 75%, or 100%.
   - Back, forward, and reload.
   - "Open in Preview page" carries the current source and size over.
6. Make it work in browser sessions through the iframe fallback.
7. Keep screenshots-to-chat. Add "Screenshot all sizes" on the Preview page
   only.

### Preview page (new screen)
8. Add a `PreviewScreen` (lazy-loaded) with its own sidebar entry, "Preview".
   It has:
   - a source bar (address or file, history, project picker)
   - a size set (checkboxes for which sizes to show; saved per source)
   - a mode toggle: **Single** or **Canvas**
9. **Single mode**:
   - one large frame
   - quick size tabs along the top
   - keyboard: `[` and `]` switch size; `R` rotates
10. **Canvas mode** (`PreviewCanvas`), ported from `CanvasBoard`:
    - Every selected size is a labeled artboard on one board.
    - Cmd/Ctrl + scroll or pinch zooms.
    - Scroll, Space-drag, or middle-drag pans.
    - "Fit all" and 100% buttons.
    - Clicking an artboard opens it in Single mode.
    - Scroll sync between artboards is optional, off by default.
    - Performance cap: at most 6 live frames. Beyond that, frames show
      snapshots and go live on hover or click.
11. **Share to chat**: send one or all sizes as screenshots to a chosen bot or
    room, with an optional note.
12. Persist the last source, the size set, the mode, and the canvas
    zoom/position per source. Use localStorage, following
    `mobilePreviewState.ts`.

### Bots
13. Add an agents-tool `open_preview { source, sizes?, mode? }` so a bot can
    say "I've opened the result in Preview" after building something. It
    takes effect only when the user has the app open. It never navigates
    without the same local/private-address confirmation.

### Documentation
14. User guide: `docs/guide/preview.md`, written in plain language for
    designers, writers, and researchers.
15. Update `docs/dev/plans/implementation--mobile-preview-panel.md` with a
    "superseded by" link.

## Verification

- Unit tests:
  - the size catalog (rotation, custom-size bounds)
  - `PreviewSource` validation (addresses, file types, project scoping)
  - canvas fit/zoom math, ported with tests from Wavez
- Server tests: the file route rejects paths outside registered projects,
  symlink escapes, and unsupported types.
- Manual (Dell):
  - desktop app and browser
  - panel at 1180px and narrower, plus the overlay mode
  - Preview page at 1024, 1280, and 1920 wide
  - 6+ sizes in canvas mode
  - local dev server, a public site, a site that blocks embedding, an HTML
    file, a PDF, and a Markdown file
  - auto-refresh on file save
  - screenshots to chat

## Risks and rollback

- **Memory and CPU with many live webviews.** Mitigated by the live-frame cap
  and snapshot fallback.
- **Sites that block iframes in browser sessions.** Show a clear message with
  an "Open in desktop app / new tab" option.
- **File route security.** Read-only, project-scoped, realpath-checked, and
  using the same request guard as the existing project routes.
- **Rollback.** The Preview page is additive behind its sidebar entry. The
  panel rewrite can be reverted on its own.

## Approval

Status: awaiting user approval
