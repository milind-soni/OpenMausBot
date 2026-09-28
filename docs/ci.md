# CI job selection

Every PR still runs the workflow and its static checks: locale validation,
typecheck, lint, Electron checks, the UI build, CI-selection tests and the
verification-documentation checks. Selection never skips the entire workflow.

- Root Markdown files, Markdown under `docs/`, and `.github/FUNDING.yml` alone
  do not run the runtime or mobile jobs.
- Changes confined to `src/`, `public/`, `index.html` and those documents run
  the existing runtime suite, but not native iOS/Android builds.
- Everything else runs all jobs. This includes server/shared code, dependency
  files, workflows, scripts, native code and the iOS fixtures used by Android.
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

## Required-check migration

The repository's `main-ci-gate` ruleset currently requires the three legacy
`typecheck + test (<os>)` check names. This change replaces those identical
aggregators with one `CI` job; it does not remove any platform tests.

1. Review this workflow change and wait for `CI` to succeed on the exact PR
   head. Workflow changes select the full suite, so this proves the full gate.
2. In the existing ruleset, replace only the three legacy required-check entries
   with `CI` from GitHub Actions. Preserve enforcement and all other rules.
3. Merge the reviewed PR through the new required check, without bypassing it.
   Older open PRs need to merge/rebase onto main to report the new check.

Do not remove the old requirements before the replacement check is green.
Until migration, this PR being blocked on the old names is expected. If the
rollout is abandoned, restore the legacy requirements together with the old
workflow rather than leaving the branch without a required CI check.
