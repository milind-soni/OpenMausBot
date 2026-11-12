---
status: todo
created: 2026-11-12
updated: 2026-11-12
scope: independent first-run polish QA
owner: Z / Marty
related:
  - review--first-run-ux-friction.md
---

# Independent QA: first-run polish needs corrections

Reviewed **feat/first-run-polish at cef5615**, independently checked out as **qa/soso-first-run-polish** in `/Users/esoefildine/Documents/Dev/GBS-worktrees/soso-first-run`. Application source was not modified. Verdict: **changes required**, despite passing automated checks. Z's Preview checkout and the live application were untouched. The findings below concern the reviewed revision, not subsequent work by Marty or Z.

## 1. High — Local-only guarantees overstate connected AI behavior

- [ ] **Marty: distinguish local storage from AI processing before approving onboarding copy** — `src/lib/onboardingCopy.ts:35`, `src/lib/onboardingCopy.ts:47` (also the speech assertion at line 49).

**Scenario and evidence:** A new user sees “100% Local-First: Your chats and project files stay on this computer.” The permissions step also says “Everything is optional and stays private on this computer.” Both were observed in the running UI (the permissions step used a simulated Electron bridge). A user could reasonably read these as a promise that conversation/project content never leaves the computer, even when using connected AI.

The implementation does not provide that guarantee: `server/index.ts:527` passes text, attachments, transcript and project context into the configured AI adapter; `server/drivers/grok.ts:20` defaults to `https://api.x.ai/v1`, lines 137–144 construct messages from the system prompt, transcript and current user text, and lines 75–78 POST those messages to `/chat/completions`. `server/drivers/claude.ts:467` writes the user message into the connected CLI, and `server/drivers/codex.ts:446` sends it through `turn/start`. Local orchestration and storage do not make these AI services local inference. This is a source-path finding; **no real provider request was made** to prove it.

The narrower speech guarantee also needs care: `electron/resources/speech-helper.swift:33` sets `requiresOnDeviceRecognition` only **if** the recognizer reports on-device support. Otherwise it continues without enforcing that condition. The unconditional “Speech is transcribed privately on your computer” is therefore not substantiated for every supported device. Actual remote speech fallback was not exercised.

**Suggested correction:** State that Studio stores chats/project folders on the **computer running Studio**, then explicitly explain that connected AI apps receive messages and relevant content needed for the requested work, under those services' policies. Avoid suggesting that entire folders are automatically uploaded. For speech, enforce local-only recognition with an honest unavailable state, or qualify the copy to match the actual path. Update `src/lib/onboardingCopy.test.ts:39` and its nearby privacy assertions so tests do not require the misleading guarantee. Marty owns final wording; this review does not duplicate his copy changes.

## 2. High — Every default browser folder chip submits an invalid path

- [ ] **Z: make the suggested home-relative paths usable by the host API** — `src/lib/projectSuggestions.ts:3`, `src/components/ProjectsScreen.tsx:140`, `src/components/ProjectsScreen.tsx:151`, `src/components/ProjectsScreen.tsx:159`; receiving validation is in `electron/projects.mjs:128` and `electron/projects.mjs:286`.

**Reproduction:** In a fresh browser workspace, open Projects. Choose **Folder on your computer**, **New folder**, or **From GitHub**; click `~/Projects`, then submit (enter a folder name or GitHub link as appropriate). The fixture's home directory already contained Projects, Documents, Desktop and workspace, so this was not a missing-directory failure.

Actual captured UI requests and server responses:

| Action | Relevant request data | Result |
| --- | --- | --- |
| Add existing | `projectPath: "~/Projects"` | HTTP 400, `Project folder must be an absolute path.` |
| Create folder | `parentPath: "~/Projects", name: "qa-chip-folder"` | HTTP 400, `Parent folder must be an absolute path.` |
| Copy from GitHub | `destinationPath: "~/Projects/qa-repository"` | HTTP 400, `Clone destination must be an absolute path.` |

The clone chip correctly appends the repository name, but the destination is still unusable. A manual absolute path successfully created `qa-real-folder` (HTTP 201), and an absolute parent chip inferred from that registered project successfully added its Projects parent (HTTP 201). All of those operations were inside the disposable fixture. No GitHub repository was actually downloaded: clone validation failed before Git execution.

[Observed add-folder error](evidence--first-run-polish/folder-chip-existing.png)

**Suggested correction:** Resolve supported `~`/`~/…` suggestions on the **host**, before canonical validation, or return labeled absolute host suggestions from a guarded API. Do not resolve against the browser visitor's machine. Preserve the existing canonical/symlink checks and home containment for create/clone. Add a UI-to-server regression using a chip-generated value, plus checks that expanded traversal or a symlink cannot escape the allowed home root. Existing helper tests only validate the string, not that the server accepts it.

