# Implementation plan: internal alpha launch

## Objective

Prepare Gérer Build Studio (v0.1 Alpha) for internal use: a clear first-run journey, a workspace tailored to the user's goals, consistent daily workflows, reliable previews and composer controls, accurate documentation, and a verified installer followed by a scoped Git push.

The central value proposition is: **Build your own team of AI Buddies, tailored to the work you want to do.** Success means a new user can understand the app, connect an engine, approve their team, and complete a first useful task without assistance.

Google sign-in and re-enabling app updates belong to the next version. Public release publication is separate from the requested code push. This document is the implementation plan; no application changes have been made for it.

## Current state and constraints

Inspected 2026-11-19, local branch `main`, package version `0.1.15`.

- Node 24+, pnpm 10.33.0, React/Vite UI, Electron desktop. Use existing components and provider adapters.
- `src/components/Onboarding.tsx:122` currently contains profile, engine, and optional permissions steps. Profile saving advances even on failure; address this during the flow rewrite.
- `src/lib/onboardingCopy.ts` presents engine readiness. Unknown authentication must not become a false ready claim.
- `server/default-bots.ts:15` defines a built-in fleet; `server/instances-default-fleet.test.ts` covers default-instance compatibility. Existing users must retain their teams.
- `src/components/Composer.tsx:562` uses empty-composer ArrowUp to edit the last message. Define the replacement interaction explicitly.
- `src/components/PreviewFrame.tsx:82` supports Electron webviews and browser iframe fallback; their navigation capabilities differ.
- `src/components/DocumentView.tsx` and `ChatMarkdown.tsx` render Markdown. Investigate both so image handling is consistent.
- `electron/main.mjs:343` registers updater IPC; line 357 starts it. `electron/updater.mjs`, preload APIs, Settings, packaging, and release documentation need coordinated changes.
- `electron-builder.yml` currently targets macOS arm64 DMG/ZIP and Windows x64 NSIS/ZIP. Linux and Intel Mac installers are not part of the existing configuration.
- README contains older cloud-computer and branding claims. Release instructions also contain inconsistent update behavior and generated-output guidance; reconcile against actual code and AGENTS.md.
- Existing untracked `.gbs-preview-evidence/` and `Ai workflow template/` are unrelated to this planning task. Preserve them; assess ownership before cleanup or staging.
- Studio Preview is available. Availability has been checked; application UI behavior has not been tested during planning.

## Ownership and operating rules

| Role | Responsibility | Required handoff |
| --- | --- | --- |
| Yv — CEO / PM | Scope, priorities, dependencies, launch checklist, integration, release coordination | Scope decisions and milestone evidence |
| UI/UX Designer | Shared interaction rules, onboarding screens, proposal editor, schedules and Preview layouts, motion/accessibility | Screen/state specification before implementation |
| Developer | Persistence, engine status, onboarding, workspace generation, composer, Preview, updater disablement, packaging | Tested changes and review notes |
| Tester | Baseline, edge cases, regressions, Studio Preview evidence, installer smoke tests | Independent pass/fail record |
| Marketer | Welcome/value proposition, onboarding microcopy, README, screenshot captions, alpha notes | Copy matched to implemented behavior |
| Esoe Fildine | Product decisions, milestone review, alpha go/no-go | Review of the finished journey and release candidate |

These are proposed role assignments, not claims that absent teammates have been contacted. Only Yv and Esoe are listed in this room. Work can run in parallel once people are assigned: design/copy with baseline investigation, Preview with onboarding after shared UX decisions, and documentation structure with implementation. Final screenshots wait for UI freeze.

Task lifecycle: todo → doing → review → done. Implementers submit evidence; a user or designated reviewer approves completion. Record scope changes and blockers in the board. Do not silently mark failing checks as accepted.

## Implementation order and milestones

| Phase | Planning allowance | Depends on | Exit gate |
| --- | --- | --- | --- |
| 0. Baseline and scope | 0.5 day | None | Reproducible baseline; alpha targets recorded |
| 1. Shared UX and copy | 1 day | 0 | Flow, states, keyboard rules, components specified |
| 2. Core first-run journey | 1–1.5 days | 1 | Welcome → profile → engines persists reliably |
| 3. Workspace proposal and tour | 2–3 days | 2 | Tailored team can be edited and applied safely |
| 4. Preview and composer fixes | 1.5–2 days, parallel where staffed | 1 | Navigation, images, history, path references verified |
| 5. UI unification and schedules | 1–1.5 days | 3, 4 | Consistent app-wide states and interactions |
| 6. Cleanup, documentation, release QA | 1–1.5 days | 5 | Candidate frozen; screenshots/docs/checks current |
| 7. Installer and push | 0.5–1 day | 6 | Installed build passes; scoped commit pushed |

