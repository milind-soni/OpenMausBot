---
status: review
created: 2026-11-16
updated: 2026-11-16
scope: conversation sidebar grouping and layout
owner: Yv
related: []
---

# Group and polish the conversation sidebar

Improve the sidebar shown in the user's screenshot using the existing theme.

- [?] Group pinned bots, rooms and remaining bots under collapsible, counted headings; show unread section signals and expand matching sections during search — `src/components/Sidebar.tsx:591`.
- [?] Compact avatars and rows, clarify selection, clean Markdown snippets and preserve existing conversation actions — `src/components/Sidebar.tsx:52`, `src/components/Sidebar.tsx:135`, `src/components/Sidebar.tsx:438`.
- [?] Separate workspace navigation, tools and account controls — `src/components/Sidebar.tsx:790`. Task Board uses one active-count badge with the full breakdown in its tooltip.
- [?] Verify search, collapse, selection, context menus and narrow/expanded sidebar layouts; run typecheck and build.


Validation: typecheck and production build pass. Seven existing summary and resize tests pass. Browser checks covered section toggle, persistence on reload, search revealing a closed Rooms section and restoring its preference, and bot context-menu opening/dismissal. Visually inspected 240px, 320px and 480px sidebar widths at 1280×720 and 1440×1000 browser viewports. No new Electron run or full-suite rerun; the two known schedule-recovery failures from the preceding UI pass remain outside this change. The only browser error was the deliberately missing chat test image. No messages sent and no live conversations pinned, deleted or cleared during verification. Pinned appears only when pinned bots exist; unread counts remain available when a section is closed. Section open/closed preferences are browser-local.

Local screenshot evidence is retained in `.omb-scratch/sidebar/`. Trello is unconfigured in this worktree; shared task status is managed through the task tools.
