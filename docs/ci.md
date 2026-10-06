# CI job selection

Every PR still runs the workflow and its static checks: locale validation,
typecheck, lint, Electron checks, the UI build, CI-selection tests and the
verification-documentation checks. Selection never skips the entire workflow.

- Root Markdown files, Markdown under `docs/`, and `.github/FUNDING.yml` alone
  do not run the runtime jobs.
- Any other change runs the runtime suite.
- Main pushes, merge groups and manual runs always run all jobs. Empty or
  unreadable PR diffs also fall back to all jobs.

PR selection uses a local merge-base diff with rename detection disabled, so
moving a source file into documentation still selects its original runtime
path. There is no changed-files API truncation or new action dependency.

The single `CI` gate keeps the existing required dependencies. It accepts a
skipped runtime job only when static validation passed and explicitly selected
the docs-only path. Failures, cancellations, missing selection and unexpected
skips fail the gate. Existing advisory jobs remain advisory.

The separate shared-terminal smoke workflow is manual-only: its tests already
run in the Windows Vitest/Electron jobs.

## Vitest shards

The suite runs one file at a time, so a shard takes as long as its files added
up. Vitest's own `--shard` deals out equal numbers of files, and in October
2026 that put three of the four slowest e2e files in one shard: about 24
minutes of tests on Windows against 13 to 16 for the others, and every PR
waited for it. `scripts/testing/duration-sequencer.ts` deals the files out by
recorded time instead, slowest first, each to the shard with the least time so
far. The times are `scripts/testing/vitest-shard-weights.json`: each file's
median seconds on the Windows runners, for every file over five seconds and
every e2e file. A file not in it counts one second, or the median e2e time if
it is an e2e file. Every file still runs exactly once, and each shard job logs
a `duration-sequencer:` line with its share.

Refresh the times from a few recent green runs when shards drift apart:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

Deleting or renaming a test file in the weights fails
`scripts/testing/duration-sequencer.test.ts` until its entry is removed or
refreshed. A refresh moves some files to other shards; a failure that appears
only after one is a real ordering dependency between test files.

## macOS runners

The account runs at most five macOS jobs at a time, and a PR used to queue
seven (four Vitest shards, two smokes, the iOS job with its hour-long
simulator suite). With 25 open PRs the macOS jobs waited a median of six and a
half hours. Now:

- A PR runs the Vitest shards on Ubuntu and Windows; main pushes, merge groups
  and manual runs add the macOS shards. Only a couple of test blocks are
  macOS-only.
- Every PR's macOS checks are one job: the packaged-server smoke and the
  Electron smokes.
- `ci-stop-closed.yml` cancels a PR's CI run when the PR is merged or closed. PR runs share a group named by the PR number (`ci-pr-<n>`), never by `github.ref`: a merged PR's closed event reports the base branch as `github.ref`, which made every merge cancel main's CI (fixed Oct 3 2026).

## Main and releases

Main keeps one CI run going and one waiting. Each merge replaces the waiting
run, and the running one always finishes, so a burst of merges costs two full
runs instead of one per merge (fifteen queued behind each other in October
2026, with the release waiting behind them).

`release.yml` ships only a commit whose own `CI` check passed
(`scripts/release-ci.mjs`, overlapping the platform builds). If main's run for
that commit was replaced or never ran, the script starts CI on the commit in
its own lane: a `release-ci/v<version>` branch that no merge can touch,
deleted afterwards. A red verdict stops the release; re-run the failed CI jobs
(`gh run rerun <id> --failed`), and the waiting release picks up the new
attempt. A manual release can skip the wait with `ship_without_ci`, for
emergencies only.

## Required check

The `main-ci-gate` ruleset requires the single `CI` check (it replaced the
three legacy `typecheck + test (<os>)` names in September 2026). Renaming the
`gate` job needs the ruleset updated first, or every PR waits forever.
