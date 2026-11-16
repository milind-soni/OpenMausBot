---
status: review
created: 2026-11-16
updated: 2026-11-16
scope: visual consistency and responsive layout polish
owner: Yv
related: []
---

# UI polish across Studio's main screens

Continues the user's requested visual pass with small presentation changes using the existing dark theme. Ready for user review.

- [?] **Consistent schedule controls** — `src/components/Switch.tsx:4`, `src/components/SchedulesScreen.tsx:23`. Shared accessible switch with disabled, focus and reduced-motion states; replace native switches and text glyphs. Use line alarm icons in chat and rooms (`src/components/ChatView.tsx:21`, `src/components/GroupView.tsx:9`).
- [?] **Readable integration cards** — `src/components/AppsScreen.tsx:147`, `src/components/AppsScreen.tsx:518`, `src/components/AppsScreen.tsx:744`. Light logo tiles, remove featured duplicates from the unfiltered grid, responsive card widths and fewer redundant labels. `server/composio.ts:272` supplies longer descriptions so CSS can clamp text; regression in `server/composio.test.ts`.
- [?] **Plain task summaries** — `src/lib/taskSummary.ts:4`, `src/components/TaskBoardScreen.tsx:508`. Strip frontmatter and basic Markdown from summaries, hide revision metadata and soften status controls; underlying task content stays available in its editor. Summary regression tests cover imported descriptions.
- [?] **Compact provider icons and settings** — `src/components/ProviderIcons.tsx:48`, `src/components/SettingsScreen.tsx:334`. Replace cramped letter fallbacks with size-aware icons; let provider actions wrap as a group; simplify autosave copy.
- [?] **Readable project names** — `src/components/ProjectsScreen.tsx:631`. Give names a full line and tags a separate line so they do not compete for space.
- [?] **Preview address layout** — `src/components/PreviewScreen.tsx:439`. Use the panel surface and a full-width second address row with a concise auto-refresh label.
- [?] **Validation** — Typecheck and production build pass. Full suite: 463/465 tests across 61 files; only the two pre-existing schedule backup-recovery failures tracked in task 67855a29 remain. Final focused run: 28/28 across seven files. Visual browser checks at 1280×720 and 1024×768 covered chat, Schedules, Apps, Task Board, Projects, Preview and Settings; additional 1440×900 Preview check. Real Electron and exhaustive modal/interaction coverage were not repeated. Only browser console error was the deliberately missing image from the earlier chat rendering test. Trello is not configured in this worktree; shared board updated via task tools.

Browser screenshots are kept locally under `.omb-scratch/ui-polish/` (ignored). Restart the harness/app to load the longer catalog-description server change. UI changes arrive through Vite hot reload.
