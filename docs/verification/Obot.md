# Obot, everyone's helper

Obot is the bot every place and every Team Cloud member gets once: a new
install's first bot and its Chief of Staff, or, for an install that already has
bots, a helper beside them. It is never deleted or archived; the person takes it
off the sidebar with "Show Obot in the sidebar" in Settings → General, which
its menu's **Hide from sidebar** also turns off.

## Automated checks

```sh
pnpm exec vitest run server/default-bot.test.ts server/default-bot.e2e.test.ts \
  server/team-setup-requests.test.ts src/lib/default-bot.test.ts src/components/ObotWelcome.test.ts \
  src/lib/obot-landing.test.ts
```

- `server/default-bot.test.ts`: a fresh install gets one Obot once; an
  existing install gets one once on update and its Chief is untouched; a new
  install's renamed Obot is adopted, not duplicated; the intro shows once,
  not after it was answered or dismissed; delete and archive are refused; a
  move to My Cloud and coming home leave exactly one; each Team Cloud member
  gets their own; a Team User's Obot holds no Chief tools.
- `server/default-bot.e2e.test.ts`: on a real fixture server, `DELETE
  /api/bots/:id` answers 409, the switch hides and shows it, and a Obot that
  is not the Chief creates a bot with `create_bot`.
- `server/obot-notifications.test.ts`, `server/drivers/agents-obot-tools.test.ts`
  and the second case of `server/default-bot.e2e.test.ts`: Obot alone gets
  `list_unread_notifications` and `mark_notifications_read`, listed last.
  The list returns the unread feed (bounded, trimmed) with a lean per item;
  marking read takes only finished work (`done`, `delegation-settled`), leaves
  questions, approvals, failures, deferred runs (`routine-deferred`, which the
  app routes as an ask), sign-ins, money, mentions and unrecognised kinds
  unread, has no mark-all, and says what it marked and what it left. A `done`
  item is the bot's final reply and may end in a question: the list's text says
  such an item is the person's, to be marked read only if they said so.
  Personal installs only (refused on any team server); no other bot may call
  them. The list is annotated read-only like the other reviewed reads.
  `server/drivers/agents-catalog-wire.test.ts` budgets the `+obot` profiles,
  each within 2% of the same Chief's list without them.
- `server/team-setup-requests.test.ts` ("Obot's Chief-level team setup"):
  it adds specialists like a Chief but never changes who the Chief is.
- `src/components/ObotWelcome.test.ts` and `src/lib/default-bot.test.ts`:
  the first-launch welcome shows once with its panel closed, Add pins it and Not
  now turns the switch off, a name, colour, look or uploaded picture is saved as
  the bot's own edit screen saves it, a renamed Obot is still found by its
  mark, and a new install's intro offers only the setup still to do.
- `src/lib/obot-landing.test.ts`: the rows already in the sidebar glide down
  by the new row's height, the avatar lands in the new slot and leaves nothing
  behind, reduced motion only fades the row in, and a hidden sidebar just adds it.
- `server/default-bot.test.ts` also: a place with no Chief gets Obot as its
  Chief; a place with a Chief keeps it. Either way the daily brief comes from
  Obot, hidden from the sidebar or not, and its intro says so. How the watch
  moves to Obot is in [Proactive routines and the brief](proactive-routines.md).

## By hand

Launch the app against an isolated fixture (`docs/verification/README.md`),
finish the first-run welcome and its tour, then:

1. The **Meet Obot** popup appears once, with Obot out of the sidebar
   while it is open. Its picture opens the customise panel (name first, then
   colour, look, **Upload a picture · Generate a picture with AI**); the title
   and the Add button follow the name. **Add** makes the sidebar rows glide down
   while the avatar travels into the new top slot and the row fades in; with
   reduced motion it only fades in. Reopen the app: it does not appear again.
2. Obot's first message says what it does in the app's language, with
   example asks and, on a new install, only the setup steps still to do. Each
   step opens the app's own flow.
3. Its sidebar menu offers **Hide from sidebar**, not Archive or Delete; the
   switch in Settings → General brings it back.

Evidence: [popup, light](evidence/obot/welcome-light.png),
[popup, dark](evidence/obot/welcome-dark.png),
[customise panel](evidence/obot/welcome-customize-light.png),
[uploaded picture](evidence/obot/welcome-upload-light.png),
[the fly-in](evidence/obot/fly-in.gif), [slowed](evidence/obot/fly-in-slow.gif),
[compact, icon rail and reduced motion](evidence/obot/fly-in-compact-rail-reduced.png),
[intro and setup](evidence/obot/added-light.png),
[menu](evidence/obot/menu-light.png),
[Settings, switched off](evidence/obot/settings-off.png),
[chrome picture, light](evidence/obot/chrome-picture-daylight.png),
[chrome picture, dark](evidence/obot/chrome-picture-midnight.png).

