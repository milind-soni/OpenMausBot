# Cloud computer removal QA (Dell, 2026-11-12)

Outcome: **PASS for the isolated browser, legacy migration, and automated checks.** Electron local computer use remains unverified because it cannot be tested in isolation from the live desktop app. Shared task: `afc509fa-f749-4497-a998-8a3dec1a910d`.

Tested dedicated worktree `/Users/esoefildine/Documents/Dev/GBS-worktrees/dell-qa`, detached at `30e024d`, against its removal plan and `docs/dev/fixes/review--remove-cloud-computer.md`. No branch switch, dependency installation, source edit, or commit was performed in that worktree. Browser: Chrome driven by Playwright. Harness: `127.0.0.1:8912`; Vite: `127.0.0.1:5212`; data: `$TMPDIR/gbs-qa-dell-cloud`.

## Legacy profile and results

Before the first start, seeded `config.json` with `box: {token: "test"}`, custom instance `old-box` using driver `boxAgent`, and a fake Claude instance `qa`. Seeded `bots.json` with two records following the store persistence shape: `TEST · Legacy cloud` had `computer: "cloud"` and selected `qa`; `TEST · Legacy box` selected `old-box`. No live profile was copied or accessed.

| Check | Result | Evidence |
| --- | --- | --- |
| App opens cleanly | PASS | Both seeded bots appeared in Chrome; no browser console errors. |
| Both legacy bots migrate | PASS | Cloud preference removed from first bot; second bot fell back from `old-box` to `{instanceId: "qa", model: "default"}`. Neither retained a cloud preference. |
| One-time migration notice | PASS | Box-engine bot had exactly one persisted notice before and after stopping/restarting the isolated harness and reloading Chrome. Cloud-preference-only bot had no notice, consistent with the plan restricting the notice to removed engine selections. |
| Migrated bots still chat | PASS | Both bots sent a user message and displayed `hello from fake claude`; no real provider or bot received a message. |
| Credential removed on settings save | PASS | Raw seeded config retained `box` before save. Changed Profile display name in UI and blurred the field; persisted name became `QA Dell Cloud Saved`, and `box` was absent from config afterward. |
| Bot settings | PASS | Computer choices were only `This computer` and `Off`; local choice was disabled in browser. No cloud picker or Box token control. |
| App settings | PASS | Connections listed Composio, xAI, and Trello fields; no Box token field. App Settings has no global computer picker. |
| Computer panel | PASS | Only `This computer` / `Off`, with local disabled in browser and desktop-app guidance. No cloud wording or provisioning controls in the panel. |
| Connected-app search | PASS | Default catalog included Dropbox. Searching `Dropbox` returned it, and it remained visible under `Data & Storage`. No Composio credentials were added. |
| Removal search | PASS | `box.ascii`, `boxAgent`, `GBS_BOX_TOKEN`, `computer-proxy` search across src/server/electron/scripts matched only the intentional `LEGACY_CLOUD_COMPUTER_DRIVER = "boxAgent"` in `server/config.ts:96`. |

## Automated validation

- `pnpm typecheck`: PASS.
- `pnpm test`: PASS, **38 test files / 305 tests**.
- `pnpm build`: PASS; existing advisory for chunks larger than 500 kB.
- Worktree tracked/untracked status remained clean after validation. Build output was not committed.

No failure requiring a new bug task was found. Local Electron screen capture, permissions, and computer tooling were deliberately not exercised; they remain a separate desktop verification item. Existing review-board checkbox marks were not changed.

## Shared task and cleanup

Requested outcome for `afc509fa-f749-4497-a998-8a3dec1a910d`: move to **review** with the passing results above and the explicit Electron limitation. The update is pending authorization for the live task API: this turn prohibits touching port 8899, and no shared-task connector tools are exposed. No request to 8899/5199 or direct access to `~/.gbs` was made.

Both QA browser sessions, both isolated harnesses, and both Vite processes were stopped. Both `$TMPDIR/gbs-qa-dell` and `$TMPDIR/gbs-qa-dell-cloud` were deleted. No live process was stopped/restarted or real bot messaged.
