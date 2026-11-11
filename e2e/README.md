# Local release-gate harness

From an isolated worktree, with Node 24 and npm:

```powershell
npm.cmd ci
npm.cmd run e2e
```

`npm run e2e` installs its pinned Chromium if missing, bootstraps an anonymous Convex deployment using the installed CLI,
starts its watcher, configures a random local HMAC bridge secret, builds Next with
webpack and starts the production server, then
runs Playwright. It stops its own process trees in `finally`, including on SIGINT.
The checked-in package script works on Windows and POSIX. PowerShell users should
use `npm.cmd` because the machine's policy blocks `npm.ps1`.

No account, model, GitHub token or production configuration is needed. Cloud
deployment selections, deployment keys and non-loopback Convex URLs are rejected.
Never copy another checkout's `.env.local`. Each worktree owns its `.convex` state
and SQLite directory. Initial ports are allocated dynamically; subsequent runs use
the worktree's saved Convex ports. An occupied port fails rather than borrowing a
different app. `ORIGIN_E2E_PORT` can select the Next port. A checkout lock prevents
two runners sharing its backend/Next build directory; use separate worktrees for
simultaneous invocations. Only remove a stale `.origin-data-e2e/runner.lock` after
checking that its recorded PID has exited.

On systems where Playwright's downloaded Chromium cannot run (for example NixOS), point
`PLAYWRIGHT_BROWSERS_PATH` at a browser directory prepared for the same Playwright version; the
runner then skips its own install:

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/prepared/browsers ORIGIN_E2E_PORT=3135 npm run e2e
```

The runner reuses the Convex ports saved in `.env.local`; stop any `convex dev` or `next dev` of
this worktree first, because the runner starts its own on those ports and builds into `.next`.

`ORIGIN_E2E_DEV=1` opts into Next dev for debugging. Production build/start is the
default so compiling another route or regenerating local bindings cannot hot-reload
call tracks, vault unlock state or open dialogs during concurrent tests.

Each test creates unique users and a workspace with two projects, two ordinary
members isolated to different projects, a workspace administrator and a viewer.
The viewer also receives project-member status to test effective read-only access.
The workspace has no GitHub connection. Fixtures use real public auth and product
APIs, rather than a login bypass endpoint. Browser sessions have separate storage,
cookies, WebSockets and contexts. First-visit release notices are marked seen in
fixture browser storage so their one-second timer cannot obstruct unrelated steps.
Fixtures remain on the local backend for inspection; the harness never deletes a
shared deployment. New tests must use their fixture's IDs, not global row counts.


Docs are component/API-only at this baseline, as documented in PARITY.md. Their
test exercises deployed wiki/document functions and real Yjs updates from two
clients; it does not claim a routed document editor or browser offline convergence.

Call smoke uses Chromium fake camera/microphone devices and two real browser
contexts with media permission. It verifies joins, room presence, mute and leave.
It does not prove physical capture, audible delivery, TURN, NAT traversal, different
networks, screen sharing or production WebRTC reliability.

Chromium is headless by default. For an intentional headed run,
`npm.cmd run e2e -- --headed` retains
`--window-position=-1900,80 --window-size=1880,1040` (monitor 2). Do not remove these
arguments. The harness closes its browsers after the suite.

Useful focused runs (still own startup and teardown):

```powershell
npm.cmd run e2e -- --grep "approvals"
npm.cmd run e2e -- --workers=1
npm.cmd run e2e -- --repeat-each=2
npx.cmd playwright show-report
```

Playwright reports HTML and machine-readable JSON under `playwright-report/` and
`test-results/`. Every failed test retains a trace containing all of its client
contexts, plus a screenshot per client. Bootstrap, backend, Convex and Next logs live
under `.origin-data-e2e/`. These ignored artifacts contain disposable fixture
sessions and potentially private application content: inspect locally and redact
before sharing. Do not commit them or local deployment state.

A green harness is deterministic regression evidence, not
permission to deploy: real models/devices/networks, real GitHub PR lifecycle,
packaging and all remaining PARITY variants still require their own evidence.
