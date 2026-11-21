# Hand-off status: who's working on what

When a bot hands work to another bot, its "Sent to …" row in the asking conversation carries a small status
chip that updates live: **Claimed**, **Working**, **Waiting on <bot>** or **Waiting on you**, then **Done**
(the row itself opens the conversation with the result) or **Failed: <one line why>**. The conversation that
does the work carries the same status, so its row in the Inbox's active list says the same words. There is
no new page and nothing to press; it is display only and never holds the work up.

The status is read from the assignment records each time they are written (`server/host/handoff-status.ts`);
no field is added to them. The rows it follows are kept in `handoff-lines.json` until they end, so a restart
picks them up again.

On a Team Cloud the chip also names whose request it is ("Working · for Mira") and the person a question waits
on. When the work runs in a member's private chat and the row is somewhere that member doesn't own, the chip says
only "for Mira (private)": no failure words, and the row's link loses the private chat's title. Everywhere else
the chips name no person.

Hand-offs into a room (its `comm` rows) keep their own room status and get no chip.

## Automated checks

```sh
pnpm exec vitest run server/host/handoff-status.test.ts src/components/HandoffStatusChip.test.ts src/components/ThreadChip.test.ts src/components/SidebarBotActivity.test.ts
OMB_TEST_PORTS=20900-20999 pnpm exec vitest run server/handoff-status.e2e.test.ts
```

The e2e test uses the scripted engine: Lead hands Coder a page, Coder hands Writer the copy, and Lead's row moves
through working, waiting on Writer and done while Coder's work conversation shows the same; nobody presses anything.

**What it does not prove:** phones (they show the row's English words), and a Team Cloud end to end (the unit
tests cover its names and the private case).