## 3. Medium — Active filters overflow the Task Board at 1024px

- [ ] **Z: fit the active filter state into the available content width** — `src/components/TaskBoardScreen.tsx:741`, `src/components/TaskBoardScreen.tsx:742`, `src/components/TaskBoardScreen.tsx:924`.

**Reproduction:** Use a 1024 × 900 browser window with the normal expanded sidebar. On Task Board, enter `QA`, select No project folder / Unassigned / Review, then enable Research, High and Overdue in Filters. The secondary badge correctly reads 3 and the total reset correctly reads Clear (7). The extra reset button and badge reveal the layout failure.

**Measured evidence:** The default filter container has `clientWidth=672` and `scrollWidth=672`. With those filters active, `clientWidth` stays 672 but `scrollWidth` becomes **739**. The row is forced not to wrap by `lg:flex-nowrap`, Search cannot shrink below 180px, and all selects/reset controls refuse to shrink. Focusing the added control horizontally scrolls the surrounding layout: the row's left edge moved from x=336 to x=285, and the screenshot shows the sidebar search/avatar area cut off at the left. Remaining on one row is not sufficient when the row no longer fits its content area.

[Observed 1024px overflow](evidence--first-run-polish/task-filters-1024-active.png)

**Suggested correction:** Budget widths against the actual main-content container, including badge/reset states; permit Search/selects to shrink or move the reset into the popover. Use container-based wrapping/scroll containment if a single line cannot fit. Validate both default and active states at 1024px, and repeat with long project/bot names. Do not silently scroll or clip the entire shell.

## Checks that passed

| Check | Actual evidence |
| --- | --- |
| Blank profile | Continue disabled; Continue without email enabled. |
| Continue without email | Name `  QA   Reviewer  ` saved as `QA Reviewer`; an entered email was omitted (`email: ""`). Reload retained the saved local profile. |
| Optional email | `ALEX@EXAMPLE.INVALID` saved as `alex@example.invalid` with name `Alex QA`. |
| Skip all | Gate marked `skipped`; server profile remained blank; no engine was needed to enter the app. |
| Missing AI apps | Browser onboarding showed optional/missing wording and allowed continuing. |
| Engine state display | With a **controlled API fixture**, signed-out Claude displayed a warning/sign-in instruction; ready Codex displayed a check; missing Grok and Antigravity displayed neutral minus icons. Show command exposed `claude`. No real CLI auth check was performed. |
| Host/permission presentation | With a **simulated win32 Electron bridge**, engine copy said “this PC”, denied microphone showed Open Settings, and Start using Studio finished without enabling it. This is not native OS permission QA. |
| Projects empty state | All three quick-start choices opened the expected form. Header title and Add project remained visible at 1024px. Manual absolute-path creation and a known absolute parent chip succeeded. |
| Task empty starters | All three templates opened with their expected titles and definition-of-done text. Research template created a task with HTTP 201, research category and two acceptance criteria. |
| Filter behavior | Research kept that task visible; Bug hid it; Clear restored filters. Escape closed the filter popover. Badge counts were correct. |
| Bot empty starter | After clearing **only the disposable SoSo conversation**, hero showed `Your Lead Full-Stack Developer.` with no raw persona instructions. Architecture starter filled the composer; persisted message count stayed zero. No send/model turn occurred. |
| Typecheck | `pnpm -s typecheck` passed. |
| Tests | `pnpm -s test`: **337 passed in 44 files**. |
| Build | `pnpm -s build` passed; existing >500 kB chunk advisory remains. |

## Isolation and limits

- Used an isolated worktree at the exact reviewed revision, a disposable home, `GBS_DATA_DIR` and `GBS_PROJECTS_FILE`, and only an unknown-driver fixture fleet. Dependencies were reused via symlink; no install was run.
- Harness **127.0.0.1:59948**, Vite **127.0.0.1:59949**; neither 8899 nor 5199 was used. A named Playwright Chrome session used fresh browser storage. Non-loopback browser HTTP traffic and conversation-send requests were blocked.
- First-run/profile/project/task operations changed only disposable fixture data. Automated tests used their normal throwaway homes/fake providers. No paid model turns, live data changes, main checkout edits, z-preview edits, merges or pushes.
- Native Electron/TCC, real AI authentication/inference, clipboard permissions, actual GitHub downloads and README screenshot recapture were **not tested**. No production privacy behavior is claimed from the absence of network traffic in this deliberately offline QA rig; the privacy finding is grounded in implementation paths.
- Findings and screenshots are filed locally through the repository's tool-accessed board. No live shared board/Trello data was changed, respecting the no-live-data instruction.
