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
   change. The new-thread dropdown's **New folder…** must also only create a
   folder. Click a folder icon to edit it; try a custom combined emoji, an
   invalid text value (retain the form and show an error), and the default icon.
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
