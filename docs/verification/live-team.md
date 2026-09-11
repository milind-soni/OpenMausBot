# Live Team studio verification

Implementation and verification record, September 12, 2026. Baseline commit: `5491157c7679d67287ce9bdcde1c0be45faa52f0`, OpenMausBot 0.1.74.

## Run the studio workflow

Use the repository dependencies and Node 24 or later. Run from the repository root:

```sh
OMB_UI_E2E=1 OMB_UI_VIDEO=1 OMB_UI_ELECTRON=1 pnpm exec vitest run scripts/testing/live-team-ui.e2e.test.ts
```

If pnpm is not installed globally, replace `pnpm` with `npm exec --yes --package=pnpm@10.33.0 -- pnpm`. The workflow creates its own server, data directory, home, preview URL, browser session, and Electron profile. It never discovers the operator's app or uses port 8799 implicitly. Its fake engine generates actual runtime events and delegation receipts. The fixture is labeled in its page title and opening scene.

`OMB_UI_VIDEO=1` additionally requires ffmpeg on PATH. `OMB_UI_ELECTRON=1` requires the installed Electron binary and a graphical host. Linux can use an appropriate virtual display. Omit those flags for the browser workflow alone. `OMB_UI_EVIDENCE_DIR` overrides the output directory.

Do not run two renderer verification commands concurrently. The native browser tool and recording environment can interfere across runs. Let each command close its owned session before starting another.

The workflow exercises:

- Entry through Tools, Team map, and Live Team, plus per-workspace room selection.
- A real pointer drag that stages a brief, followed by an explicit send into a new background thread. The ordinary chat stays unselected, and the server records one user message.
- A real provider question, its exact existing answer card, and return focus to the originating station.
- Three queued delegations and real running/terminal states, directed handoff inspection, and result-message navigation.
- A real CSS task-transfer animation caused by a handoff, recorded in `motion.json`.
- Calm mode, operating-system reduced motion, and stale-state recovery without historical replay.
- Keyboard-accessible destination selection, a rejected send with its draft retained, and retry.
- Four, six, twelve, and sixteen bots, pagination, search, no-match state, and 375, 768, 1024, and 1440 px viewports.
- Concurrent background threads on one bot, separate request identities, and requests answered by another client.
- Actual failed and interrupted engine turns, plus an empty workspace after its bots are hidden.
- Opening a workstation and returning without issuing a computer-provisioning request.

Assertions in the test are the authoritative pass criteria. A screenshot by itself does not prove a send, permission decision, terminal event, or absence of a regression.

## Slower presentation recording

For a captioned 1920 × 1080 MP4 with reading pauses, run:

```sh
OMB_UI_E2E=1 OMB_UI_DEMO=1 \
OMB_UI_EVIDENCE_DIR=.omb-scratch/live-team/demo-hq \
npm exec --yes --package=pnpm@10.33.0 -- pnpm exec vitest run scripts/testing/live-team-ui.e2e.test.ts
```

Open `.omb-scratch/live-team/demo-hq/launch-demo-1080p.mp4`. This mode records only the launch story, including a question, queued and running handoffs, results, calm mode, and a passive workstation visit. It checks the core interactions and renderer errors, then closes its isolated fixture. Use the standard command above for the full regression workflow.

The recorder requires ffmpeg. It captures the exact fixture page at JPEG quality 98, preserves elapsed time between frames, and encodes H.264 at CRF 16 with 30 fps output. Static screens remain visible through the reading pauses. Captions occupy a separate strip below the app and identify the simulated demo. The recorder writes its timing metadata to `demo-recording.json` and retains source frames in `demo-frames` for re-encoding. This does not change the production UI.

## Electron coverage

`scripts/testing/live-team-electron.mjs` is launched by the workflow with a fixture-owned configuration file. It loads the real App in a hidden Electron BrowserWindow, uses a disposable preload, and restricts network access to the declared preview. The test keeps the window hidden to avoid stealing desktop focus. Browser coverage exercises pointer hit testing, while this smoke dispatches navigation through the actual controls and uses native renderer text input.

The smoke checks workspace preference restoration, the selected room, workstation return focus, and a previously remembered Browser tab. Studio opens that workstation in watch mode and does not start the remembered browser. A true `webContents.setZoomFactor(2)` produces a 720 × 500 CSS viewport from a 1440 × 1000 content window. The page must have no horizontal overflow and must retain a reachable, editable brief composer.

This is real Electron renderer coverage with fixture OS integration. It does not prove the packaged desktop shell, a provisioned cloud desktop, native host capture, or Windows/Linux native view behavior. Existing computer policy tests cover ready, stopped, and missing Box states. Live provider accounts are not needed for the studio smoke.

## Evidence

Artifacts live under the ignored directory `.omb-scratch/live-team/evidence/`:

