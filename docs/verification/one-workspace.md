# This computer and My Cloud as one workspace

The desktop app shows This computer's bots and My Cloud's in one sidebar and
one Team map ("All bots"), each with its home. A bot on both sides (Send keeps
its id) shows once and always opens at its home: where it was made, or where
the bots were last moved. What its copy out of sight has that the home lacks
(its own chats, messages only it has in a chat both have, its automations)
shows as one line under it, and that copy, if opened anyway, says above its chat
where the chat is. Main compares a chat both have only while My Cloud answered
that look, never waking it, and reads a side's messages again only when that
side's newest message moved. Main reads the other side's bots and rooms
for the page the window shows (`electron/one-workspace.mjs`) and moves the
window to the other side when one of them is opened there. Every check below
runs on two real servers in disposable homes; nothing reaches the user's app,
data or a real Cloud.

## Main's wiring on two real servers

```sh
pnpm exec vitest run scripts/testing/one-workspace.e2e.test.ts
node --test electron/one-workspace.node-test.mjs electron/environments.node-test.mjs
```

The e2e test starts this computer's server and a Cloud home with the Send to My
Cloud fixture (`scripts/testing/cloud-send-fixture.ts`), sends Ember to My
Cloud through the real Send (so the same id is on both sides), and wires
`installOneWorkspace` between them with a fake ipcMain
(`scripts/testing/one-workspace-fixture.ts`). It checks that both pages list
every bot and room once with the same homes, that My Cloud is read with the
window's sign-in in the background and never hands a page instructions or a
model, that opening a Cloud bot hands My Cloud's page a link its own server
resolves, that after Send everything each bot still shows once at its home
with its own history (a message lands there and reaches My Cloud's copy only
with the next send, under the same id) and a chat or routine made on My Cloud's
copy shows as the line that opens it there, that a phone message into a chat
both have counts as a message only there and still does after this computer
replies, right after a send and after a restart, and that an unreachable or
asleep Cloud keeps its bots (an asleep one is never called), also after a
restart.

## The real renderer

```sh
node --experimental-strip-types scripts/verify-one-workspace.ts
```

It seeds the same two servers and mounts the whole app twice through the
isolated Vite preview: this computer's page and My Cloud's. Only main's bridges
are stand-ins (`scripts/testing/one-workspace-preview.tsx`); the one workspace
calls main's real wiring through `/__one`, and where main would move the
window the page goes to the other preview. The switcher's native menu is drawn
from main's own template.

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/one-workspace-ui.e2e.test.ts
```

drives both pages in the pinned headless browser after Send everything: rows
and badges on both pages, the switcher's All bots entry, opening a Cloud bot on
My Cloud and sending it a message that reaches only My Cloud's server, opening
this computer's bot back, the line under a bot on both sides opening My Cloud's
own chat there, the Team map with My Cloud's computers, the setting off, and an
asleep Cloud. Set
`OMB_ONE_WORKSPACE_SHOTS` to keep its screenshots (1280 px, light and dark).

## What these do not cover

The packaged app's real navigation between the two origins (main's
`connectCloudHome` and `switchEnvironment`) and the window's real Cloud cookie.
Both are the existing paths the switcher uses; check them on a packaged build
with a disposable test Cloud, never a customer's.