Allow roughly 10–14 working days for one main implementer, including review time. This is a planning estimate, not a delivery promise. Confirm after Phase 0; signing, provider metadata availability, and Windows test access can affect it. Updater disablement starts in Phase 0 and is reverified in Phase 7.

## Proposed changes

### Phase 0 — Establish the alpha baseline

Owner: Developer + Tester; accountable: Yv.

1. Inventory existing onboarding, model/provider status, fleet creation, routes, composer mentions, file serving, schedules, updater, tests, and packaging. Reproduce reported issues before fixing them.
2. Record `pnpm typecheck`, `pnpm test`, and `pnpm build` results, including any pre-existing failures. Inspect existing board items to avoid duplicate fixes.
3. Work on an isolated alpha branch/worktree; preserve unrelated edits and registered project data. Use disposable application state for all QA, never the real user profile.
4. Confirm installer targets with Esoe. Proposed minimum: macOS arm64, matching this machine and current DMG configuration. Windows requires a real Windows smoke test before being described as verified.
5. Separate product label `Gérer Build Studio (v0.1 Alpha)` from the unique package version. Select a new compatible version based on release history; do not downgrade `0.1.15` to `0.1.0` simply to match the label.
6. Disable updater startup, check/download/install operations, UI prompts, and update IPC actions through one explicit alpha policy. Preserve an informational version/About view. Remove unnecessary updater bundling from alpha package commands when safe; defer broad dependency removal unless required.

Acceptance: app launches with no update checks, download, or install path reachable; baseline and platform/version decisions are recorded. Test disabled IPC calls as well as hidden buttons.

### Phase 1 — Specify a unified experience

Owner: UI/UX Designer + Marketer; Developer reviews feasibility.

1. Define shared typography, spacing, surfaces, buttons, inputs, status badges, icons, cards, dialogs, toasts, loading, empty, disabled, and error states using the existing design system.
2. Specify this journey: Welcome → Personal details → AI engines → Workspace purpose → Review your team → Studio + guided tour.
3. Define progress/back controls, saved-step resume, field validation, retry, skipping optional setup, and first-run versus existing-user behavior. Optional permissions remain available contextually, rather than blocking the journey.
4. Use one vocabulary throughout: Buddy, AI engine, workspace, project, room, schedule. Explain unfamiliar terms where first encountered.
5. Specify desktop and narrow-window layouts, keyboard focus, readable contrast, screen-reader labels, and reduced-motion alternatives. Keep task controls usable without hover.

Acceptance: every step and major interaction has normal, loading, error, and recovery states; copy avoids claims the product cannot verify.

### Phase 2 — Welcome, profile, and AI setup

Owner: Developer; Designer and Tester review.

**Welcome**

- Prominent bold title exactly `Gérer Build Studio (v0.1 Alpha)` and a short explanation of the agent hub.
- Animated existing avatars showing purposeful activity such as building, designing, and researching. Motion must not obstruct the title or Get started button; provide a reduced-motion state.
- One clear Get started action. The first screen must work without an engine or network connection.

**Personal details**

- Retain the current supported profile information, with display name and optional email. Do not add account creation or Google sign-in in this release.
- Trim and validate inputs; preserve values on Back and retry. Explain the use of optional information accurately.
- Save successfully before marking the step complete. A failed save shows an actionable error and retains the draft.

**AI engines**

- Greet the saved name: `Hi, {name}. Let's set up your AI engines.`
- Use the integrated-engine registry as the source of truth. Present installed/not installed, sign-in state, ready/error/checking, version when available, and subscription plan when the provider exposes it.
- Use explicit `Unknown` or `Not available from this engine` for unavailable auth/plan metadata. Never infer a paid plan from installation or model access alone.
- Offer engine-specific setup help, refresh/recheck, retry, and safe continuation without a ready engine. Explain that users can explore Studio but need a ready engine to run a Buddy.
- Time out diagnostics gracefully and show individual engine failures without blocking the whole screen. No credentials in UI responses or logs.

