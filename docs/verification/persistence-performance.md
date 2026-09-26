# Persistence responsiveness

This is an incremental concurrency-hardening effort, not a migration away
from SQLite or a claim that every persistence operation is nonblocking.

## Repeatable synthetic benchmark

```sh
pnpm bench:persistence
pnpm bench:persistence --worker
```

Each invocation creates and removes its own temporary data directory. Config
is imported only after `OMB_DATA_DIR` points there. It seeds 50 threads with
1,000 approximately 1 KB messages each, then measures bursts of 1, 10 and 50
sessions. Each session writes one message and publishes ten canonical text
delta events per batch. The mixed scenario also performs five absent-query
substring scans. The worker is warmed before timing. No real engine, provider,
account, or user data is used.

The baseline uses the same synchronous SQL search implementation; `--worker`
runs that exact query through the new worker. SQL time, per-operation maximums
and event-loop delay are distinct measurements. Bursts yield between batches;
they are not 50 live models or a production capacity estimate. Run comparisons
serially on an idle host, not alongside builds or other benchmarks.

## 2026-09-26 observations

macOS arm64, Node 26.7.0, baseline `d1d6bc701` plus this change. Three serial
baseline/worker comparisons, with 50,000 seeded messages:

| Mixed workload | Median of three maximum event-loop delays, synchronous | Worker |
| --- | ---: | ---: |
| 1 session | 70.84 ms | 3.22 ms |
| 10 sessions | 73.14 ms | 9.77 ms |
| 50 sessions | 90.11 ms | 25.90 ms |

Search itself remained roughly 65–85 ms: the change frees the server while
the scan runs; it does not accelerate SQL. Ordinary write p95 was usually
0.11–0.19 ms on this host.

Do not hide the outliers: the 50-session mixed runs reached 492.04 ms on the
baseline and 292.55 ms with the worker. Write-only bursts, unchanged by this
patch, also had occasional hundreds-of-milliseconds stalls. A subsequent
attribution run measured 455.55 ms inside ten event publications; a GC-traced
run measured one 1,267.99 ms message append and 417.27 ms event batch, without
a corresponding long major-GC pause. Disk/OS variability remains relevant;
these are not proof that every stall is SQLite or a production regression.

## Scope and invariants

- Only `/api/search` scans move to a worker. Agent recall, message commits,
  event logging and report/backup work are not silently changed.
- One lazy read-only worker; at most eight outstanding searches and a
  30-second deadline. Busy/interrupted/failed searches return retryable 503s,
  never a blocking fallback or an empty success after failure.
- Literal substring, wildcard escaping, snippets, order and thread scope
  share the existing query implementation. No schema or data-format change.
- Authorization and bot visibility are checked again after the asynchronous
  scan. Deleted conversations are resolved against the current Store.
- Maintenance/shutdown awaits worker termination. A scan opens/closes its
  read-only connection, avoiding stale files across workspace replacement.
- Message commits and branch-head transactions still precede acknowledgement.

## Verification commands

```sh
pnpm exec vitest run server/message-search-worker.test.ts server/message-db.test.ts server/message-search.e2e.test.ts server/bot-visibility.e2e.test.ts server/workspace-backup.test.ts
pnpm exec vitest run server/index.test.ts -t 'searches transcripts and exports'
pnpm test:packaged-server
```

The search fixture uses the standard isolated launcher, seeds only its new
database, sends two real fake-engine turns through `control:omb`, performs
eight HTTP searches, checks a health response arrives before they all finish,
and verifies both settled replies and scoped active-branch search results.
It prints a retained evidence JSON/log path and removes the disposable data.
The visibility fixture changes a bot's audience while a large scan is pending.
Worker tests cover parity, committed writes/deletes, queue bounds, timeouts,
read-only failure and database replacement. Packaged smoke invokes search
outside the checkout, with no `node_modules` available.

## Remaining work (not covered by this search-only change)

1. Attribute write/log tail latency under isolated disk contention and test
   real mixed HTTP traffic, long-history hydration, memory refresh and backup.
2. For logging changes, preserve redaction, bounded buffering, failure markers,
   ordered records, inspection/backup flush and deletion without resurrection.
3. Move message writes only if remaining measurements justify it. Keep the
   transaction/receipt/cancellation durability boundary and bounded queue;
   do not turn commits into fire-and-forget writes.
4. Measure Admin independently: distributed desktops do not share a chat DB.

No live deployment, provider speedup, fleet-size promise or Windows/Linux
native verification is implied by the local macOS measurements.
