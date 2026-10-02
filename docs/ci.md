# CI job selection

Every PR still runs the workflow and its static checks: locale validation,
typecheck, lint, Electron checks, the UI build, CI-selection tests and the
verification-documentation checks. Selection never skips the entire workflow.

- Root Markdown files, Markdown under `docs/`, and `.github/FUNDING.yml` alone
  do not run the runtime or mobile jobs.
- Any other change runs the runtime suite.
- The native iOS/Android jobs run only for `ios/`, `android/` (Android's core
  tests read the iOS fixtures), `.github/workflows/ci.yml`,
  `scripts/ci-scope.mjs` and `.gitattributes`. The apps read committed server
  fixtures (refreshed by hand with `scripts/capture-companion-fixtures.mjs`),
  so a server change cannot move their result.
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
- The iPhone/iPad simulator UI suite is `ios-thread-ui.yml`: nightly, on main
  pushes that touch `ios/`, and by hand.
- `ci-stop-closed.yml` cancels a PR's CI run when the PR is merged or closed.

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
