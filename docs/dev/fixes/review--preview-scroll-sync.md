---
status: review
created: 2026-11-13
updated: 2026-11-13
scope: preview scroll sync
owner: SoSo
---

# Web-only device previews and scroll sync

Task `d673a157-aecb-47c9-824c-0921c6ae23e2`, revision 3, based on main `44b94e3`.

- [?] `src/lib/previewScrollSync.ts:35`: desktop project HTML/external-page synchronization through webview APIs, cleaned-up polling and serialized/coalesced writes. Applied follower positions do not rebroadcast; navigation failures retry without spinning; disposal ignores late results.
- [?] `src/lib/previewSource.ts:4`: shared `isDeviceSource(source)` accepts URL or project HTML only, matching Z's inline predicate. Markdown synchronization removed entirely.
- [?] `src/components/PreviewScreen.tsx:69` and `src/components/PreviewCanvas.tsx:78`: non-HTML files use one full-screen viewer, bypassing Canvas, presets, rotation, scale and device keyboard shortcuts. Stored device preferences remain available for web content.
- [?] `src/components/PreviewFrame.tsx:194`: shared frame fills available space for non-HTML files (including Quick preview) and uses measured viewer dimensions for captures, regardless of caller device metadata. No device bezel.
- [?] `src/components/SharePreviewModal.tsx:110`: non-HTML sharing is a single file capture, with no multi-size choice or device-size caption on the Preview page. Browser PDFs retain an honest link/note fallback; they cannot provide a faithful screenshot. Markdown export retains formatted headings/bold/tables.
- [?] `scripts/testing/preview-scroll-regression.mjs:1`: isolated browser/second Electron verification and security smoke. `scripts/testing/preview-share-regression.mjs:1` updated to the new single-capture requirement, including failure/no-partial-send checks.
- [ ] Dell review after integration, including Z's Quick preview header controls.

## Verified results

- `pnpm -s typecheck`, `pnpm -s test`, `pnpm -s build`: pass; **435 tests in 53 files**. Focused helper/guard tests: 11 pass.
- Retained browser + actual Electron regression: pass. Six live artboards (eight selected sizes) for HTML and external websites follow either leader; sync-off stops followers. Guest sandbox/context isolation stay enabled, Node stays disabled.
- Browser Markdown/image/PDF ignore saved Canvas mode, rotation, preset and zoom; only one viewer mounts, no device controls appear on the Preview page, and sharing sends once. Browser PDF sends a truthful link. Quick preview's shared frame fills its panel without scaling.
- Five retained browser share regressions pass: formatted Markdown, single Markdown/image exports and error/no-send behavior.
- Security smoke: actual opaque-origin HTML fetches to `/api/bots` and a normalized traversal variant are refused in browser AND desktop. Raw/encoded dot-segment requests return 403 through both harness and Vite proxy. HTML/SVG CSP retain sandbox without `allow-same-origin`.
- Electron used throwaway home/profile/data paths and `--user-data-dir`, own `ELECTRON_START_URL`; harness/Vite/external fixture ports **56168/56169/56170**. All temporary state/processes removed. No paid/model turns or live data changes.

## Integration notes

`MobilePreviewPanel.tsx` is untouched as requested. Its header controls, footer device wording and share caption remain Z-owned; switch its inline predicate to `isDeviceSource` from `src/lib/previewSource.ts` at integration. The shared frame already enforces unscaled full-screen file rendering and captures for that panel.

Browser HTML/web sync is intentionally unavailable rather than weakening opaque-origin isolation. Visible guidance says to use the desktop app or scroll each preview separately. Only top-level page scrolling is synchronized; nested scrolling panels may scroll independently.
