---
status: review
created: 2026-09-24
updated: 2026-11-12
scope: first-run UX audit and onboarding friction
owner: Z
related:
  - docs/dev/fixes/done--projects-screen.md
  - docs/dev/product-copy--onboarding-auth-sync-updates.md
  - docs/dev/plans/implementation--browser-add-project.md
---

# First-run UX audit: Onboarding, initial bot interaction, and task board friction

Comprehensive UX and motion design audit of a new user's first 5 minutes in Gerer Build Studio. Evaluates the onboarding funnel, local engine detection, first-chat discovery, Projects screen responsiveness following commit `de11fd0d`, Task Board density, and brand consistency.

---

## 1. High friction & onboarding blockers (P0)

- [?] **Fix hardcoded macOS platform copy in engine diagnostics** — `src/components/Onboarding.tsx:170`. The text reads *"Bots run on the AI tools already on this Mac"*. When running on Linux (including containerized dev environments) or Windows, this breaks trust and contradicts cross-platform packaging. Use dynamic detection (`window.gbs?.platform` or userAgent fallback) to render "Mac", "PC", or "system". Implemented: copy now reads "this Mac" / "this PC" / "this computer" from `window.gbs?.platform`.
- [?] **Eliminate false-positive warning icons for uninstalled optional engines** — `src/components/Onboarding.tsx:181, 193, 203, 215`. The `warn` prop is unconditionally passed to `<StatusRow>` for Claude Code, Codex, Grok Build, and Antigravity. Any missing optional engine is rendered with an alarming orange warning triangle (`AlertTriangle`) and orange background, signaling a broken system instead of an optional enhancement. Only show warnings for engines that are installed but unauthenticated (`state === "available" && !authenticated`). Implemented: missing optional engines show a neutral dash; warnings only for installed-but-signed-out engines, or on Claude Code when no engine is installed. Installed-but-signed-out engines no longer show a green check.
- [?] **Replace raw agent system prompts in new bot chat empty states** — `src/components/ChatView.tsx:487-493`, `server/default-bots.ts:16-52`. When a user clicks any bot for the first time, `bot.description` is displayed verbatim in the hero card. For default bots, this dumps internal prompt engineering instructions (*"Role: You are the CEO and Lead Project Manager. Personality & Task: Your primary role is to oversee..."*) directly to the user. Replace with human-facing role summaries and actionable starter suggestion chips (e.g. *"Plan a roadmap"*, *"Draft architecture"*). Implemented in `src/lib/botIntro.ts`: persona prompts are reduced to a role line ("Your CEO and Lead Project Manager."), plain descriptions are kept, and role-based starter chips prefill the composer.
- [?] **Prevent header clipping and wrap on Projects screen at narrow breakpoints** — `src/components/ProjectsScreen.tsx:314-338`. In narrow windows or split viewports, the left header title block lacks `min-w-0` and truncation, while the subtitle (*"Local workspaces for your bots and code."*) competes with action buttons. The `Add project` button lacks `shrink-0` and `whitespace-nowrap`, risking awkward multi-line wrapping in fixed `h-[64px]`. Add `min-w-0` to the title block, hide the subtitle on compact screens (`hidden sm:block`), and add `shrink-0 whitespace-nowrap` to the button. Implemented as specified, plus an `aria-label` on the refresh button.

---

## 2. User experience & journey friction (P1)