Acceptance: fresh install, offline state, failed save, no engines, installed-but-signed-out, unknown metadata, and one ready engine all produce truthful, recoverable flows. Returning users retain profiles and are not forced through onboarding again.

### Phase 3 — Personal workspace and editable team proposal

Owner: Developer + UI/UX Designer; acceptance priority: highest.

**Purpose selection**

- Offer a compact set: Development, Design, Research, Finance, and Custom. Permit more than one purpose with a primary focus; Custom accepts a free-text goal.
- Require a meaningful selection or valid custom input. Preserve choices when navigating back.
- Store preferences separately from the generated team so users can regenerate without losing their original intent.

**Recommendation**

- Explain the proposed structure and why it fits the goal. Present a team overview plus readable Buddy cards; avoid an unexplained roster.
- Each Buddy includes editable name, role, responsibilities/description, chosen engine/model, and a short reason for inclusion. Show proposed room grouping where useful and supported.
- Keep the initial team focused, normally 3–5 Buddies. Example Development team: Project Lead, Developer, UI/UX Designer, Tester. Custom and other categories must produce distinct relevant teams.
- Match model choices to currently usable engines and the live model catalog. Flag unavailable selections; do not silently assign them as ready.
- Define deterministic purpose templates as the reliable baseline; use a connected engine to refine custom goals where available. Failure, timeout, or no engine must still yield an editable draft, clearly labeled as needing engine assignment when appropriate.
- An AI-generated response is a proposal, never a command to create files, install tools, or start background work.

**Review and apply**

- Allow editing every Buddy field, adding/removing Buddies, switching models, and regenerating. Warn before regeneration replaces manual edits.
- Provide explicit Approve and create workspace and Back actions. No live fleet changes happen during proposal preview.
- Validate non-empty names, reasonable field lengths, unique identifiers, and model selections. A no-engine workspace remains possible with visibly unconfigured Buddies.
- Save profile, preferences, proposal version, approved fleet, and onboarding completion coherently. Use an idempotent apply operation so double-click, retry, or restart cannot duplicate Buddies or leave a half-created team.
- Preserve existing-user fleets. Any optional reconfiguration is a deliberate preview-and-apply action; no silent reset or deletion.

**Guided tour and first value**

- Offer Start tour and Skip for now after workspace approval; allow restart from Help/Settings and persist progress.
- Walk through Buddies/chat, rooms and mentions, projects/files, tasks, Studio Preview, schedules, apps, and settings with short contextual steps.
- Let users complete a useful first prompt with a ready Buddy. If no engine is ready, route them to setup without pretending execution succeeded.
- Request microphone/computer permissions only when relevant to a feature; declining must preserve app access.

Acceptance: Development and Design create meaningfully different teams; custom intent affects the proposal; all fields are editable; reload resumes safely; regeneration respects edits; repeated apply creates one fleet; existing users keep their data; tour can be skipped and restarted.

### Phase 4 — Preview reliability and terminal-style composer

Owner: Developer; Tester covers all shared surfaces.

**Web navigation**

- Add Back, Forward, Reload/Stop, URL display/input, and loading/error states to the relevant web Preview surfaces. Use real navigation state per tab/session.
- Disable history buttons when unavailable. Follow in-page navigation and redirects; preserve history across resize. Reload must not create an extra history entry.
- Reuse existing webview capabilities. Browser iframe fallback must honestly expose cross-origin limits rather than displaying nonfunctional controls.
- Retain existing navigation permissions, popup handling, downloads, and external-link restrictions.

**Markdown images**

- Reproduce in document Preview and chat. Resolve relative paths against the Markdown file's directory, including nested paths, spaces, encoded names, and supported local absolute paths.
- Route local images through the authorized project/file-serving mechanism. Enforce canonical path checks and symlink boundaries; do not expose arbitrary host files.
- Verify supported HTTPS images and Obsidian image embeds if the existing Markdown renderer supports them. Show alt text and a useful broken-image state when loading fails.
- Maintain aspect ratio and bounded width. Do not enable arbitrary HTML or scripts to make images work.

**Prompt history**

- ArrowUp retrieves earlier submitted user prompts; ArrowDown moves forward and finally restores the unsent draft. Limit history to the current direct chat or room and preserve chronological order.
- In multiline text, normal caret movement takes priority until the first/last line boundary. Open autocomplete menus and IME composition take priority over history.
- Recalled text is an editable new draft. Keep Edit message available explicitly; do not silently edit a previously sent message. Never resend attachments automatically.
- Verify empty history, long prompts, navigating back to the current draft, switching conversations, queued messages, and room cut-ins.

