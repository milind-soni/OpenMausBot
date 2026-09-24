---
status: done
created: 2026-08-13
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: project mentions
owner: codex
related: [done--projects-screen.md]
---

# Add project references with hashtags

Let users reference registered projects through stable `#project-name` mentions in chats, rooms, room bulletins, and bot descriptions. Mentions must resolve to trusted registered paths for agents without changing the user's visible text or accepting arbitrary filesystem paths.

---

## 1. Project identity and shared UI state

- [x] **Assign stable, unique mention slugs to project records** — `electron/projects.mjs:1`, `src/types/gbs.d.ts:1`. Migrate existing records safely and expose labels such as `#gerer-build-studio`.
- [x] **Centralize renderer project state for all project-aware surfaces** — `src/state/projects.tsx:1`, `src/App.tsx:1`, `src/components/ProjectsScreen.tsx:1`. Load once, refresh after mutations, and retain the desktop-only fallback.

## 2. Mention authoring and display

- [x] **Add hashtag autocomplete to direct and room chat composers** — `src/components/Composer.tsx:1`. Integrate keyboard navigation with the existing `@bot` picker and insert stable project slugs.
- [x] **Support project autocomplete in room bulletins and bot descriptions** — `src/components/GroupView.tsx:120`, `src/components/SettingsPanel.tsx:125`. Reuse one mention-aware textarea/picker pattern.
- [x] **Render known project references as consistent inline chips** — `src/components/ProjectMentionText.tsx:1`, `src/components/ChatView.tsx:220`, `src/components/GroupView.tsx:45`. Preserve copying, editing, wrapping, and plain text for unknown hashtags.

## 3. Agent resolution

- [x] **Resolve mentions against trusted desktop project metadata** — `server/projects.ts:1`, `server/index.ts:310`. Supply agents with canonical project names and paths, and select a working directory only when one unambiguous available project applies.
- [x] **Cover direct chats, room messages, room bulletins, and bot descriptions** — `server/index.ts:310`, `server/index.ts:480`. Apply predictable precedence and report missing referenced folders without inventing paths.

## 4. Verification

- [x] **Add parser, migration, prompt-resolution, and UI-flow coverage** — `server/projects.test.ts:1`, `electron/projects.test.mjs:1`, `src/components/Composer.tsx:1`. Run type-checks, all tests, production build, and minimum-size visual checks.
