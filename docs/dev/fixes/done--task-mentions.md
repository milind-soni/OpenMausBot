---
status: done
created: 2026-08-15
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: "%task" chat mentions
owner: claude
related: [docs/dev/plans/implementation--task-mentions.md]
---

# Let the user reference tasks in chat with %task

Add a `%task-slug` mention to the chat composer (bot + room), mirroring `#project`: autocomplete, clickable chip rendering, and agent context injection. Full design in `docs/dev/plans/implementation--task-mentions.md` (approved 2026-08-15). Scoped to the chat composer only — bulletin/settings stay out of scope.

---

## 1. Task mention slug

- [x] **Add `mention: string` to `TaskRecord` + slugify/dedupe on create** — `server/tasks.ts`.
- [x] **Backfill `mention` for legacy saved tasks on load** — `server/tasks.ts` `validateSavedTask`/load path.

## 2. Server-side matching + agent context

- [x] **`mentionedTasks(text, tasks)`** — mirrors `mentionedProjects`.
- [x] **`resolveTaskContext(sources, tasks)`** — mirrors `resolveProjectContext`.
- [x] **Wire into both turn-context assembly points** — `server/index.ts` (1:1 and room turns).

## 3. Client mention lib + rendering

- [x] **`src/lib/taskMentions.ts`** — query-at/insert/matches, mirrors `projectMentions.ts`.
- [x] **Combined chip rendering for `#project` + `%task` in one pass** — `ProjectMentionText.tsx` now merges both match sets by position; task chips render in a distinct (warning/amber) color and open the Task Board on click.
- [x] **`Composer.tsx`**: third mention kind (`"bot" | "project" | "task"`), closest-trigger-to-caret precedence, picker UI, insertion.

## 4. Tests

- [x] Server: slug dedup (`server/tasks.test.ts`), legacy backfill, `mentionedTasks`/`resolveTaskContext`.
- [x] Client: `src/lib/taskMentions.test.ts` mirroring `projectMentions.test.ts`.
- [x] `pnpm typecheck`, `pnpm test` (247/247), `pnpm build` all pass.

## Manual verification

Verified end-to-end in a real browser against an isolated scratch server with a live Claude instance (not the user's session): created a task "Fix Qt6 styling" (mention auto-generated as `fix-qt6-styling`), typed `%fix` in the chat composer, confirmed the autocomplete picker filtered correctly and inserted the canonical mention. Sent the message and confirmed the chip rendered in amber (distinct from `#project`'s accent color). Confirmed the agent actually received task context — it called `list_tasks`/`claim_task` on exactly the referenced task rather than treating it as opaque text, and moved it to "Doing". Clicking the chip opened the Task Board, showing the claimed task.
