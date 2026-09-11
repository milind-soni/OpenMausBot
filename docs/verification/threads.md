# Independent threads and sidebar

Launch the real renderer and server with only an offline provider and a
disposable data directory:

```sh
node --experimental-strip-types scripts/verify-threads.ts
```

Open the printed `previewUrl`. The fixture seeds Pepper with three threads,
two different saved model choices, an optional Email folder, and a Launch team
group with separate histories. New turns deliberately remain running so that
switching and Stop can be exercised without a real provider or account.

## Check the real UI

1. Expand Pepper and open Triage Gmail. Confirm its conversation and model.
2. Send a message, then select Triage iCloud and send another. Both sidebar
   rows should show Working. Changing the selection must not move messages.
3. Stop iCloud. Gmail must remain Working; its Stop control still targets Gmail.
4. In an idle thread, change its model. Select a sibling and return; each
   should retain its own choice. Model/account/approval controls apply to the
   visible thread, not all conversations belonging to the bot.
5. Rename a thread through its row menu. Remove the Email folder through its
   settings and confirm **Delete folder, keep threads**. Histories and model
   selections must remain, now directly beneath Pepper.
6. Expand Launch team and select its separate histories. Group collaboration
   retains the existing serialized behavior; this does not enable concurrent
   group member turns.
7. Check the model selector in the header opens downward and Ask/Auto sits
   inside the composer beside attachments. Both menus must stay visible.
   Selecting a thread must not scroll the whole document or hide the header.
   Test keyboard access to row menus too.
8. Use **New folder** beside Pepper, without opening a new thread. Give it an
   emoji icon and confirm the thread count and selected conversation do not
   change. **New thread** is one plain button that creates immediately in the
   current folder (or unfiled when outside a folder), without a dropdown.
   A folder's **+** creates directly inside it; **Move to folder** remains in
   the thread's actions menu. Click a folder icon to edit it; try a custom
   combined emoji, an invalid text value (retain the form and show an error),
   and the default icon. Bot and folder chevrons stay before their names,
   without a separate hover fill; keyboard navigation still shows a focus ring.
9. Reorder folders by dragging both a folder label and its row edge. Confirm
   order after reload. Also use **Move folder up/down** from the folder menu
   with the keyboard; end-of-list actions are disabled. Dropping a folder onto
   another bot must not move folders or sidebar sections. Escape closes the
   menu and returns focus to its trigger.
10. In **Settings → General → Parallel threads**, select one. Start Gmail,
    then send in iCloud. The latter should show **Queued** in the sidebar and
    explain the free-slot wait above its composer, without a user message
    prematurely appearing in the transcript. Stop Gmail: iCloud should start
    and show its normal working animation. Raising the limit starts waiting
    work; lowering it leaves active work alone. Reload to check persistence.
11. Click a bot's main row: it must open its last-selected conversation without
    expanding the thread tree. Its separate chevron controls the tree. Repeat
    in Comfortable, Compact, and the Icons view (history is in the header in
    Icons view).
12. In **Settings → Appearance**, turn **Show threads** off. Bot trees, folder
    creation, the bot context menu's new-thread actions, and **All threads**
    disappear; the selected transcript, model, queues, and running jobs remain.
    Group/channel histories are unchanged. Background working, queued, unread,
    and waiting conversations remain reachable through activity-only controls.
    The header stays uncluttered; **Other activity** appears below it only when
    there is sibling activity, including when the sidebar is closed.
13. Stop a running job through its activity entry while a sibling is queued;
    verify only the chosen job stops and the queued message starts normally.
    Reload and confirm Show threads remains off. Turn it back on to recover
    all histories/folders. Also toggle off/on without reloading and check that
    folder disclosure state survives. Check the Appearance switch in a narrow
    window and keyboard navigation through bot rows and activity controls.

For approval verification, new fake-provider launches also write fixture-only
`<thread-id>.launch.json` receipts inside the printed disposable data directory.
The live broker in their `mcpConfig.mcpServers.ogb` entry can be exercised using
the same `permission` recipe in `server/thread-capacity-api.test.ts`. Request a
synthetic approval, switch away, and navigate back using an activity control
with Show threads off. Answer **Allow once** and verify that broker receives
the matching answer. This proves the app's approval routing, not a real model
or command execution. Never publish the raw launch receipt: it contains
short-lived fixture capabilities.

### Optional-thread display walkthrough

The isolated renderer was exercised with Show threads on/off, direct bot
selection, an unread sibling, a real pending permission broker, and thread-scoped
Stop. These screenshots show the actual offline fixture, not mockups:

| Threads shown | Threads hidden |
| --- | --- |
| ![Threads shown](images/optional-threads/threads-shown.jpg) | ![Threads hidden](images/optional-threads/threads-hidden.jpg) |

![Appearance settings](images/optional-threads/appearance.jpg)
![Approval remains reachable with threads hidden](images/optional-threads/approval-hidden-mode.jpg)

The offline CLI may report an interrupted subprocess when stopped; the checks
here concern ownership, state and navigation, not real-provider behavior.
The seed/setup path uses the same HTTP and control commands as the API tests.
This renderer fixture does not test a native mobile device or real computer use.

## Permanent regression checks

```sh
pnpm exec vitest run server/independent-threads-api.test.ts server/paired-thread-targets-api.test.ts server/direct-screen-settlement-api.test.ts server/bot-projects-api.test.ts server/thread-capacity-api.test.ts src/components/BotThreads.test.ts src/components/BotProjects.test.ts src/components/ThreadConcurrencySettings.test.ts src/components/ComposerQueuedMessages.test.ts src/lib/folder-order.test.ts src/state/store.test.ts
```

These cover thread-pinned tools and permissions, stale legacy phone requests,
bounded final screenshots, late frame rejection, retained folder histories,
and background event isolation. Capacity tests run ten distinct fake-provider
processes concurrently, queue/cancel overflow, and exercise limit changes while
an approval is pending without revoking active capabilities. Folder tests cover
validated emoji persistence, complete-order permutations and failed saves.
Integration cases launch their own fixture and
print retained JSON evidence paths next to the server logs.

Stop the foreground launcher with Ctrl-C. It closes only its own UI/server
and deletes its disposable home; the printed server log remains available.
