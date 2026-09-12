# Web file previews

The Web chat embeds image and video cards, with first-page PDF, first-slide
PPTX, and compact spreadsheet thumbnails. Clicking opens a larger preview;
videos can also play inside the conversation. Both uploaded file cards and
bot-authored local file links use the existing message-authorized POST download
route. Uploaded images retain their gallery, with smaller uncropped thumbnails.
Each preview shows its source extension in the top-left corner, independently
of the accessible description or link label.

## Run an isolated fixture

```sh
pnpm install --frozen-lockfile
pnpm build
node --experimental-strip-types scripts/verify-file-preview.ts --built
```

Open the printed `previewUrl`. The launcher creates a temporary home, fake
engine, and conversation with a two-page PDF, two-sheet workbook, two-slide
presentation, and three-second video. It also creates bot workspace files and
links them in a scripted reply. No real model or user data is needed. Omit
`--built` to use the development server.

The launcher writes its URL, owning PID, data directory, persistent log path,
uploaded files, and `send`, `wait`, and `messages` results to
`evidence/chat-previews/fixture.json`. These machine-specific records remain
local and are excluded from commits. Stop the foreground launcher with Ctrl-C
to stop its owned server and remove its temporary data.

## Verify in the browser

1. Check the inline image/video and PDF/PPTX/XLSX thumbnails and their top-left
   extension badges. Open each uploaded card. Check PDF page 2, the workbook's Checks sheet,
   and presentation slide 2. Close each modal and repeat using the bot links.
2. Confirm the video stays paused until clicked, then play it in the chat and
   confirm playback time advances. Expand it and check the inline player pauses.
   Close the modal and confirm the chat remains usable.
3. Download a copy from a preview. The original file remains downloadable even
   when its preview cannot render.
4. Attach `scripts/testing/file-preview/japanese.pdf` through the composer,
   send it, and check Japanese glyphs in the rendered page.
5. Attach `scripts/testing/file-preview/corrupt.pdf`, send it, and open it.
   Confirm the error, Retry, download, and Close controls. Retry must settle
   back to an error. Closing restores focus to the original file button.
6. Repeat PDF controls at a 390 by 844 viewport; reset the override afterward.

Capture actual before/after screens using separate worktrees at the same base
commit. For the old version, copy only the fixture script and generated sample
helpers into that worktree, then run with `--baseline`. Unsupported video
uploads are skipped there. Do not copy production changes into the baseline.

## Focused automated checks

```sh
pnpm exec vitest run src/lib/file-preview.test.ts src/lib/load-file-preview.test.ts src/lib/preview-queue.test.ts src/components/AttachmentPreview.test.ts src/components/ChatMarkdown.test.ts server/attachments.test.ts server/message-file.test.ts server/file-preview.e2e.test.ts server/control-omb.test.ts
pnpm typecheck
pnpm i18n:check
```

The API test uploads and retrieves all four formats, compares original bytes
and MIME types, rejects an unrelated message, and checks the bot/user workspace
authority boundary. Parser tests use real workbooks and presentations, including
cached formula results, literal HTML text, truncation, and rejected ZIP input.

## Supported scope and limits

| Format | Preview |
| --- | --- |
| PDF | One page at a time, page controls, zoom, text for screen readers |
| MP4, WebM, MOV | Native browser video controls; codec support depends on the browser |
| XLSX, XLS, CSV, TSV, ODS | Sheet selection and a plain table of saved cell values |
| PPTX | Static slides, previous/next controls, slide text alternative |
| Legacy PPT or other files | Existing download behavior |

Spreadsheet previews do not recalculate formulas or reproduce charts and cell
formatting. PPTX fonts, unsupported shapes, animations, and transitions may
differ from PowerPoint. Password-protected PDFs display a download fallback.

Preview files are limited to 25 MiB. Spreadsheet output is bounded to 50 sheets,
500 rows, 100 columns, 4,000 characters per cell, and two million characters in
total; truncated cells and ranges are labeled. Presentations show at most 100
slides. Office parsing runs in a disposable worker with a 30-second timeout,
ZIP directory size checks, and output limits. ZIP entries are inflated in small
input chunks with actual byte accounting (25 MiB per part, 100 MiB total).
Output exceeding either the declared size or the budgets is rejected. The
Office parsers receive a rebuilt, stored-only ZIP of the validated parts, so
they never inflate the original archive themselves. These bounds reduce resource use;
they are not a general archive validation service.

PDF.js and its worker, CMaps, standard fonts, and WASM resources are bundled
locally. Office parsing and rendering are also local. No third-party document
viewer receives the uploaded bytes. SVG slides are displayed as image documents,
never inserted as HTML. URLs and workers are released when the modal closes.

Inline previews load near the viewport, with at most two thumbnail jobs running
at once. Leaving the viewport cancels queued work and releases preview bytes.
The streaming loader enforces the file-size limit even without Content-Length.

## Fixture provenance

`preview-pdf.ts` writes the small English PDF directly; `preview-office.ts`
generates the workbook and slides with the same format libraries used by tests.
The checked-in video is an FFmpeg test pattern:

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=24 -t 3 -c:v libx264 -pix_fmt yuv420p -movflags +faststart sample.mp4
```

The Japanese PDF was generated with ReportLab's `UnicodeCIDFont` using
`HeiseiKakuGo-W5`, exercising a CMap-backed Japanese font. The corrupt fixture
contains plain text instead of a PDF. All samples are synthetic.

See [current upstream verification and screenshots](evidence/chat-previews/README.md)
and the [earlier modal verification](evidence/file-preview/README.md).