- `map-before.png`, `studio-four-dark.png`, `studio-six.png`, `studio-twelve.png`, and `studio-second-page.png` show the scene and its scale behavior.
- `studio-question.png`, `studio-queued.png`, `studio-working.png`, `handoff-request.png`, and `studio-results.png` cover the launch sequence.
- `launch.webm` records the core workflow. `launch.json` retains the terminal projection and workstation request record.
- `studio-light-375.png`, `studio-light-768.png`, `studio-light-1024.png`, and `studio-light-1440.png` capture the light skin after layout transitions settle.
- `studio-reduced-motion.png`, `studio-filtered.png`, and `studio-no-match.png` cover alternate presentations.
- `studio-custom-avatar-question.png` and `studio-long-labels.png` show a stored image avatar with its adjacent question marker and fixture-only expanded translations.
- `studio-concurrent-questions.png`, `studio-terminal-errors.png`, `terminal-errors.json`, and `studio-empty.png` cover the extended lifecycle checks.
- `electron.json`, `electron.log`, `electron-workstation.png`, `electron-zoom-200.png`, and `electron-zoom-brief.png` record the desktop renderer checks.
- `performance.json` and `studio-trace.json` contain the browser measurement and trace. `motion.json` records rendered transfer starts.
- `console.json`, `runtime-errors.json`, `last-render.png`, and `last-snapshot.json` aid failure diagnosis.

Each rerun overwrites these filenames. Confirm the latest test log passed before using its artifacts as completion evidence. Failed runs can retain useful diagnostics without proving the workflow completed. All prompts and outputs in these artifacts are synthetic fixture data. The fixture deletes its temporary home and server data when it closes. Its persistent server log path is printed in the run evidence.

## Performance method

Show twelve stations in a sixteen-bot room. Apply thirty real bot metadata changes to an off-page bot through the fixture API. Capture requestAnimationFrame intervals, PerformanceObserver long tasks, and a browser trace while those SSE updates and the normal studio metadata refresh occur.

The recorded machine is an Apple M4 Pro with 24 GiB of memory. The passing browser measurement used Headless Chrome 153 on macOS, at 1440 × 1000. The final recording run measured 221 frames in live mode, with reduced motion disabled, a p95 near 16.7 ms, and 0 long tasks. Check the current `performance.json` for the latest run. This short synthetic workload is not a guarantee for every computer or long-lived production workspace.

The renderer displays at most twelve stations, keeps request/handoff/result pages bounded, and does not load all transcripts to update the room. Handoff request content is fetched only when opened. No additional SSE connection is created. A delayed background task response adds only its task identity, preserving newer navigation and task state from SSE. Hidden studio views stop their metadata refresh and travel motion.

## Regression commands

```sh
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm test
pnpm build
```

Focused studio and adjacent contract coverage:

```sh
pnpm exec vitest run server/live-team.test.ts src/lib/live-team.test.ts server/delegations.test.ts server/peer-approval.test.ts src/lib/team-map.test.ts src/state/store.test.ts src/lib/local-computer.test.ts server/request-auth.test.ts
pnpm exec vitest run server/index.test.ts
pnpm exec vitest run server/control-omb.test.ts -t 'control-omb command mapping'
```

If a baseline Vitest failure stops `pnpm test`, run its remaining stages explicitly:

```sh
pnpm broker:test
pnpm test:electron
pnpm test:packaged-server
```

## Recorded checks and baseline comparison

The final repository-wide run completed with **493 passing files, two failing files, and one skipped file**. It recorded **6014 passing tests, two failures, forty skipped tests, and one todo**. The remaining failures match the clean baseline:

- `server/control-omb.test.ts`: the isolated launcher detects the machine's Qwen installation in addition to the expected fake Claude engine.
- `server/engine-install.test.ts`: the TERM/KILL timing assertion receives SIGTERM instead of the expected SIGKILL.

The clean baseline completed with 484 passing files, three failing files, and six skipped files, with 5992 passing tests. It reproduced both failures above and also had a local-computer Electron startup timeout. That timeout did not recur in the final implementation-wide run. The complete server API file passed all 205 tests on its separate rerun and had no failure in the final full run.

The final isolated Studio + Electron run, together with `server/live-team.test.ts` and `src/state/store.test.ts`, passed **91 tests across three files**. This run followed the last navigation and accessibility changes. It included video capture, actual animation events, exact question routing, concurrent questions, cross-client answers, custom avatars, expanded locale labels, failed/interrupted turns, empty state, 200% Electron zoom, inspector focus, polite attention announcements, and an empty renderer runtime-error list.

The final build, standalone TypeScript, lint, locale, and skin contrast checks passed. The build retains the existing large-chunk warning. The locale catalog has 2025 English strings across nine supported language packs. The broker stage passed eight tests. The existing Electron stage passed 174 tests. The final packaged-server smoke started without node_modules in reach, resolved all twelve spawned proxy paths, and exercised packaged MCP stdio against the API.

