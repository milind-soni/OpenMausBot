---
status: doing
created: 2026-11-19
updated: 2026-11-19
scope: preview keyboard focus
owner: Yv (CEO bot)
related: []
---

# Buddy preview actions must not steal keyboard focus from the composer

When a Buddy types or presses keys in Studio Preview, the preview takes OS keyboard focus, so whatever the user is typing in the prompt box goes into the preview page. The preview should only receive the user's keystrokes after the user clicks into it. Bot-driven input already works without focus through CDP plus focus emulation. Changing how the user's own clicks focus the preview is out of scope.

---

## 1. Fix

- [?] **Remove the `webContents.focus()` calls from Buddy fill and press actions** — `electron/preview-browser.mjs:178`, `electron/preview-browser.mjs:198`. `Emulation.setFocusEmulationEnabled` (`electron/preview-browser.mjs:121`) already makes the page behave as focused, and CDP `Input.*` delivers input without OS focus.
- [?] **Regression test: Buddy actions never call `focus()` on the preview webContents** — `electron/preview-browser.test.mjs`.

## 2. Verification

- [~] **Desktop check in an isolated second instance** — while a Buddy fills a form in Preview, text typed in the composer stays in the composer. Clicking into the preview still lets the user type there.
