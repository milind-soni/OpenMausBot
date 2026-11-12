---
status: doing
created: 2026-11-12
updated: 2026-11-12
scope: preview-qa-repairs
owner: SoSo
related: [qa-notes--preview-studio.md]
---

# Preview QA repairs

Implement Yv's five authorized repairs from Dell's reproduction notes. Z retains the canvas labels, dialog behavior, menu surfaces and responsive panel work.

- [?] Serve contained project resources with MIME types and preserve opaque HTML/SVG isolation — `server/previewFiles.ts:30`, `server/index.ts:1689`.
- [?] Render PDFs in the shared frame — `src/components/PreviewFrame.tsx:711`.
- [?] Share real images, formatted Markdown and honest browser page links — `src/components/PreviewFrame.tsx:179`, `src/components/PreviewScreen.tsx:277`.
- [?] Expose recovery for blocked browser sites — `src/components/PreviewFrame.tsx:540`.
- [?] Explain browser history limitations — `src/components/MobilePreviewPanel.tsx:399`, `src/components/PreviewScreen.tsx:620`.
- [ ] Dell: repeat functional and security QA in browser and desktop.

## Implementation notes

- Relative resources use an unguessable, in-memory project capability issued only by a trusted HTML read. Only GET on the capability route skips the origin check; Host validation, the registered-project check, canonical containment, type allowlist, 25 MB file limit and nosniff still apply. The capability cannot be used for another project or an ordinary API route. HTML and SVG retain the existing CSP sandbox with no allow-same-origin. PDF is the sole native-viewer exception at both server and frame layers.
- CSS, JavaScript/modules, common images and fonts have explicit MIME types. Styles/scripts/fonts stay out of the document picker. Capability asset responses permit CORS so opaque-origin module and font loads work; ordinary file/API responses do not.
- Browser page/PDF sharing sends a link and note with no fabricated attachment. The quick panel stages the link in the current conversation's composer without replacing its draft; Preview Studio sends it to the selected chat. Both explain that page screenshots require the desktop app. Native capture errors remain errors.
- Markdown PNGs rasterize sanitized rendered markup, including headings, bold and tables, rather than painting raw source. Remote Markdown images become explicit image-alt-text labels so cross-origin images cannot taint capture. Output area is capped at 8 million pixels, height at 8,000, with a 10-second capture timeout; image capture is capped at 1600 by 1200.
- Browsers do not reliably distinguish an embedding refusal from a successful cross-origin iframe load. A persistent, cautious recovery strip offers Open in new tab and Retry, plus Preview blank? to open the full recovery state. A timeout also exposes that state. A late load event cannot dismiss it. This intentionally avoids falsely announcing that a successfully embedded site is blocked.
- Browser Back/Forward controls are replaced by visible desktop-app wording. Reload and Open in new tab remain available. No unsafe access to cross-origin iframe history was added.

## Verification

- `pnpm -s typecheck`, `pnpm -s test` (345 tests in 45 files), and `pnpm -s build` pass. The existing large-chunk advisory remains.
- Server/proxy regressions cover opaque CSS, JS/module, image and font reads; MIME/nosniff/CORS; invalid capabilities and writes; traversal, escaping symlinks and unsupported types; retained HTML/SVG CSP; and GET/POST API refusal from preview origins.
- An isolated headed Chrome session loaded relative CSS, an SVG image and a module script through the Vite proxy in an opaque HTML frame while its API request failed. Inspected the rendered Markdown PNG (heading and bold text), the native PDF viewer (visible document text and page controls), and embedding-denial recovery against an X-Frame-Options: DENY fixture.
- Isolation: disposable data/registry with an unknown driver, separate harness/UI ports 8918/5218 and an ephemeral fixture port. No real provider calls, package install, main checkout edits, live ports or real ~/.gbs access. All owned browser/server processes and disposable data were removed.
- Desktop webview capture still needs Dell's runtime QA. Z's canvas labels, menu/dialog surfaces and focus/escape behavior, and responsive panel state remain outside this repair.

All implementation items await review; this document stays in doing while Dell's QA item remains open.
