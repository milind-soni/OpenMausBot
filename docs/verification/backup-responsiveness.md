# Backup responsiveness

Workspace exports run in a one-shot Node worker. The existing export routine,
encryption, filesystem syncing, path validation, credential exclusions and
SQLite snapshot are unchanged. The HTTP maintenance gate still requires idle
bots, flushes/closes message storage and prevents mutations until the worker
finishes. This frees the request loop; it does not permit chat writes during
an export or make restores nonblocking.

## Repeatable measurement

Run these serially, not alongside builds or other benchmarks:

```sh
node --experimental-strip-types scripts/bench-workspace-maintenance.ts --in-process
node --experimental-strip-types scripts/bench-workspace-maintenance.ts
```

Each run creates its own temporary data directory before importing runtime
configuration. It seeds 50,000 synthetic messages, checks paged and full history
reads, checks cold/warm memory indexing, then exports an encrypted backup with
1,104 files and 227,046,854 uncompressed bytes. The message database is closed
before export, as in the HTTP maintenance path. Output includes Node/platform,
elapsed time, event-loop maximum and verified message/file counts. The exact
temporary directory is removed afterwards; no live app, accounts or providers
are involved. This is method-level pressure, not a production capacity test.

Two serial comparisons on macOS arm64, Node 26.7.0, 2026-09-26:

| Export | In-process duration | Worker duration | In-process longest loop pause | Worker longest loop pause |
| --- | ---: | ---: | ---: | ---: |
| Pair 1 | 6,083 ms | 5,811 ms | 5,440 ms | 10.81 ms |
| Pair 2 | 5,994 ms | 5,947 ms | 5,419 ms | 7.95 ms |

A separate CPU profile attributed about 4.9 seconds to filesystem syncing.
The result justifies moving the whole export off the request loop, not removing
durability checks or rewriting SQLite. Export duration is essentially unchanged.
The same probe measured about 15 ms to read 100-message tails for 50 threads,
81–90 ms for their full 1,000-message histories, and 8–9 ms for an unchanged
1,000-file memory index. These synthetic bursts do not justify making every
storage operation asynchronous. Cold memory indexing and large history loads
remain synchronous and may need separate work if production traces identify
them as frequent stalls.

## Verification

```sh
pnpm exec vitest run server/workspace-backup-worker.test.ts \
  server/workspace-backup.test.ts server/workspace-backup-policy.test.ts \
  server/workspace-backup-http.test.ts server/workspace-backup-maintenance.test.ts \
  server/workspace-backup-workflow.test.ts \
  server/webhook-ingress.test.ts server/request-auth.test.ts
pnpm lint
pnpm typecheck
pnpm test:packaged-server
```

The worker regression observes a parent timer while the snapshot is partially
copied, not merely while encryption awaits I/O. Existing archive tests exercise
the same public worker entry, including wrong passwords, unsafe paths, WAL
records and credential exclusion. The two-server fake-engine workflow verifies
HTTP export, download, import, restart and subsequent conversation continuity.
The packaged smoke exports and downloads an encrypted archive from an isolated
bundled server outside the checkout with no node_modules available.

Local verification passed 115 tests across the eight files above, lint,
frontend/server typechecking and the packaged export smoke. A second run on
Node 24.18.0 passed the worker/archive/policy subset (53 tests) and that same
packaged export smoke. After adding abrupt-exit cleanup, both worker regressions
and the packaged export smoke passed again on Node 24.18.0.

Expected validation errors retain their messages. Unexpected worker failure
rejects the operation without a synchronous fallback; worker termination is
awaited before releasing the maintenance gate. The parent assigns the job ID
before starting the worker and uses the guarded cleanup path to remove that
exact job on failure, including an abrupt worker exit. A regression terminates
a real worker after plaintext copying starts, verifies the partial job is gone
and an earlier successful archive is untouched, then exports again. Normal
failure cleanup remains inside the original routine. A whole-process crash
still uses the existing startup cleanup; parent-side crash cleanup can briefly
block while deleting partial files. No new job service or queue is needed:
the existing HTTP operation lock serializes exports.

These checks do not establish Windows/Linux performance or native Settings UI
behavior. No data format, schema, installation or provider configuration changes.
