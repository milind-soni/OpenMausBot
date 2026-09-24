---
status: todo
created: 2026-09-24
updated: 2026-09-24
scope: first-run UX audit and onboarding friction
owner: Z
related:
  - docs/dev/fixes/review--projects-screen.md
  - docs/dev/product-copy--onboarding-auth-sync-updates.md
  - docs/dev/plans/implementation--browser-add-project.md
---

# First-run UX audit: Onboarding, initial bot interaction, and task board friction

Comprehensive UX and motion design audit of a new user's first 5 minutes in Gerer Build Studio. Evaluates the onboarding funnel, local engine detection, first-chat discovery, Projects screen responsiveness following commit `de11fd0d`, Task Board density, and brand consistency.

---

## 1. High friction & onboarding blockers (P0)

- [ ] **Fix hardcoded macOS platform copy in engine diagnostics** — `src/components/Onboarding.tsx:170`. The text reads *"Bots run on the AI tools already on this Mac"*. When running on Linux (including containerized dev environments) or Windows, this breaks trust and contradicts cross-platform packaging. Use dynamic detection (`window.gbs?.platform` or userAgent fallback) to render "Mac", "PC", or "system".
- [ ] **Eliminate false-positive warning icons for uninstalled optional engines** — `src/components/Onboarding.tsx:181, 193, 203, 215`. The `warn` prop is unconditionally passed to `<StatusRow>` for Claude Code, Codex, Grok Build, and Antigravity. Any missing optional engine is rendered with an alarming orange warning triangle (`AlertTriangle`) and orange background, signaling a broken system instead of an optional enhancement. Only show warnings for engines that are installed but unauthenticated (`state === "available" && !authenticated`).
- [ ] **Replace raw agent system prompts in new bot chat empty states** — `src/components/ChatView.tsx:487-493`, `server/default-bots.ts:16-52`. When a user clicks any bot for the first time, `bot.description` is displayed verbatim in the hero card. For default bots, this dumps internal prompt engineering instructions (*"Role: You are the CEO and Lead Project Manager. Personality & Task: Your primary role is to oversee..."*) directly to the user. Replace with human-facing role summaries and actionable starter suggestion chips (e.g. *"Plan a roadmap"*, *"Draft architecture"*).
- [ ] **Prevent header clipping and wrap on Projects screen at narrow breakpoints** — `src/components/ProjectsScreen.tsx:314-338`. In narrow windows or split viewports, the left header title block lacks `min-w-0` and truncation, while the subtitle (*"Local workspaces for your bots and code."*) competes with action buttons. The `Add project` button lacks `shrink-0` and `whitespace-nowrap`, risking awkward multi-line wrapping in fixed `h-[64px]`. Add `min-w-0` to the title block, hide the subtitle on compact screens (`hidden sm:block`), and add `shrink-0 whitespace-nowrap` to the button.

---

## 2. User experience & journey friction (P1)

- [ ] **Align Step 0 with the local-first vs cloud-sync product copy specification** — `src/components/Onboarding.tsx:120-163`, `docs/dev/product-copy--onboarding-auth-sync-updates.md:19-46`. The current Step 0 mixes display name and email without explaining data boundaries. Users are hesitant to enter an email without knowing whether it creates an online account or telemetry. Implement the specified 0A/0B separation with a clear *"100% Local-First: Chat logs and code stay on this machine"* guarantee badge and explicit *"Continue with Local-Only Profile"* path.
- [ ] **Improve manual path entry UX for browser project creation** — `src/components/ProjectsScreen.tsx:97-117, 261-272`. In browser sessions where `window.gbs.projects` is absent, the user must manually type absolute paths on the host machine. Provide suggested directory chips (e.g. `~/workspace/projects`, `./projects`) or a breadcrumb helper to reduce path entry errors.
- [ ] **Refactor Task Board filter bar to prevent multi-row screen crowding** — `src/components/TaskBoardScreen.tsx:587-600`. The filter header mounts 7 `<select>` dropdowns plus search, overdue toggle, and clear button in a flex-wrap row. On medium-width viewports (1024px–1280px), this wraps into 3–4 lines of controls, pushing kanban columns below the fold before the user sees any tasks. Move secondary filters into a collapsed "Filters" popover or horizontally scrollable pill rail.

---

## 3. Motion, layout polish & delight (P2)

- [ ] **Add smooth drag-over and card placement micro-interactions on the Task Board** — `src/components/TaskBoardScreen.tsx:484-523, 614-620`. Task cards currently snap with standard browser drag borders. Adding a subtle layout transition (`transition-transform duration-150`), an elevated shadow on drag-lift, and an animated drop-target indicator will elevate the interface to modern design standards.
- [ ] **Add responsive empty-state illustrations and quick-actions** — `src/components/ProjectsScreen.tsx:363-373`, `src/components/TaskBoardScreen.tsx:605-607`. Ensure empty state CTA buttons match the primary accent styling across all views and include quick-start presets for immediate onboarding success.

---

## 4. Branding & screenshot verification

- [x] **Verify absence of legacy product branding in active interface** — Code audit across `src/`, `server/`, `electron/`, and metadata confirmed that the former product identity (*OpenMausBot* / *OMB*) is completely removed from all visible user interfaces, window titles, settings, and logs. Upstream attribution in `README.md:291` is appropriate for open-source compliance.
- [ ] **Recapture 7 README screenshots from running desktop build** — `docs/screenshots/hero.png`, `model-picker.png`, `computer-panel.png`, `approval-card.png`, `marketplace.png`, `context-menu.png`, `app-settings.png`. Existing screenshots predate recent UI refinements (Usage Analytics toggle in Settings, Projects header updates, and Codex tool fixes). Requires running on a host with an active display server or macOS desktop environment.
