# Inline previews on current upstream main

Captured on 2026-09-12 against `milind-soni/OpenMausBot` main `2f91c462`.
The after build is `d76d50d8`, with the preview proposal merged onto that base.
The before worktree contains only copied synthetic fixture helpers, not the
production preview changes. Both fixtures use temporary homes and fake engines.
The baseline rejects video uploads and uses its default fake response.

| Before | After |
| --- | --- |
| ![Download chips on upstream main](before.jpg) | ![Inline thumbnails with source-extension badges](after.jpg) |

| PDF page 2 | Spreadsheet Checks sheet |
| --- | --- |
| ![PDF page 2](pdf.jpg) | ![Excel sheet selection](excel.jpg) |

| PowerPoint slide 2 | 390px viewport |
| --- | --- |
| ![Second slide](powerpoint.jpg) | ![Narrow chat](mobile.jpg) |

## Observed behavior

- PDF, XLSX, PPTX, PNG, and MP4 badges appear at the top left, 8px inside
  thumbnail containers (9px including the image gallery border).
- Bot links render the PDF first page, spreadsheet cells, first slide, image,
  and video poster. Uploaded document cards use the same preview components.
- Both videos start paused at 0.1s, readyState 4. Clicking the bot video play
  control yields `paused: false`, `currentTime: 0.231424`, `controls: true`.
- PDF page 2, the workbook's Checks sheet, and slide 2 are accessible through
  their controls. Markup in a spreadsheet cell remains literal text.
- At a 390 by 844 viewport, document scrollWidth is 390; closing the slide
  preview returns focus to the originating file button.

## Commands and checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm i18n:check
pnpm exec vitest run src/lib/file-preview.test.ts src/lib/preview-queue.test.ts src/components/AttachmentPreview.test.ts src/components/ChatMarkdown.test.ts server/attachments.test.ts server/message-file.test.ts server/file-preview.e2e.test.ts server/control-omb.test.ts
pnpm exec vitest run src/lib/load-file-preview.test.ts
node --experimental-strip-types scripts/verify-file-preview.ts --built
```

Build (including both TypeScript checks), lint, and locale validation pass.
Focused tests: 152 passed, one failed. The failure is the existing symlink
containment test: Windows rejects symlink creation with EPERM. Running
`server/message-file.test.ts` on unmodified `2f91c462` reproduces the same failure
(15 passed, one failed). The security assertion is retained.

`pnpm broker:test` passes eight tests. `pnpm test:packaged-server` boots the
packaged harness without node_modules, checks all 12 proxy paths, and verifies
the MCP stdio handshake. `pnpm test:electron` reports 162 passed, two failed,
10 skipped: both failures require POSIX `mv` in the AppImage updater tests.
The unchanged baseline's updater file reproduces both failures (seven passed,
two failed, one skipped). No Electron implementation files are changed here.
Both browser fixture launchers reported `cleaned: true` after being stopped.

The full `pnpm test` run and current CI results are recorded in the PR; this
focused result is not a claim that the full suite passes. Machine-specific
fixture transcripts and logs stay local. See the earlier
[modal verification](../file-preview/README.md) for the original proposal's
Japanese PDF, invalid PDF, download, and video-playback evidence.

## Review fixes on 2026-09-12

Commits `47368c26` and `0cf173f5` address explicit fixture reply precedence,
committed thumbnail callbacks, metadata-ready video playback, and bounded
actual ZIP inflation. The dependency `fflate@0.8.3` was already transitive and
is now direct so the preview can use its streaming inflater explicitly.

Before these fixes: [existing capture](after.jpg). After the fixes:

![Preview after review fixes](review-after.jpg)

The production fixture again rendered PDF, spreadsheet and slide thumbnails.
Clicking the inline video yielded `paused: false`, `currentTime: 0.236221`,
native controls enabled, and zero dialogs. The workbook's Checks sheet and
PowerPoint slide 2 still rendered. The owned fixture reported `cleaned: true`.

`pnpm build`, `pnpm lint`, and `pnpm i18n:check` pass. The following focused
command passes all 99 tests in eight files, including actual-byte overflow
rejection for both Office parsers, stored-entry mismatches, declared budgets,
normal compressed/stored ZIPs, and explicit replies overriding parent replies:

```sh
pnpm exec vitest run src/lib/file-preview.test.ts src/lib/office-preview-limits.test.ts server/file-preview.e2e.test.ts src/lib/load-file-preview.test.ts src/lib/preview-queue.test.ts src/components/AttachmentPreview.test.ts src/components/ChatMarkdown.test.ts server/control-omb.test.ts
```

The full cross-platform checks run in upstream CI; the earlier full local
suite limitations above are retained rather than represented as passing.
