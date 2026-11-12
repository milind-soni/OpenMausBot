---
status: doing
created: 2026-11-12
updated: 2026-11-12
scope: preview studio
owner: Z
related: [done--mobile-preview-panel.md, done--mobile-preview-panel-chat-view.md]
---

# Preview Studio: better quick preview and a full Preview page with canvas mode

Implements `docs/dev/plans/implementation--preview-studio.md`. Design work starts now. Code starts after plan approval.

---

## 1. Design

- [?] **Design the quick preview panel and the Preview page** — Z. Cover:
  - the source bar (address or file)
  - the size picker
  - Single vs Canvas mode
  - artboard labels
  - zoom controls
  - share-to-chat
  - empty, error, and blocked-site states

  Reference the canvas in `#gerer-wavez` (`src/editor/CanvasBoard.tsx`). Deliver specs in `docs/design/preview-studio.md`.

## 2. Foundation

- [?] **Size catalog** — `src/lib/mobileDevicePresets.ts:12` becomes `src/lib/previewSizes.ts`. Groups: phone, tablet, laptop, desktop. Supports rotate and custom sizes.
- [?] **PreviewFrame** — Uses `<webview>` in the desktop app and a sandboxed `<iframe>` in the browser. Shared load, error, and screenshot handling.
- [?] **File previews** — Show HTML, PDF, images, and Markdown from registered projects through a read-only, project-scoped harness route.
- [?] **Auto-refresh on file change** — The harness watches the previewed file and pushes a reload event over SSE.

## 3. Quick preview panel

- [?] **Rebuild on PreviewFrame** — `src/components/MobilePreviewPanel.tsx`. Adds all sizes, rotate, zoom, back/forward/reload, "Open in Preview page", and browser-session support.

## 4. Preview page

- [?] **PreviewScreen with Single mode** — Add a new sidebar entry and lazy-load the screen in `src/App.tsx:18`.
- [?] **Canvas mode** — Port the pan/zoom board from Wavez. Cap at 6 live frames, with snapshots beyond that.
- [?] **Share to chat** — Send one size or all sizes as screenshots to a bot or room.
- [ ] **Bot tool `open_preview`** — `server/drivers/agents-proxy.ts` *(Optional per plan; deferred for a follow-up PR so the core Preview Studio UI and read-only harness routes stay focused).*

## 5. Docs and QA

- [?] **User guide** — `docs/guide/preview.md`.
- [ ] **QA matrix** — Dell. Run the plan's verification list in both the desktop app and the browser.

---

## Implementation Notes (Z)

- **Spec compliance:** Built directly from `docs/design/preview-studio.md` and `docs/dev/plans/implementation--preview-studio.md`.
- **Optional `open_preview` bot tool:** Left `[ ]` per instructions so the core UI, canvas mode, file preview routes, and auto-refresh watcher remain self-contained.
- **Browser screenshot fallback:** In browser sessions (where Electron's `window.gbs.previewScreenshot` is unavailable) or when capturing Markdown/image previews, `PreviewFrame.captureScreenshot` renders a clean PNG snapshot via an offscreen `<canvas>` so **Send to chat** and **Share to chat…** work in both desktop and browser sessions.