**File/folder references**

- Detect `/` and `./` at valid token positions and offer project-scoped file/folder autocomplete; keep ordinary URLs and prose intact.
- Resolve `./` from the active project. With multiple or no projects, offer an explicit project choice instead of guessing or scanning the whole computer.
- Support nested folders, spaces, keyboard navigation, Enter/Tab selection, Escape dismissal, and stable references attached to the prompt context.
- Handle renamed/deleted paths gracefully. Apply the existing project access rules and preserve `@` Buddy, `#` project, and `+` app mentions.
- If slash commands exist, give known commands explicit precedence and make path intent clear.

Acceptance: real A → B → Back → Forward → Reload flow; images render in nested Markdown documents; history restores drafts without accidental send/edit; path references resolve only within allowed project context. Add focused behavioral tests, including server tests for file resolution and new endpoints.

### Phase 5 — App-wide consistency and schedules

Owner: UI/UX Designer + Developer; Tester validates.

1. Apply the shared system across navigation, chats, rooms, projects, task board, apps, settings, onboarding, Preview, dialogs, and schedules.
2. Audit focus order, scrolling, truncation, window resizing, dark/light themes where supported, and errors/retries. Avoid unrelated feature expansion.
3. On schedules, make creation, editing, enable/disable, and cancellation clear and consistent. Show destination, prompt, cadence, timezone, next run, and existing last-run/error information accurately.
4. Improve empty states and validation for invalid or past dates. Preserve local-versus-schedule timezone meaning; test DST where the scheduler supports named zones.
5. Validate next-run display after edits and restart. Preserve schedules belonging to chats/rooms and avoid duplicate runs.

Acceptance: the same actions and states use the same components and language; schedules remain legible in compact windows; scheduling regressions pass. Test execution uses a fake clock/isolated runtime, never real scheduled messages.

### Phase 6 — Repository, README, and release candidate

Owner: Developer + Marketer + Tester; Yv controls scope.

**Repository cleanup**

- Inventory files and imports before moving anything. Retain established top-level `src/`, `server/`, `electron/`, `scripts/`, `build/`, and `docs/` unless a concrete problem justifies a move.
- Organize by responsibility inside those boundaries; remove confirmed dead files and accidental artifacts only after checking references and ownership. Do not delete unrelated untracked folders.
- Update affected imports, scripts, packaging paths, documentation links, and ignore rules. Reconcile tracked generated server-output policy with AGENTS.md and the actual packaging requirements.
- Keep user data, credentials, runtime state, evidence not intended for publication, and installers out of the source commit.

**README and documentation**

- Lead with the app name, alpha badge, concise value proposition, and a real screenshot of the frozen candidate.
- Explain onboarding, personal teams/models, chat/rooms, projects/files, tasks, Preview, schedules, connected apps, permissions, and Settings in user-facing terms.
- Include a short first-run walkthrough, supported OS/architectures, installation steps, alpha limitations, manual replacement/update guidance, and feedback instructions.
- Include developer prerequisites and exact commands: Node 24+, pnpm install, dev, dev:server, dev:desktop, typecheck, test, build, package, and package:win, with platform requirements.
- Keep the README accessible: no internal server architecture, IPC/MCP plumbing, storage schemas, or obsolete cloud-computer claims. Put needed contributor/release details in linked developer documents.
- Capture real Studio Preview screenshots with project_id evidence for web UI; use native capture for installer/desktop-only states. Use labeled TEST · data and no private chats or secrets.
- Save optimized documentation images under `docs/screenshots/`, add useful alt text, and verify Markdown images in Studio Preview itself.
- Update the guide index, release instructions, and older copy specifications so Google sign-in and updates cannot be mistaken for alpha features.

**Candidate QA**

- Freeze features; run full typecheck, tests, and build after cleanup. All new failures block the release; pre-existing failures need explicit disposition.
- Execute fresh-user and existing-user end-to-end scenarios, provider failure and recovery, all changed composer/Preview flows, and schedules.
- Test web layout at 1440×900, 1024×768, 768×1024, and 390×844 as applicable; also test the actual Electron minimum window size. Narrow web checks do not imply mobile OS support.
- Use Studio Preview snapshots after navigation, diagnostics for console/network errors, and screenshots scoped to the registered project. Record build/commit identity, steps, expected/actual results, and evidence paths.
- Designated reviewer verifies implemented items. No critical/high-severity issues remain; lower-severity exceptions need an owner and explicit alpha acceptance.

