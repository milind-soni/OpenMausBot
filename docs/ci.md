# CI job selection

Every PR still runs the workflow, its `static` job and the `CI` gate: locale
validation, lint, the CI-selection tests and the verification-documentation
checks always run. Selection never skips the entire workflow.

`scripts/ci-scope.mjs` sorts a pull request's changed files (a local
merge-base diff, rename detection off, so a moved file selects its old path
too) into areas, and runs only the jobs some area can affect:

| Area | Paths | What runs |
| --- | --- | --- |
| docs | `*.md` at the root, everything under `docs/` and `apps/docs/`, `.github/FUNDING.yml` | lint, the docs tests (the three vitest files that read the docs) on Linux |
| locales | `src/locales/*.json` except `en.json`, `src/locales/*.test.ts` | the build, the locale tests: every `src/` test and `scripts/generate-locale.test.mjs` in two Linux shards, with the Electron node tests |
| web | the rest of `src/`, `public/`, the root `*-preview.html` pages | the build, the eight Linux shards, the renderer smoke |
| script tests | `scripts/**/*.test.*` | the Linux and Windows shards, the renderer smoke, browser identity |
| server | `server/`, `shared/`, `enterprise/`, `companion/`, `evals/`, `skills/`, `deploy/`, the composio broker, the Dockerfile, and the renderer files the server or a smoke loads | the build, Linux and Windows shards, behavior evals, packaged server, open-source edition, the macOS smokes, renderer smoke, browser identity, browser driver, Linux package |
| desktop | `electron/`, `build/`, `electron-builder.yml`, `index.html` | the same as server |
| control plane | `cloudflare/control-plane/` | the control-plane job |
| everything | anything else: `.github/` workflows, `package.json`, the lockfile and workspace, tsconfig, vite and vitest config, `third_party/`, `scripts/` code, unknown paths | every job |

The build is static's typecheck, Electron syntax check and UI build. Several
areas run the union of their jobs. Why the mapping is what it is:

- The server imports a few renderer files (`SRC_OUTSIDE_RENDERER`), and the
  renderer imports Electron modules, so a server or desktop change can affect
  the renderer smoke, and those renderer files count as server.
  `scripts/ci-scope.test.ts` holds the list equal to the import graph.
- The macOS smokes run the packaged server inside Electron (approval modes,
  app frames, phone relay, login handoff), so a server change runs them.
- A renderer change runs no Windows or macOS shard: the renderer's tests read
  the platform from the desktop bridge, never the host. The full lane still
  runs both.
- English (`en.json`) is the text every test reads, so it is web. Other
  catalogs are read only by `src/` tests, the locale generator's test and an
  Electron node test; `scripts/ci-scope.test.ts` fails if another test starts
  reading them, or the docs, without being listed.
- Windows CUA and the Linux ARM64 cloudflared installer test only their own
  scripts and pinned downloads, so only `scripts/` and dependency changes run
  them.

## Lanes: pull requests, main and the full lane

Only pull requests use the areas. Every other event runs one of two fixed
sets (`laneOf` in `scripts/ci-scope.mjs`):

