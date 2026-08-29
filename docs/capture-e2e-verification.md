# Capture end-to-end verification

Run the deterministic verifier from the repository root:

```text
pnpm capture:verify
```

The command uses temporary fixtures only and prints a JSON report. It covers
the Plaud CLI/API-first contract (recording ids only, never audio upload or
AssemblyAI), fresh Plaud browser fallback, the Android Google Messages mirror,
Anvil BI health/Mercury normalization, silent extension delivery (the
extension has no `downloads` permission), deduplication/provenance, stale
browser fail-closed behavior, ledger source health, and Grok plus connected
source backfill. The report labels each check `verified-local` or
`needs-live-credential/device`.

## Connected-source backfill

`scripts/backfill-grok-corpus.ts` also accepts one or more explicit,
credential-free connector exports:

```text
node --experimental-strip-types scripts/backfill-grok-corpus.ts \
  --bot-id chief \
  --connected-source C:\\path\\gmail-export.json \
  --connected-source C:\\path\\calendar-export.ndjson
```

The default is a dry run; add `--apply` to write to Capture memory. Each JSON
record must include `sourceId`, `kind`, `title`, and `occurredAt`, and should
include a stable `externalId`, account id, and evidence reference. The importer
does not contact providers or read credentials, rejects local/Grok source ids,
redacts credential-shaped text, and uses the same durable deduplication and
provenance fields as live Capture.