### Phase 7 — Build installer, validate, then push

Owner: Developer + Tester; accountable: Yv.

1. Confirm unique package version, product label, target platforms, candidate commit, changelog, and updater-off policy. Verify current signing/notarization availability rather than relying on old release notes.
2. Build UI and server through the package scripts. Create macOS DMG/ZIP with `pnpm package`; create Windows NSIS/ZIP with `pnpm package:win` only in a suitable build environment.
3. Inspect artifact contents and version. Record checksums and build environment; ensure the packaged application contains everything needed to run without a development checkout.
4. Install the actual installer into a disposable account/environment. Verify first launch, onboarding, engine detection, team creation, first chat, Preview images/navigation, schedules display, quit/relaunch, and retained state. Test replacing an existing installation without erasing user data.
5. Verify no update traffic or updater controls in the installed artifact. Record signing/SmartScreen/Gatekeeper status accurately; do not describe an unsigned internal build as publicly verified.
6. Prepare final scoped source/documentation commits, inspect staged contents and secret/artifact exclusions, and confirm the tested source matches the final commit. Check remote divergence before pushing; never force-push or overwrite others' work.
7. Push the agreed branch to `origin` (`myebstudios/GererBuildStudio`) after all release gates pass. The user's request authorizes this code push when implementation is complete. Publishing a public GitHub Release or uploading installers publicly is a separate action requiring authorization.
8. Hand over installer paths, checksums, commit/branch, QA evidence, known limitations, and concise internal installation instructions. A remote/credential failure must be reported as a blocker, not a successful push.

Acceptance: an installer built from the final candidate has been installed and smoke-tested; scoped source is pushed; every claimed platform has real validation or is explicitly listed as unverified.

## Verification and launch gates

| Gate | Required evidence |
| --- | --- |
| G0 Baseline | Existing failures, supported targets, version decision, isolated QA state |
| G1 Experience | Full journey and component/state specification |
| G2 Personalization | Distinct goal-based proposals, edits, durable save, retry safety, existing-user preservation |
| G3 Daily workflows | Preview navigation/images, prompt history, path references, schedule regression results |
| G4 Release candidate | `pnpm typecheck`, `pnpm test`, `pnpm build`; reviewed UI evidence; current README |
| G5 Distribution | Actual installed-artifact smoke test, updater-off verification, checksums, final commit and push |

Server changes require tests using `server/testing/` fakes, temporary state, and observable events instead of sleeps. Never point tests at real `~/.gbs`. Add tests for meaningful behavior and failure boundaries, not cosmetic implementation details. Desktop-only behavior must be verified in Electron; a Vite page alone is insufficient.

## Risks and rollback

- **Unavailable plan/auth metadata:** display unknown truthfully; expand adapters only where supported. Subscription metadata uncertainty must not hold the entire onboarding flow hostage.
- **Partial/duplicate fleet creation:** keep a draft separate from live state, apply with durable idempotency, test failures at each write boundary, and preserve recoverable prior configuration.
- **Existing-user regression:** version onboarding state, make migrations additive, and test real-shape fixtures. Reverting UI code must not require deleting user profiles or fleets.
- **Cross-origin web limits:** expose supported navigation accurately; verify native webview behavior separately.
- **Filesystem exposure:** canonicalize/authorize image and mention paths, test traversal and symlink cases, and retain write-only credentials.
- **Cleanup breaking packaging:** defer moves until behavior is stable; rebuild and install after any path changes.
- **Signing/platform limitations:** verify early; narrow claims to tested targets and report external blockers immediately.
- **Rollback:** keep changes in coherent commits. Preserve an approved pre-alpha installer and profile backup procedure. Revert the affected change or reinstall the prior internal build; do not perform destructive data rollback without a reviewed migration plan.

## Approval

Status: plan prepared for review; application implementation has not started.

Repository instruction `AGENTS.md`: “For complex implementations, write a technical plan under docs/dev/plans/ and obtain explicit user approval before changing application code.” This planning request is fulfilled by this document and its tracking checklist. Implementation approval, when requested, must use the Studio approval tool with the application scope; no duplicate approval is required if Esoe has already explicitly approved this plan.
