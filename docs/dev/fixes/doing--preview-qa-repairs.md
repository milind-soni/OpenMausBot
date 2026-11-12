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

- [~] Serve contained project resources with MIME types and preserve opaque HTML/SVG isolation — `server/previewFiles.ts:38`, `server/index.ts:1686`.
- [~] Render PDFs in the shared frame — `src/components/PreviewFrame.tsx:760`.
- [~] Share real images, formatted Markdown and honest browser page links — `src/components/PreviewFrame.tsx:245`, `src/components/PreviewScreen.tsx:275`.
- [~] Expose recovery for blocked browser sites — `src/components/PreviewFrame.tsx:570`.
- [~] Explain browser history limitations — `src/components/MobilePreviewPanel.tsx:367`, `src/components/PreviewScreen.tsx:592`.
- [ ] Dell: repeat functional and security QA in browser and desktop.
