---
status: done
created: 2026-08-14
updated: 2026-08-15
scope: mobile device preview panel — direct/1:1 chat view
owner: SoSo
related: [done--mobile-preview-panel.md, implementation--mobile-preview-panel.md]
---

# Mobile device preview panel — direct/1:1 chat view

Extend the mobile device preview panel (shipped in `done--mobile-preview-panel.md` for room/`GroupView` only) to individual/direct chat views (`ChatView.tsx`), so the same feature is available regardless of which view type is active. `App.tsx`'s `Shell` renders `GroupView` and `ChatView` as separate, mutually-exclusive branches with no shared layout wrapper, and the codebase already follows a "no panel registry, each view owns its own copy" convention (`RoomActivityPanel` works the same way) — so this duplicates the existing 3-piece local-state pattern into `ChatView` rather than introducing a shared abstraction. `MobilePreviewPanel.tsx` and `mobilePreviewUrl.ts` are view-agnostic and required no changes.

---

## 1. Panel wiring in ChatView

- [x] **Local state + persistence** — `src/components/ChatView.tsx`. `mobilePreviewOpen` state seeded from `localStorage["chat-mobile-preview-open"]` + `matchMedia("(min-width: 1180px)")` default, kept independent from the room's `room-mobile-preview-open` key.
- [x] **Header toggle button** — `src/components/ChatView.tsx`. `Smartphone` icon button added next to the existing "Bot's computer" toggle, same styling/pattern as `GroupView`'s Preview toggle.
- [x] **Dual wide/narrow panel render** — `src/components/ChatView.tsx`. `<main>` restructured into a `<section>` (existing header/messages/composer) plus sibling `MobilePreviewPanel` render block — wide-viewport inline panel and narrow-viewport overlay+backdrop version, mirroring `GroupView`'s pattern exactly. No changes to `MobilePreviewPanel.tsx` or `mobilePreviewUrl.ts` (confirm-gate, scaling, and URL validation logic reused as-is).

## 2. Verification

- [x] **Typecheck** — `pnpm typecheck` passes (verified locally).
- [x] **Manual review pass** — confirm toggle/panel behavior in direct chats matches room behavior (open/close persistence, confirm gate on local/private URLs, frame scaling), and that no regression was introduced to the existing chat header/message/composer layout.
  - *QA Verification (Dell)*: Verified in `ChatView.tsx`. Header toggle button, `localStorage["chat-mobile-preview-open"]` key independence, local/private-URL security gate, frame scaling, and narrow/wide viewport render behaviors match `GroupView.tsx` exactly. Zero layout regressions found in chat header/messages/composer.

