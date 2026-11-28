# ZIP metadata reads and XMind imports

Run the focused checks:

```sh
pnpm exec vitest run server/zip-short-reads.test.ts server/zip-archive.test.ts server/xmind.test.ts
OMB_VITEST_E2E=1 pnpm exec vitest run server/zip-short-reads.e2e.test.ts
```

The unit fixture reads a real ZIP from disk, limiting each metadata read while
preserving its returned bytes. It covers the end record, central directory,
local header and member name separately, repeated short reads for stored and
deflated content, a UTF-8 filename, and an EOF after a partial read. Existing
archive tests cover unsafe paths, links, entry limits and inflated-size limits.

The HTTP fixture starts an isolated server with `launchVerificationServer`,
then restarts that owned process with the `short-zip-reads.mjs` test hook. The
hook limits reads of the temporary `map.xmind` to seven bytes and records the
actual read sizes inside the fixture's data directory. It does not change the
archive bytes or replace the ZIP parser, decompressor or upload route.

The fixture posts a valid XMind archive to `/api/files`, checks the 201 response
and the saved Markdown outline, then posts a truncated archive and checks the
400 response. Both paths must remove their temporary import directories.
The fixture stops its child and removes its temporary home when it finishes.

This is deterministic filesystem fault injection, not a measurement of how
frequently a particular local or network filesystem returns short reads. It
does not exercise the composer UI or download an engine binary.
