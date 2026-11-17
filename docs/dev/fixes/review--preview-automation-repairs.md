---
status: review
created: 2026-11-17
updated: 2026-11-17
scope: Preview automation reliability
owner: Yv
related: [review--bot-preview-testing.md]
---

# Repair the three Preview issues observed on Makets

Targeted repairs to shared Electron Preview browser behavior, authorized by the user. Solo implementation; no Makets changes.

- [?] Match whitespace consistently in text waits — `electron/preview-browser.mjs:145`.
- [?] Preserve useful isolated-world errors and detect disabled controls — `electron/preview-browser.mjs:63`.
- [?] Correct full-page capture without repeating sticky content; preserve viewport and debugger ownership — `electron/preview-browser.mjs:29`.
- [?] Verify with focused unit tests and isolated real Electron fixture checks.

## Verification

- `pnpm typecheck`, `pnpm build`, `git diff --check`: passed.
- Focused Preview tests: 30 passed in six files (browser, broker, evidence, sizes, frames and sharing).
- `node scripts/testing/preview-browser-repairs.mjs`: passed in an isolated real Electron webview on Retina. Checked Unicode prices; native, fieldset and ARIA disabled controls; all eight colored sections at their expected pixel coordinates in a 393 × 3384 capture; wide 800 × 1800 horizontal/vertical stitching; restoration after success, injected failure and cancellation; visible capture; retained debugger ownership.
- `node scripts/testing/preview-testing-regression.mjs`: passed, including form input, screenshots/evidence, viewport changes, session isolation, Stop/resume, active-page attachment and reload cancellation. Fake provider transport only; no paid model call or live storefront order.
- Visually inspected `.omb-scratch/preview-repairs/full-page.png`: all sections occur once, header/footer occur once, no repeated scrollbar.
- Full captures temporarily scroll and pin sticky/fixed overlays before restoring their original inline styles and scroll position in `finally`. Dynamic pages may load content on scroll. No viewport/device-emulation changes are made. Oversized, clipped or unscrollable captures produce an error.
- Trello sync pending: API returned `400 Workspaces are full`.
