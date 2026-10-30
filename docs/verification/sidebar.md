# Sidebar confirmations

Launch `node --experimental-strip-types scripts/verify-sidebar.ts`. It creates
an isolated fake-engine server and two disposable bots, then prints a preview
URL. Open that URL, never the user's live app. Ctrl-C closes both servers and
removes only the fixture data.

The preview mounts the actual Sidebar and StoreProvider. Verify:

1. Click Archive Sidebar Atlas: Cancel receives focus by default.
2. Shift-Tab wraps to Archive; Tab wraps back to Cancel.
3. Escape closes the dialog, leaves `Drawer: open`, and restores focus to the
   Archive trigger. No bot is archived.
4. Right-click Sidebar Atlas and choose Delete. Cancel leaves the bot intact
   and returns focus to the sidebar if the menu trigger has disappeared.
5. Repeat Delete and confirm. Only the disposable Atlas bot disappears; the
   remaining bots are unchanged and keyboard focus remains in the sidebar.

Verified on 2026-09-05 against the isolated renderer. Static regression coverage
in `src/components/SidebarBotListItem.test.ts` checks dialog semantics/copy,
chief labels, role badges, and working/waiting indicators. The interaction checks
above are manual browser verification, not assertions made by those unit tests.
This fixture covers the sidebar confirmation and bot-row result only; it does
not exercise Settings > Computers deletion or provider completion polling.
Those paths are covered by the computer-section and server Boat inventory tests.

## Mark all of a bot's conversations as read

Run `node --experimental-strip-types scripts/verify-sidebar.ts --unread`.
This opt-in fixture seeds Sidebar Atlas with twelve unread webhook-like
conversations across a folder and unfiled history, plus a running fake-provider
turn and a sibling report queued behind its capacity limit. The data directory contains `bulk-read-before.json`.
Open only the printed `previewUrl`:

1. Open **Actions for Sidebar Atlas → Mark all conversations as read**.
   While requests are pending the action shows progress and cannot be repeated.
2. All existing unread conversations for Atlas become read. Its working and
   queued indicators remain. No conversation is selected, deleted or archived.
3. Reload and inspect the same fixture's `/api/bots` response: unread flags
   remain cleared, transcripts and the queued report remain intact, and
   the fake turn is still running. Other bots retain their state.
4. With no unread conversation, the menu action is disabled. In the real
   app it also remains available with **Show threads** off; thread-pinned
   remote clients do not receive an action that targets their siblings.

`src/lib/bot-read.test.ts` covers legacy state, all folders/unfiled/archived
threads, work and approval preservation, ordered requests for 250 threads,
partial failure/retry and new-thread arrivals. `src/components/SidebarBotRead.test.ts` mounts
the actual menu to check progress, duplicate-click protection, error recovery,
Portuguese copy, hidden thread trees and a menu reopened during a read.
Folder reads use the same request helper and retain their existing tests.

Verified on 2026-10-09 in the isolated renderer: 14 unread threads became
read; all 15 conversations, transcripts, settings and the other bots were
unchanged. One fake-provider turn kept running and one sibling message stayed
queued. The cleared flags persisted after reload, and the empty action was
disabled. Progress was visible during the requests. Native desktop clients
were not exercised by this browser check.

## Section deletion

Run `OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-lifecycle-ui.e2e.test.ts --maxWorkers=1`.
The test launches its own isolated server and real renderer; never point it at
the user's live workspace. It retains the Team map lifecycle checks and also
checks deletion directly from a sidebar section header:

- Cancel gets initial focus; Tab and Shift-Tab wrap within the confirmation.
- Escape and Cancel preserve the section and its shared instructions, and return
  focus to its delete button.
- Confirming deletion removes an empty section and its shared instructions.
- Populated, pinned-only and archived-only sections can be deleted; their bots
  move to General with their conversations, pinned state and archived state intact.
- Deleting a group-only section keeps the group chat and its conversation in
  General. The confirmation explains that members and conversations are retained.
- The existing context menu still renames sections while preserving their saved
  order and collapsed state, and its delete action retains pending/retry guards.

The fixture reports its log path and keeps a snapshot and screenshot on failure.
`src/components/SidebarSectionHeader.test.ts` separately checks that the optional
delete control coexists with the context menu and does not replace or nest inside
the collapse button. Server safeguards still reject deletion during active work,
with an assigned team computer, or when moving the Chief would conflict with
General's Chief; see [Teams](teams.md) for those lifecycle checks.

## Activity, quieter rows, and notification preference

Use the full-app [threads fixture](threads.md) for channel activity, search,
and snooze interactions. Compact/quiet rows must retain live status and
keyboard-accessible owner-row New thread/New folder controls. The matching
sole thread must still appear during search even when its normal tree is hidden.

In Settings → Appearance, **Notification sounds** controls the operating
system alert sound on this computer only; it does not disable notification
banners or the bot's own notification setting. `src/lib/notification-preferences.test.ts`
and `src/lib/notify.test.ts` cover persisted preferences, blocked storage, cross-window
reads after Settings unmounts, and the silent flag sent to the desktop bridge.
Actual operating-system sound delivery requires a native Electron smoke test;
the isolated browser cannot prove it.

## Departments: dragging bots and naming them in place

Run `node --experimental-strip-types scripts/verify-sidebar-groups.ts`. It
starts a disposable fake-engine server with five bots, puts two of them in a
**Work** department and two in **Home**, and prints the address of the real app
in Advanced mode; add `?mode=simple` to it for Simple mode. Ctrl-C closes both
servers and removes only the fixture data. With `--shots <dir>` it instead
photographs each view below in a headless Chrome with a throwaway profile, from
the page's own drag events, and exits.

1. With no department, Simple's sidebar is unchanged.
2. Drag a bot over the top or bottom quarter of another: a line shows where it
   lands, and dropping saves the order (`PUT /api/bots/order`) for every client.
3. Drag it over the middle of a bot in no department: that row is ringed.
   Dropping shows a new department with both bots and its name field focused,
   "New department" selected. Enter keeps the typed name, or the default when
   it is empty; Escape puts the bots back.
4. Drag a bot over a department's heading to put it at its end, between its
   rows to place it there, and between the rows outside any department to take
   it out. With every bot in a department, a "Remove from department" place
   shows at the top while a bot is dragged.
5. Alt+Up/Down moves the focused row within its list and announces its new
   position. A bot's menu → **Move to department** lists the departments,
   **New department…** and **Remove from department**, for touch and keyboard.
6. A department's ⋯ → **Rename department** edits its name in the heading in
   Simple (Advanced keeps its dialog); **Delete department** says the bots stay.
7. Switch to Advanced: the same departments and order show, and rows drag the
   same way.

`src/lib/sidebar-bot-drop.test.ts` covers where a drop lands,
`src/components/Sidebar.departments.test.ts` the sidebar's wiring, and
`src/components/SidebarSectionHeader.naming.dom.test.ts` the name field. The
headless pictures cannot prove the operating system's own drag image or a drag
between two windows.