- [?] **Align Step 0 with the local-first vs cloud-sync product copy specification** — `src/components/Onboarding.tsx`, `src/lib/onboardingCopy.ts`, `docs/dev/product-copy--onboarding-auth-sync-updates.md:19-46`, `docs/guide/copy-sweep.md`. Implemented: Step 0 now displays a prominent local-first guarantee banner (*"100% Local-First: Your chats and project files stay on this computer."*), labels email as optional and only for product updates (*"Optional — only used if you want occasional product updates."*), and provides an explicit *"Continue without email"* button (`resolveOnboardingProfile` saves a local-only profile with `email: ""`). *(Note on audit deviation: instead of splitting Step 0 into two separate screens 0A/0B, we kept a single low-friction Step 0 card with both "Continue" and "Continue without email" actions, and also applied Marty's copy sweep to Step 1 "Your AI apps" with a "Show command" + "Copy" toggle and neutral optional wording, and Step 2 "Studio permissions".)*
- [?] **Improve manual path entry UX for browser project creation** — `src/components/ProjectsScreen.tsx`, `src/lib/projectSuggestions.ts`. Implemented: in browser sessions (`!window.gbs?.projects`), `AddProjectModal` now renders `BrowserFolderSuggestions` below the path input in `existing`, `create`, and `clone` modes with a clear host hint (*"This folder is on the host computer running Gerer Build Studio."*) and clickable home-relative chips (`~/Projects`, `~/Documents`, `~/Desktop`, `~/workspace`, plus any unique parent directories inferred from registered projects). In `clone` mode, clicking a suggested folder chip automatically appends the repository folder name when a GitHub URL is entered. *(Note: since no server directory-probing API exists, safe static home-relative suggestions + registered project parent folders are used.)* Also applied Marty's plain-language copy sweep across `ProjectsScreen.tsx`.
- [?] **Refactor Task Board filter bar to prevent multi-row screen crowding** — `src/components/TaskBoardScreen.tsx`, `src/lib/taskBoard.ts`. Implemented: the filter bar now stays on a single row at `1024px` (`lg:flex-nowrap`) with Search and the 3 most-used filters inline (`Project`, `Assigned bot`, `Status`). Secondary filters (`Category`, `Priority`, `Label`, `Overdue`) moved into a *"Filters"* popover with an active-count badge (`secondaryTaskFilterCount`) and a *"Clear"* button inside the popover header, plus an inline *"Clear (N)"* reset when any filter is active.

---

## 3. Motion, layout polish & delight (P2)

- [?] **Add smooth drag-over and card placement micro-interactions on the Task Board** — `src/components/TaskBoardScreen.tsx`. Implemented: dragged task cards now show a lifted-card elevation (`scale-[1.02] shadow-xl border-accent/60 opacity-60`), active drop columns highlight with an accent border/ring (`border-accent/55 bg-accent/[0.04] ring-1 ring-accent/25`), target cards render an animated top insertion bar, and transitions use `duration-150 ease-out` while respecting `prefers-reduced-motion` via `motion-reduce:transition-none motion-reduce:transform-none`.
- [?] **Add responsive empty-state illustrations and quick-actions** — `src/components/ProjectsScreen.tsx`, `src/components/TaskBoardScreen.tsx`, `src/lib/taskBoard.ts`. Implemented: both Projects and Task Board empty states now feature a primary-accent CTA (`bg-accent text-white hover:brightness-110`) and one-click quick-start options (`Folder on your computer`, `New folder`, `From GitHub` on Projects; `Plan project roadmap`, `Research a topic`, `Draft a guide or doc` starter templates on Task Board that open `TaskModal` pre-populated with acceptance criteria).

---

## 4. Branding & screenshot verification

- [x] **Verify absence of legacy product branding in active interface** — Code audit across `src/`, `server/`, `electron/`, and metadata confirmed that the former product identity (*OpenMausBot* / *OMB*) is completely removed from all visible user interfaces, window titles, settings, and logs. Upstream attribution in `README.md:291` is appropriate for open-source compliance.
- [ ] **Recapture 7 README screenshots from running desktop build** — `docs/screenshots/hero.png`, `model-picker.png`, `computer-panel.png`, `approval-card.png`, `marketplace.png`, `context-menu.png`, `app-settings.png`. Existing screenshots predate recent UI refinements (Usage Analytics toggle in Settings, Projects header updates, and Codex tool fixes). Requires running on a host with an active display server or macOS desktop environment.

---

## Review handoff — 2026-11-12

All first-run UX items across Sections 1, 2, and 3 are implemented on branch `feat/first-run-polish` (`/Users/esoefildine/Documents/Dev/GBS-worktrees/z-ux`). Only the README screenshot recapture in Section 4 remains `[ ]` per instructions.

### Summary of changes (`feat/first-run-polish`)
- **Task Board filter bar, drag-and-drop & empty state** (`75e88ed` — `src/components/TaskBoardScreen.tsx`, `src/lib/taskBoard.ts`, `src/lib/taskBoard.test.ts`):
  - Single-row filter bar at `1024px` (`lg:flex-nowrap`) with Search + Project + Assigned bot + Status inline; Category, Priority, Label, and Overdue inside a **Filters** popover with active-count badge (`secondaryTaskFilterCount`) and **Clear** action.
  - Drag-and-drop lifted-card elevation (`scale-[1.02] shadow-xl`), drop-column ring/highlight, target card insertion bar, and `motion-reduce:transition-none motion-reduce:transform-none`.
  - Empty state primary-accent CTA (`+ Create first task`) and quick-start presets (`TASK_STARTER_PRESETS`).
- **Projects screen browser folder suggestions, host hint & empty state** (`d062fc0`, `6e2c7fc` — `src/components/ProjectsScreen.tsx`, `src/lib/projectSuggestions.ts`, `src/lib/projectSuggestions.test.ts`):
  - Browser-mode (`!window.gbs?.projects`) host computer hint and clickable home-relative folder chips (`~/Projects`, `~/Documents`, `~/Desktop`, `~/workspace`, plus unique parent folders from registered projects; auto-appending repo name in `clone` mode).
  - Empty state primary-accent CTA (`+ Add a project`) and quick-start mode buttons (`Folder on your computer`, `New folder`, `From GitHub`), plus Marty's plain-language copy sweep.
- **Onboarding Step 0, Step 1 & Step 2** (`58c2bdf` — `src/components/Onboarding.tsx`, `src/lib/onboardingCopy.ts`, `src/lib/onboardingCopy.test.ts`):
  - Step 0 local-first guarantee badge (*"100% Local-First: Your chats and project files stay on this computer."*), optional email helper note for product updates only, and **Continue without email** button (`resolveOnboardingProfile`).
  - Step 1 (**Your AI apps**) & Step 2 (**Studio permissions**) plain-language copy, neutral optional wording, and **Show command** toggle with **Copy** button (`InstallHelp`).

### Validation
- `pnpm -s typecheck`: passed (`0` errors).
- `pnpm -s test`: `44` test files passed (`44/44`), `337` tests passed (`337/337`), including `9` unit tests in `src/lib/taskBoard.test.ts`, `src/lib/projectSuggestions.test.ts`, and `src/lib/onboardingCopy.test.ts`.
- `pnpm -s build`: passed (`vite build` succeeded in `3.41s`).
- Trello mirroring remains pending: worktree credentials are absent.
