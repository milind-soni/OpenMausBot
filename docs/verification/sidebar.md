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
