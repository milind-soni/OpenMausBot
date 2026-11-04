# Who can see, chat with and change each team bot

A Team Cloud bot is shared like a document: what everyone in the team gets (No access, Can view, Can chat or Can edit)
and a level for each person added. Admins and the bot's owner always edit. The contract is in
[team-cloud.md](../team-cloud.md#who-can-use-a-bot).

## Driving it

```sh
pnpm exec vitest run server/cloud-team-bot-access.e2e.test.ts server/bot-access.test.ts server/host/access-requests.test.ts \
  server/bot-visibility.test.ts src/components/bot-access src/state/team-chats.test.ts src/components/SettingsModal.groups.test.ts
```

- `server/cloud-team-bot-access.e2e.test.ts` starts a real Team Cloud (`OMB_CLOUD_ROLE=team`) with the Owner (Olive),
  an Admin (Ada) and four Users paired with the Admin's signed claims, and the synthetic Claude CLI. Payroll is shared
  with Bob to view, Cara to chat and Dan to edit; Eve is not added. As each of them it tries every route a member
  reaches: the bot list (each copy's `yourAccess`, the sharing only on an editor's), its chat, export, a room with it,
  sending, a new conversation, stopping, compacting, editing a line, answering a card, Undo, a reaction, Always allow,
  Set me up, the browser, the bot's look and profile, its instructions, apps and admin-only fields, its sharing, a new
  routine for it or its room, someone else's routine and one's own, a new room with it, writing in, renaming and
  stopping its room. Bob gets 403 on every write and nothing behind it changes; Cara chats and keeps her own routine;
  Dan changes instructions, apps and sharing but not the approval level, folder, computer, department, Chief, peers or
  visibility; Eve gets 404. A message another app relays (the guarded route's `onBehalfOf`) goes through only for
  someone who can chat. Bob's live stream gets his new level with no sharing in it, then ends when he is removed; the
  owner always edits, keeps editing after handing the bot on, and each person's own MausBot stays theirs. Bots made
  before levels keep exactly what their visibility gave. Asking to chat: someone who can't see the bot gets 404 and its
  owner 409; Bob's ask puts one card in Dan's inbox (the owner's, not an admin's), asking again adds none, Bob can't
  answer it, Not now leaves him at Can view, a new ask and Allow give him Can chat, a conversation of his own and a
  line in his inbox; and an Allow from someone who can no longer edit the bot is refused.
- `server/bot-access.test.ts` covers the level rules: the mapping from visibility and back, a member's level (owner,
  damaged sharing, `@domain` entries), each copy of a bot, what each route needs, each level's bot fields, a card that
  changes the bot, a relayed message, and who may be added.
- `server/host/access-requests.test.ts`: the admins decide when the owner is gone, one admin's Allow settles every
  copy, the owner alone decides while on the team, Not now gives nothing.
- `src/components/bot-access/AccessOverview.dom.test.ts`: Settings → Bot access lists each team bot (no one's own
  MausBot) with its owner, a plain summary and a stack of faces (+N past four); a row opens the Share dialog; the search
  takes a bot's name or owner; By person lists each User, and opening one gives their bots at the same level menus, with
  Remove only for their own access; the empty states; "Ask Cara to chat" asks and says so, "Ask an admin to chat" when
  nobody on the team owns the bot. `src/components/SettingsModal.groups.test.ts` and
  `src/components/SettingsModal.simple.test.ts` show the page to a team's admins only, as its own page in both modes.
- `src/components/bot-access/ShareBotDialog.dom.test.ts` drives the dialog: the owner first, each level on a real menu
  with its check, nothing below what everyone gets, a change sent at once with Undo putting it back, adding a teammate
  from the keyboard, removing one, general access and its level, Make owner behind a confirmation and only for whoever
  may hand the bot on, the read-only view of someone who can't edit, keys staying inside it over Settings, and no button
  off a team.

## The pictures

```sh
node --experimental-strip-types scripts/verify-team-bot-access.ts --shots <dir>
```

It starts the same kind of Team Cloud, sets Payroll up through the routes, and photographs the whole app
(`scripts/testing/team-access-preview.tsx`) in a headless Chrome with a throwaway profile, at 1280×800 at 2x, each page's
every request sent as that person through the preview's proxy. It fails if the app is refused anything naming a bot, a
room or a conversation while it is shown. The `-dark` pictures use the Midnight skin and the `-390` ones a 390×844
window; the many-people and many-bots ones add six people to Payroll and bring the team to fifty bots. `--before` takes the same setup through the older visibility route, for a
checkout of the code before levels.

| | Before | After |
|---|---|---|
| The Share dialog | ![](evidence/team-bot-access/before-look-share-dialog.png) | ![](evidence/team-bot-access/share-dialog-admin.png) |
| The Share dialog, dark | ![](evidence/team-bot-access/before-look-share-dialog-dark.png) | ![](evidence/team-bot-access/share-dialog-advanced-dark.png) |
| Someone who can only view | ![](evidence/team-bot-access/before-look-member-view.png) | ![](evidence/team-bot-access/member-view-bob-share.png) |
| Bot access in Settings | ![](evidence/team-bot-access/before-look-overview.png) | ![](evidence/team-bot-access/overview-admin.png) |
| Bot access in Settings, dark | ![](evidence/team-bot-access/before-look-overview-dark.png) | ![](evidence/team-bot-access/overview-admin-advanced-dark.png) |

| The Share dialog | |
|---|---|
| Dark, Simple | ![](evidence/team-bot-access/share-dialog-admin-dark.png) |
| A level's menu | ![](evidence/team-bot-access/share-dialog-level-menu.png) |
| A level's menu, dark | ![](evidence/team-bot-access/share-dialog-level-menu-dark.png) |
| The ⋯ menu | ![](evidence/team-bot-access/share-dialog-more-menu.png) |
| Make owner, confirming | ![](evidence/team-bot-access/share-dialog-make-owner.png) |
| Made owner, the one before still able to edit | ![](evidence/team-bot-access/share-dialog-made-owner.png) |
| Adding a teammate | ![](evidence/team-bot-access/share-dialog-add-person.png) |
| A change, with Undo | ![](evidence/team-bot-access/share-dialog-undo-toast.png) |
| Everyone in the team: the level at the row's end | ![](evidence/team-bot-access/overview-share-everyone.png) |
| Ten people: the list scrolls inside | ![](evidence/team-bot-access/share-dialog-many-people.png) |
| 390px | ![](evidence/team-bot-access/share-dialog-390.png) |
| 390px, a level's menu | ![](evidence/team-bot-access/share-dialog-level-menu-390.png) |
| 390px, ten people | ![](evidence/team-bot-access/share-dialog-many-people-390.png) |

| Bot access | |
|---|---|
| By person | ![](evidence/team-bot-access/overview-by-person.png) |
| By person, dark | ![](evidence/team-bot-access/overview-by-person-dark.png) |
| A person's bots, a level open | ![](evidence/team-bot-access/overview-person-bots.png) |
| A person's bots, dark | ![](evidence/team-bot-access/overview-person-bots-dark.png) |
| Fifty bots | ![](evidence/team-bot-access/overview-many-bots.png) |
| Searching, with ten people: +N past four | ![](evidence/team-bot-access/overview-search-many-people.png) |
| 390px, by bot | ![](evidence/team-bot-access/overview-admin-390.png) |
| 390px, by person | ![](evidence/team-bot-access/overview-by-person-390.png) |
| 390px, a person's bots | ![](evidence/team-bot-access/overview-person-bots-390.png) |
| 390px, fifty bots | ![](evidence/team-bot-access/overview-many-bots-390.png) |

| Each level | |
|---|---|
| Can view: the Share dialog | ![](evidence/team-bot-access/member-view-bob-share.png) |
| Can view: the Share dialog, dark | ![](evidence/team-bot-access/member-view-bob-share-dark.png) |
| Can view: the Share dialog, 390px | ![](evidence/team-bot-access/member-view-bob-share-390.png) |
| Can view | ![](evidence/team-bot-access/member-view-bob.png) |
| Can chat | ![](evidence/team-bot-access/member-chat-cara.png) |
| Can edit: the Share dialog | ![](evidence/team-bot-access/member-edit-dan-share.png) |
| No access: not in the list | ![](evidence/team-bot-access/member-none-eve.png) |
| Can view: ask the owner | ![](evidence/team-bot-access/ask-bob.png) |
| Asked | ![](evidence/team-bot-access/ask-bob-asked.png) |
| The card in the owner's inbox | ![](evidence/team-bot-access/ask-card-ada-inbox.png) |
| After Allow | ![](evidence/team-bot-access/ask-allowed-bob.png) |

## Not proven here

- No real Admin, phone, Slack worker or model was involved: the Admin's pairing is signed by the fixture, a relayed
  message is the guarded route called on loopback, and the engine is the synthetic CLI.
- A routine a member wrote keeps its schedule when their level drops; its runs are the bot's (team-cloud.md "What a bot
  keeps per bot").
- A reply to a line in a person's inbox goes back to the bot that asked even if they can only view it: the bot asked
  them.
