---
status: review
created: 2026-11-13
updated: 2026-11-13
owner: Dell
scope: combined schedules and first-run retest
commit-tested: ac6626d42fab5726da87b4ff7eb606a87845d64e
---

# Combined schedules and first-run retest

**Verdict: PASS for the requested repairs and navigation smoke.** No new product bugs found. This does not approve unrelated outstanding Preview repairs or untested native desktop behavior.

## Isolation

Reused dell-preview-final and checked out ac6626d detached as requested. No application code changed, no install, merge or push. The prior Preview notes remain in local commit ea045dc. Live data, main and active implementation worktrees were untouched; port 8899 was used for task reads/updates only.

Harness/UI: 8929/5229. Explicit disposable GBS_DATA_DIR and GBS_PROJECTS_FILE. A Node preload shim redirected os.homedir() to a disposable host-home fixture; the child environment omitted HOME/USERPROFILE rather than modifying the user's values. All four suggested folders existed inside that fixture. Traversal and escaping symlink targets pointed only at disposable data. Real home folders were not used.

The only configured provider was the repository fake Claude CLI in usage-limit mode. Its emitted test integration token was used for the internal schedule endpoint. Git clone was replaced by a local executable stub that created only the validated destination folder; no external repository was downloaded. A separate mocked Electron bridge/user agent exposed permissions copy without requesting native permissions.

## Per-item verdicts

| Item | Verdict | Independent evidence |
| --- | --- | --- |
| efe15245 / c8bc7cd | PASS | 21 malformed cases rejected with 400 across public create, internal create and PATCH. Tested alternate IDs as number, false, null, object, array and string; both bot/room target directions. A valid schedule remains unchanged. |
| ca15c855 / a0743a3 | PASS | Original Send later repro with a real browser and intercepted HTTP 400: the visible error receives focus inside the sheet, Tab remains trapped, Escape closes it, focus returns to Send later and draft text remains. |
| cb983db0 / 1a655c6 | PASS | Fake usage limit creates a retry in chat A. Cancel confirmation stays out of chat B and an unrelated room. A delayed failing DELETE response released after switching to B also cannot leak its error into B. |
| Folder chips / 0aad249 | PASS | Browser clicks ~/Projects and sends that value unchanged: add-existing, create and clone all return 201 with canonical host-fixture paths. Service checks also accept ~/Documents, ~/Desktop and ~/workspace. Git acquisition itself was stubbed. |
| Folder containment / 0aad249 | PASS | ~/../.. and ~/escape (symlink out of fixture home) return 400 on add-existing, create and clone. No outside destination is created. |
| Active task filters / 0aad249 | PASS | At 1024x900, original seven-filter state measures clientWidth=672 / scrollWidth=672; document width=1024. Repeat with long project/bot labels plus a valid 32-character task label and eight active filters: same measurements. Focusing controls leaves the row at x=336 and does not scroll the surrounding layout. Screenshot visually inspected. |
| Privacy/speech copy / 0aad249 | PASS | Welcome text distinguishes storage on the Studio host from connected AI processing. Permissions text is optional/feature-specific. Rendered speech copy says on-device when available and may fall back to the system speech service. Swift sets requiresOnDeviceRecognition only inside supportsOnDeviceRecognition, matching that qualification. |
| Preview/Schedules exclusion / 4331152 | PASS | Open Preview, then Schedules: Preview Studio unmounts and Schedules appears. Open Preview again: Schedules unmounts. Checked on the combined branch at 1024px. |

## Test details

Schedule target checks used exactly the original malformed dual-key payload shape. No newly created malformed schedule was accepted. Valid caller token and valid owner IDs ensured failures were validation rejections rather than missing authentication or missing targets.

The save-error case used a valid future schedule and a controlled 400 response. Assertions waited for the error and resulting focus state rather than assuming the click completed an asynchronous save. The retry feedback case used an actual fake-engine usage failure and both immediate success and delayed failure paths across conversation changes.

Project chip requests were observed at the Vite-to-harness boundary: projectPath=~/Projects, parentPath=~/Projects, and destinationPath=~/Projects/qa-repository. The server resolved all three into the fixture host home. Canonical /private/tmp spelling on macOS was compared after realpath normalization. A too-long initial task-tag fixture was corrected to the supported 40-character limit before the long-label filter verdict; no application defect is claimed for that rejected fixture. The Task Board selector was also updated to its accessible name including task count. These harness corrections were resolved before the final verdict.

## Automated validation

- pnpm typecheck: PASS.
- pnpm test: **411/411 tests in 50 files PASS**.
- pnpm build: PASS; existing chunk-size advisory remains.
- Independent browser/API checks and the four-folder service checks pass as recorded above.

## Limits and cleanup

Actual Electron, native microphone/speech recognition, OS speech-service fallback/network behavior, native tray/window behavior and Windows runtime paths were not exercised. The permissions page was rendered with a simulated bridge; speech truthfulness was checked against source, not a live recording. Clone validates the UI-to-host path flow and local registration but does not verify GitHub authentication or network download.

The original wider first-run audit's drag/drop and all onboarding permutations were not repeated: this retest covers the three reported fixes plus the requested schedules regressions and screen exclusion. Remaining Preview capture/focus bugs from the prior verdict were not retested or approved here.

All QA Chrome, harness and Vite processes stopped; 8929/5229 have no listeners. Disposable profiles, host-home fixtures and scripts were removed after recording the evidence. Only this report is retained and committed locally. No new bug tasks were needed.
