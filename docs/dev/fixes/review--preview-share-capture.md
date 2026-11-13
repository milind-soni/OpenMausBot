---
status: review
created: 2026-11-13
updated: 2026-11-13
scope: preview share capture
owner: SoSo
---

# Preview Markdown typography and eight-size sharing

Fix the two assigned residuals from `c1cc144` on `fix/preview-share`. Modal focus remains Z's responsibility.

- [?] `9d4f135b-b093-4c2f-8b97-6b1d4fde1826`: copy rendered typography into standalone PNG capture, including DIV headings, bold and tables — `src/lib/previewSharing.ts:17`.
- [?] `8fc3c43f-7d06-47d0-9c46-0068df5550b3`: collect all selected Markdown/image sizes directly from their project source, sequentially, before dispatch; no additional live preview frames — `src/lib/previewSharing.ts:107`, `src/components/PreviewScreen.tsx:306`.

Task statuses set to doing through the revision-checked task API. No direct task-file edits.

## Changes

- `8a994c6` — Heading exports inline the live computed font family, size, weight, line height, spacing and table layout. This includes ChatMarkdown's DIV headings; export no longer relies on absent Tailwind classes or h1/h2 selectors. The existing sanitized renderer, bold text, tables and raw-HTML escaping remain in use.
- `776b9f0` — All-size file capture reads the source once, then captures sizes sequentially. Markdown uses one temporary, offscreen ChatMarkdown root at a time; image capture draws directly to a bounded viewport-sized canvas. Neither path creates or promotes preview frames, so the canvas retains its existing six live cards and two placeholders.
- Captures are collected before the send is dispatched. A failed size rejects the whole operation and names the size and underlying error; missing handles are refused rather than silently omitted. Temporary Markdown roots are unmounted and removed in finally. Existing image-alt-text substitution, PNG area/dimension bounds and read-only project file routes are retained.
- Single live Markdown captures retain the visible document scroll offset; source-based all-size captures render each selected size from the start of the document. Full-document source captures measure the wrapping at each size before applying the existing export bounds.
- Modal focus code, canvas live-frame selection and server sandbox/containment checks are unchanged. Browser HTML/PDF link sharing remains unchanged.

## Verification

- `pnpm -s typecheck`, `pnpm -s test` (**352 tests in 45 files**) and `pnpm -s build` pass. Existing large-chunk advisory remains.
- Three batch unit regressions cover eight results in order with one active capture, rejection without a partial return on a later failure, and an empty-selection error.
- `scripts/testing/preview-share-regression.mjs`: five actual-Chrome regressions exercise the original UI flows. The single-size exported SVG retains the live heading's **600 weight / 16px size**, bold text and four table cells, with no raw heading/bold syntax. The resulting PNG was visually inspected.
- All eight Markdown and image attachments are produced in one intercepted send per share. Tests read each PNG's IHDR dimensions and check its size label. A DOM observer records exactly six live artboard cards throughout, zero added iframe/webview elements and no retained temporary capture stages.
- Injecting failure in the eighth capture for each file type leaves the modal open with a size-specific error, omits desktop-only guidance, removes temporary stages and sends **zero** partial messages.

Run the retained browser regression with an existing Playwright installation:

```sh
GBS_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node scripts/testing/preview-share-regression.mjs
# Add GBS_QA_HEADED=1 for visible Chrome.
```

Each run starts disposable harness/Vite ports, a fresh browser profile, a temporary project/data registry and an unavailable test engine. Every chat-send POST is intercepted before the harness; nonlocal browser requests are refused. Browser, servers and disposable data are removed in finally. No model turns, live data changes (apart from the two authorized task updates), dependency installation, main checkout edits, merges or pushes. Native Electron capture is outside these two repairs and remains untested here.
