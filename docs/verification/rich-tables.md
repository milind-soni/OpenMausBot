# Rich chat tables and CSV/TSV previews

Start the isolated fake-engine server and renderer:

```sh
node --experimental-strip-types scripts/verify-rich-tables.ts
```

Open its printed `previewUrl`. It contains a real persisted assistant reply with
Markdown tables and links to three synthetic workspace files: 50,000-row CSV,
multiline Unicode TSV, and malformed CSV. Only its temporary home is used.
Ctrl-C closes the fixture and removes its data; the printed server log is retained.

## Automated browser check

Use an installed Playwright module and Chromium executable. Set
`OMB_VERIFY_PLAYWRIGHT` to that module's absolute entry path and
`OMB_VERIFY_BROWSER_CHROME` to the browser executable when they are not available
through the normal Playwright installation. Pass the printed URL explicitly:

```sh
node scripts/testing/check-rich-tables.mjs http://127.0.0.1:PORT/__rich-tables.html
```

The script creates a fresh browser context, checks sorting, rich Markdown links,
RTL, expansion/Escape/focus return, lazy file loading, scrolling to the final CSV
row, sticky headers, bounded DOM, whole-result copy/download, TSV newlines,
malformed-file errors, network retry, dismissal during loading, and narrow/light
layout. Screenshots go to `OMB_TABLE_EVIDENCE` or `/tmp/omb-rich-tables-evidence`.
The supplied address must be loopback and name this fixture page.

## Focused regression checks

```sh
pnpm exec vitest run src/lib/table-data.test.ts src/components/RichTable.test.ts src/components/ChatMarkdown.test.ts src/components/AttachmentPreview.test.ts src/components/AttachmentGallery.test.ts server/message-file.test.ts scripts/testing/verification-docs.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

File previews support UTF-8 CSV/TSV with a first-row header; they parse off the UI
thread. Preview limits are 10 MiB, 100,000 rows, 200 columns and 500,000 cells.
Malformed or over-limit files report an error rather than silently truncate.
Downloading the original is unchanged. Copy/export uses the current sorted and
filtered rows; formula-like cells are escaped for spreadsheet applications.
Cell values, including leading zeroes and long integer IDs, remain strings.

This verifies the web renderer and real message-file access using an offline
provider fixture. It does not claim native phone or packaged Windows coverage.
No D3, arbitrary script execution, XLSX support, new tools or provider changes
are included.