| Event | Lane | What runs |
| --- | --- | --- |
| `pull_request` | its areas | the table above, with Linux and Windows shards |
| `push` to main, `merge_group` | main | static (typecheck, lint, the build), the eight Linux shards with the Electron node tests, the macOS smokes job, behavior evals, the Linux packaged server smoke, the open-source edition, the control plane, the renderer smoke and Linux browser identity |
| `schedule` (nightly, 21:17 UTC), `workflow_dispatch` (manual runs, the release branch's CI that `prepare-release.yml` starts, and the release lane) | full | every job on every platform: also the Windows and macOS shards, the Windows packaged server and Windows CUA smokes, Windows and macOS browser identity, the browser driver on all three, the Linux package and the Linux ARM64 installer |

The main lane keeps to runners that do not hold main up: Linux, and one macOS
job. The Windows and macOS shards, and every smoke that needs a Windows or a
second macOS runner, wait for the night or a release. A change that breaks
only Windows or macOS shows up in its own PR (PRs still run the Windows shards
wherever a change can affect them), in the nightly run, or in the release
lane, which only an emergency `ship_without_ci` release skips.

- A push to main is scoped by its own commits (`before..after`): docs only
  (root Markdown, Markdown under `docs/`, `.github/FUNDING.yml`), or a
  `package.json` change that only bumps `"version"` (the release bump), skips
  the runtime jobs. It does so only when the commit before the push has a green
  CI run of its own. Main's waiting run is replaced by each push, so without
  that check a replaced run's code would never be tested. Every other push runs
  the main lane.
- A push whose commit already passed the `CI` gate in a merge group runs only
  the control-plane job (the broker deploy needs it). The merge queue lands
  its group's own commit, so the merge group's run tested exactly what the push
  brings; `ci-scope.mjs` reads that run's gate job, which can pass before the
  run's last job has finished.
- Merge groups always run the main lane, whatever they change. Empty or
  unreadable push diffs, and a commit whose CI cannot be read, fall back to the
  main lane; a pull request whose diff cannot be read falls back to every job
  on every platform.

The single `CI` gate keeps the existing required dependencies. `static`
outputs the selected job ids; the gate wants each required job to have passed
when it was selected and to have been skipped when it was not. Failures,
cancellations, a missing or malformed selection and unexpected runs or skips
fail the gate. Advisory jobs remain advisory. A new push to a PR cancels that
PR's older run (see Main and releases for every other group).

The separate shared-terminal smoke workflow is manual-only: its tests already
run in the Windows Vitest/Electron jobs.

## Vitest shards

The suite runs one file at a time, so a shard takes as long as its files added
up, and the slowest shard sets how long a PR and a release wait. Linux and
Windows run eight shards each, macOS four (the full lane only);
`scripts/ci-scope.mjs` builds the matrix.

**Which files run where.** Linux runs every file. Most e2e files drive
OMB's own logic through a real server and fake engines, which is the same on
every OS, and they were 70% of a Windows shard's time, so only Linux runs
them: the Windows and macOS shards set `OMB_VITEST_E2E=host`, and
`vite.config.ts` then leaves out every e2e file not listed in
`scripts/testing/host-e2e.ts`. The list keeps an e2e file on every host when
it has a test that never runs on Linux (Auto on the person's own desktop, the
built-in Mac voices) or depends on the OS (PowerShell and Windows process
trees, junctions, a running process's folder, Windows paths, Chrome behind the
egress gate). Every unit and API test file runs on every host. A new e2e file
with a test Linux skips fails `scripts/testing/host-e2e.test.ts` until it is
listed. The packaged-server, Windows CUA host, browser identity and browser
driver jobs are separate and unchanged.

**Balance.** Vitest's own `--shard` deals out equal numbers of files, and in
October 2026 that put three of the four slowest e2e files in one shard.
`scripts/testing/duration-sequencer.ts` deals the files out by recorded time
instead, slowest first, each to the shard with the least time so far. The
times are `scripts/testing/vitest-shard-weights.json`: for each platform
(`linux`, `win32`, `darwin`), each file's median seconds on that platform's
runners, for every file over five seconds and every e2e file. A file not in it
counts one second, or the median e2e time if it is an e2e file. Every file
still runs exactly once, and each shard job logs a `duration-sequencer:` line
with its share.

Refresh the times from a few recent nightly or manual runs (they have all
three platforms) when shards drift apart:

```sh
node scripts/testing/update-shard-weights.mjs --run <run id> --run <run id> --run <run id>
```

To run one CI shard locally, use the same OS, `--shard` and `OMB_VITEST_E2E`:
`OMB_VITEST_E2E=host pnpm exec vitest run --shard=3/8` is Windows shard 3 on a
Windows machine.
The locale and docs tests are the same command with their files first:
`pnpm exec vitest run src/ scripts/generate-locale.test.mjs --shard=1/2` is
locale tests 1/2 (those jobs set `OMB_VITEST_SUBSET`, so the sequencer does not
warn that most weighted files are missing).

Deleting or renaming a test file in the weights fails
`scripts/testing/duration-sequencer.test.ts` until its entry is removed or
refreshed. A refresh moves some files to other shards; a failure that appears
only after one is a real ordering dependency between test files.

## macOS runners

The account runs at most five macOS jobs at a time, and a PR used to queue
seven (four Vitest shards, two smokes, the iOS job with its hour-long
simulator suite). With 25 open PRs the macOS jobs waited a median of six and a
half hours. Now:

- A PR runs the Vitest shards on Ubuntu and Windows, a push to main or a merge
  group on Ubuntu; the full lane adds four macOS shards, which run the host e2e
  files only. Only a couple of test blocks are macOS-only.
- Every PR's, push's and merge group's macOS checks are one job: the
  packaged-server smoke and the Electron smokes.
- `ci-stop-closed.yml` cancels a PR's CI run when the PR is merged or closed. PR runs share a group named by the PR number (`ci-pr-<n>`), never by `github.ref`: a merged PR's closed event reports the base branch as `github.ref`, which made every merge cancel main's CI (fixed Oct 3 2026).

## Browser driver (S4)

`browser driver S4 (<os>)` runs the omb-cdp conformance suites
(`server/browser/cdp/s4-*.e2e.test.ts`) against real Chrome: snapshots across
out-of-process frames and closed shadow roots, every action, dialogs,
downloads, popups and tabs, both evaluation worlds, waiting, the calibrated
identity against the headed browser and across page, worker, service worker,
frame and request headers, Chrome exiting after its controller is killed, and
the latency targets. Each suite records every CDP command its browsers were
sent and fails on `Runtime.enable`, `Runtime.addBinding`, `Console.*`,
`Debugger.*`, `Profiler.*` or an evaluation in the page's own world that the
test did not ask for. The unit tests in the vitest shards hold the same rule
without a browser: the method guard refuses those methods and no driver
source names them.

The same job runs the new browser's suites on that Chrome:
`server/browser/checklist.e2e.test.ts` (the design's checklist items the
browser service owns: tools and refs, sign-ins kept across a restart of the
browser, erase and temporary profiles, uploads, downloads, dialogs, popups,
HTTP sign-in, a person's hold, restart and idle close) and
`server/browser/viewers/viewers.e2e.test.ts` (the page filling the viewer
at the screen's device scale, resizes, presets, acknowledged frames, a
scroll ending on a sharp frame, and the phone's v1 live view against its
golden from agent-browser), `server/browser/passkey-wall.e2e.test.ts` (a
sign-in shaped like Google's that stops at a passkey or a security key: the
bot's notice, the request ending at once as unavailable, Try another way, the
options and a code, and no passkey registered) and
`server/browser/viewers/stream-v2.e2e.test.ts`
(the panel's WebSocket stream through its routes: a 1600x1000 panel getting a
1600x1000 page and 3200x2000 frames on a 2x screen, the page's file picker
answered by an upload, a dropdown list drawn by the viewer, a download served
to it, the page's cursor and copied text).

- The job uses the runner's installed Google Chrome (`OMB_CDP_E2E=1`) on the
  same platforms as the vitest shards: Linux and Windows on PRs, all three in
  the full lane. Pushes to main and merge groups leave it out. Linux runs
  under Xvfb so the headed-identity case has a display.
- On Linux it then builds the server image's `runtime` stage and runs the
  suites inside it as a non-root user against the image's Chrome for
  Testing, with `OMB_BROWSER_SANDBOX=0` because the image has no setuid
  sandbox helper yet.
- It is advisory, outside the `CI` gate, until it has run green for a while.
- The latency targets hold wherever Chrome itself can meet them. The suite
  also times Chrome alone in the same run (the same binary started bare and
  showing a page; a frame and the same mouse events with none of the driver's
  checks), and where Chrome alone is slower, as on GitHub's macOS VM (0.7-1.5
  s to start, 60-75 ms to click, against 0.3 s and 33 ms on a Mac), the driver
  may add only its budget to that.
- On macOS the job locks the runner's Google Chrome app before the suites and
  fails if its version changed: the image's Chrome is older than Google's
  release, and the GoogleUpdater it starts swaps the new version into the app
  about a minute and a half after Chrome first runs, in the middle of the
  suites.
- Locally: `OMB_CDP_CHROME=<chrome executable> pnpm exec vitest run
  server/browser/cdp/s4- server/browser/checklist.e2e server/browser/passkey-wall.e2e
  server/browser/viewers/viewers.e2e server/browser/viewers/stream-v2.e2e` (or
  `OMB_CDP_E2E=1` for the installed Google Chrome). Without either the suites
  skip. `OMB_CDP_TEST_TMP` moves the throwaway profiles.
- `pnpm bench:browser-stream` measures the panel's stream on the installed
  Google Chrome with this computer's display: frame and page sizes, input to
  photon, frame rate, bytes and CPU. It is not part of CI.

## Main and releases

Main's pushes keep one CI run going and one waiting. Each merge replaces the
waiting run, and the running one always finishes, so a burst of merges costs
two runs instead of one per merge (fifteen queued behind each other in October
2026, with the release waiting behind them). Every other run has a group no
push can join, so nothing a merge does cancels it: a merge group is named by
its own ref, and the nightly run and each manual run (the release branch's CI
and the release lane among them) by their event and branch.

`release.yml` ships only a commit whose code passed CI
(`scripts/release-ci.mjs`, overlapping the platform builds). A run counts only
when its `CI` gate passed and every platform's every vitest shard ran and
passed. A scoped run (docs- or version-only, vitest skipped) is never proof,
and neither is a partial one: a push to main or a merge group runs Linux's
shards only. The script accepts, in order:

1. a finished full run on the release commit itself;
2. a finished full run on any commit with the same git tree: the all-OS manual
   run `prepare-release.yml` starts on the `release/v<version>` branch,
   whenever main did not move before the merge, or a nightly run;
3. when the release commit's only change from its parent is `package.json`'s
   `"version"` (all the bump touches), the parent's proof by 1 or 2. A parent's
   nightly or manual run still going is waited for; a red parent, or one that
   skipped its tests or ran only some platforms, never counts.

Otherwise the script starts CI on the commit in its own lane: a
`release-ci/v<version>` branch that no merge can touch, run as a manual run of
every job on every platform, and deleted afterwards. It does not wait for the
commit's push or merge-group run first, which could only come back partial,
but a red one that has finished stops the release. A red verdict stops the
release; re-run the failed CI jobs (`gh run rerun <id> --failed`), and the
waiting release picks up the new attempt. A red where every failed job never started a step (a macOS runner
"failed to be acquired") is not a verdict. On the release lane's own run the
script re-runs the failed jobs once itself
(`POST /actions/runs/<id>/rerun-failed-jobs`, which the job's
`actions: write` allows) and keeps waiting. Main's run is never re-run that
way: a re-run joins main's concurrency group, where it would cancel the
newest merge's waiting run and re-run main-only deploys from an older tree.
The script starts CI in the lane instead. A manual release can skip the
wait with `ship_without_ci`, for emergencies only.

## Flaky tests and Windows timeouts

Known flaky tests are listed in `scripts/testing/ci-retry-list.json`: file,
full test name (describe blocks and test joined with ` > `), owner, the
evidence, and the date it was listed. In CI only (`CI=true`), the repo's
vitest runner (`scripts/testing/ci-retry-runner.ts`) gives each listed test
two retries; nothing else is retried, and local runs never retry. Retries
are bounded per file: once a listed test fails all three attempts, that is a
real failure, and the file's later listed tests get no retry. Otherwise a
regression that breaks a whole fixture (six listed tests share
`server/delta-context.e2e.test.ts`) would triple their wall time and push the
Linux shard past its 20-minute cap, and a timed-out job loses the failing
tests' annotations and this summary. The cost: a real flake listed after a
broken test in the same file is not retried in that run. A listed
test that needed a retry is written to the vitest job's summary and raised as
a warning annotation (`scripts/testing/ci-retry-summary.mjs`), so a flake
that passed is still seen. Fix the test, then delete its entry;
`scripts/testing/ci-retry-list.test.ts` fails on an entry whose test no longer
exists.

Windows runners run the suite about 1.45x slower than Linux. Every test and
hook timeout doubles there (`server/testing/host-timeout.ts`): the defaults in
`vite.config.ts`, and a test's own timeout written as `hostTimeout(ms)`. Linux
and macOS keep the strict numbers, such as the 120 s budget for the
3,000-file checkpoints test.

The packaged-server smoke asks the OS for free ports (listen on port 0)
instead of picking them at random: a random pick inside a range Windows
reserves failed with `listen EACCES 127.0.0.1:497xx`.

## Required check

The `main-ci-gate` ruleset requires the single `CI` check (it replaced the
three legacy `typecheck + test (<os>)` names in September 2026). Renaming the
`gate` job needs the ruleset updated first, or every PR waits forever.

## Merge queue

Two PRs that were each green have broken main together. A merge queue tests
each PR on top of what lands before it: GitHub builds a merge group (the PR
squashed onto main and the groups ahead of it), CI runs the main lane on it as
a `merge_group` event, and the group's commit lands only when its `CI` check
passes. The workflow is ready: the `merge_group` trigger, a concurrency group
per merge group, the main lane, and the same `CI` check name.

GitHub offers the queue only to repositories an organization owns ("Pull
request merge queues are available in any public repository owned by an
organization", GitHub's docs, October 2026). `milind-soni/OpenMausBot` is
owned by a user account, so the rule below appears only after the repository
moves to an organization (such as `SupaMaus`). The move changes the URL the
desktop updater reads (see Updater migration invariant in `releasing.md`), so
it is the owner's decision. Then:

**Settings → Rules → Rulesets → `main-ci-gate` → Edit** (it targets the
default branch):

1. Keep **Require status checks to pass** with the one check `CI` (source:
   GitHub Actions). The same rule applies to the PR before it can join the
   queue and to the merge group in it. **Require branches to be up to date
   before merging** stays off: the queue brings each PR up to date itself.
2. Add **Require merge queue** with:
   - **Merge method:** Squash.
   - **Build concurrency:** 3. Each group's run is 17 jobs, one of them on
     macOS; an organization on the Team plan runs 60 jobs and 5 macOS jobs at
     once, shared with every PR's run.
   - **Minimum group size:** 1, **maximum group size:** 5, **wait time to meet
     the minimum group size:** 0 minutes, so a PR alone starts at once.
   - **Require all queue entries to pass required checks** (Only merge
     non-failing pull requests): on. Every PR's own group must pass, not only
     the last of the PRs merged together, so every commit the queue lands on
     main was tested.
   - **Status check timeout:** 60 minutes (a main-lane run takes about 25).
3. Save. PRs then show **Merge when ready** instead of the merge button;
   `gh pr merge --squash` adds a PR to the queue, or turns on auto-merge when
   its checks have not passed yet.

The same rule through the API, keeping the ruleset's existing check:

```sh
gh api -X PUT repos/<org>/OpenMausBot/rulesets/<main-ci-gate id> --input - <<'JSON'
{"rules": [
  {"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "CI", "integration_id": 15368}],
    "strict_required_status_checks_policy": false, "do_not_enforce_on_create": false}},
  {"type": "merge_queue", "parameters": {"merge_method": "SQUASH", "max_entries_to_build": 3, "min_entries_to_merge": 1,
    "max_entries_to_merge": 5, "min_entries_to_merge_wait_minutes": 0, "grouping_strategy": "ALLGREEN",
    "check_response_timeout_minutes": 60}}
]}
JSON
```

`ci-stop-closed.yml` only cancels a closed PR's own group (`ci-pr-<n>`), so it
never touches a merge group's run. The push that lands a group's commit runs
only the control-plane job and the broker deploy, because the merge group
already tested that exact commit. To turn the queue off, remove the **Require
merge queue** rule; nothing in the workflow needs to change.

While the repository stays user-owned, the one setting that stops two green PRs
from landing red together is **Require branches to be up to date before
merging** on the same ruleset: a PR merges only after CI passed on it with
main's newest commit in it. Every merge then makes the other open PRs update
their branch and run CI again before they can merge, so it trades merge
throughput for that guarantee.