The full run began before the last isolated changes to inspector focus and background task settlement. The affected store/projection tests and entire browser/Electron workflow were rerun after those changes. Build and type/lint checks also passed on that final code. No new regression was found in this verification. The two reproduced baseline failures mean `pnpm test` does not exit successfully on this machine.

Logs are retained under `.omb-scratch/live-team/`: `final-full-tests.log`, `final-studio-tests.log`, `final-build.log`, `final-typecheck.log`, `final-lint.log`, `final-i18n.log`, `contrast.log`, `broker-tests.log`, `electron-tests.log`, and `packaged-server-tests.log`. The clean baseline log is `/private/tmp/openmausbot-baseline-test.log`.

## Design and compatibility notes

Studio is a presentation alongside Team Map. It preserves existing chat and computer routes. New task creation defaults to the existing activation behavior. Studio requests `activate: false` only when staging a background send. The existing send identity and retry path remain authoritative.

Explicit stop requests are correlated to the active provider turn because Claude may report an interrupted process as `exit_before_result`. This affects only the studio outcome. Provider events and stop behavior are unchanged.

The metadata endpoint uses the existing map's access scope. It excludes hidden bots and group threads with hidden members, projects current thread ownership, and fetches content through existing conversation routes. Terminal results are bounded metadata receipts, not a new scheduler. Existing delegation IDs and receipts retain their runtime meaning. Denial/expiry ambiguity is labeled Blocked rather than attributed to the user.

The studio adds English strings to the existing locale system. Other locale packs use the repository's supported English fallback until translated. A passing locale check does not mean all new strings have been translated.

See the [implementation plan](../plans/2026-09-11-live-team-studio.md) for the unchanged product scope and the [contribution outline](../plans/live-team-contribution.md) for proposed review slices.

## Acceptance evidence audit

The following requirements have direct implementation and local verification evidence. The final test outcomes and baseline exceptions are recorded above.

- **Visible studio and scale.** The inspected four-bot screenshot contains all four characters and desks in one row, plus the results area. Six-bot, twelve-station, later-page, narrow-width, dark/light, and empty states have separate captures. The real avatar renderer and CSS furniture are used by production and fixtures.
- **Authoritative work.** `server/live-team.ts` projects current task/group state, pending request metadata, existing delegation IDs, and terminal records. Runtime-driven screenshots, `launch.json`, `motion.json`, and `terminal-errors.json` establish actual queue, running, question, success, failure, and interruption transitions.
- **Identity and history.** Projection tests cover hidden bots, bounded pages, independently identifiable repeated/reverse handoffs, receipt persistence, and answered/dismissed cards. Motion tests cover initial hydration, duplicate snapshots, reconnect, room/history changes, old events, the two-transfer cap, and failure suppression.
- **Assignment.** The renderer fixture uses an actual pointer drag, requires a separate send, verifies one user message, sends through a background thread, and retains the draft through an aborted request and retry. Destination identities stay pinned in `LiveTeamStudio` and the existing store send path.
- **Requests and concurrent threads.** The fixture opens an exact live provider question and receives its real answer. Later it starts two threads on one bot, checks both requests and the task-stack count, answers from another client, and observes the requests disappear. The custom image avatar keeps a separate question marker.
- **Content and permissions.** Handoff inspection fetches its source message only when opened. Results navigate to existing source conversations, including turns with no attachments. Existing conversation and attachment views retain their missing-content behavior. Client scope matches Team Map, writes and arbitrary subroutes stay outside that read scope, and visibility/ownership are checked by the projection and navigation handler.
- **Viewer behavior.** The browser request record and Electron smoke establish passive workstation opening, no browser/computer startup request, remembered Browser-tab suppression, and return to the same room and station. Existing Box policy tests separately cover ready, stopped, and absent computers.
- **Motion and accessibility.** Real handoff animation starts are recorded. Calm/reduced-motion paths remain static, stale refresh errors retain a static room, and recovery does not replay deliveries. Native Electron zoom verifies a 720 × 500 CSS viewport at 200%, without horizontal overflow and with editable brief input. Expanded-label captures were inspected at 375 px. The final focused workflow passed inspector-focus and polite-announcement assertions.
- **Performance and integration.** The measured twelve-station scene remains near the development machine's 16.7 ms frame budget under off-page SSE traffic. Metadata reads are visible-only and bounded, transcript content is fetched on demand, and the studio does not create another SSE client, scheduler, permission policy, or window manager.
- **Contribution package.** The implementation plan, exact verification commands, local artifacts, baseline comparison, platform limits, and proposed review slices are present. The public upstream HEAD was rechecked and still matches the recorded baseline. Spaces #830 remains open at its previously recorded head.
