---
status: done
created: 2026-08-15
updated: 2026-08-15
scope: per-agent and per-room Tasks side panel
owner: claude
related: [docs/dev/plans/implementation--tasks-side-panel.md]
---

# Tasks side panel for agents and rooms, plus mobile preview auto-open fix

Add a "Tasks" panel to bot chats (tasks assigned to that bot) and rooms (tasks in the room's linked project, settable via a new picker). Bundled: the mobile preview panel no longer auto-opens on first load. Full design in `docs/dev/plans/implementation--tasks-side-panel.md` (approved 2026-08-15).

---

## 1. Mobile preview auto-open fix

- [x] **Default `mobilePreviewOpen` to closed** — `src/components/ChatView.tsx`, `src/components/GroupView.tsx`. No longer opens unprompted at wide window widths; only opens after the user has explicitly toggled it once. Committed and verified separately (commit `0a79e21`).

## 2. Room → project linking

- [x] **Add `projectId` to `GroupRecord`/`patchGroup`** — `server/store.ts`.
- [x] **Accept `projectId` in `PATCH /api/groups/:id`** — `server/index.ts`, validated as string or null.
- [x] **Add `projectId` to client `Group` type + `patchGroup` action** — `src/state/store.tsx`.

## 3. `TasksPanel` component

- [x] **Build `src/components/TasksPanel.tsx`** — read-only task list (status, priority, due date, tags), reusing `STATUS_ICONS`/`STATUS_LABELS`/`PRIORITY_STYLES` (now exported from `TaskBoardScreen.tsx`). Clicking a task opens the full Task Board.

## 4. Wire into chat and room views

- [x] **`ChatView.tsx`**: Tasks button + rail/drawer panel, filtered by `assigneeBotId === bot.id`.
- [x] **`GroupView.tsx`**: Tasks button + rail/drawer panel, filtered by `projectId === group.projectId`; project picker (`state.taskProjects`) shown in the panel header.

## 5. Tests

- [x] **Server test for `PATCH /api/groups/:id` projectId** — `server/index.test.ts`: sets, persists, clears, and rejects an invalid type.
- [x] **`pnpm typecheck`, `pnpm test` (236/236), `pnpm build`** all pass.

## Manual verification

Verified end-to-end in a real browser against an isolated scratch server/data-dir (not the user's live session): seeded a bot with an assigned task, a room linked to a real registered project with a task in that project. Bot Tasks panel showed the assigned task with correct priority/status; room Tasks panel showed the project picker pre-filled and the project's task; clicking a task opened the Task Board with both tasks visible and correctly tagged. Confirmed neither panel (nor mobile preview) auto-opens on load.

### QA Verification (Dell)
- **Mobile Preview Auto-Open Regression Check:** Confirmed `mobilePreviewOpen` in both `ChatView.tsx` and `GroupView.tsx` now defaults to `localStorage` state (false on first load). Auto-open on wide viewports is completely resolved.
- **Tasks Side Panel Audit:** Verified `TasksPanel` filtering (`assigneeBotId` for bots, `projectId` for rooms), project picker integration in room headers, and navigation to `TaskBoardScreen`.
- **Backend & Types:** `PATCH /api/groups/:id` validated in `server/index.test.ts` for string/null/invalid type handling. `pnpm typecheck` passed cleanly. Zero defects identified.

